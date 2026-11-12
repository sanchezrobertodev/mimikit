//! The agent bridge (Settings › AI). While it's on, Mimikit listens on 127.0.0.1 for the `mimikit mcp` relays
//! that agent apps start (mcp.rs) and hands each tool call to the window, where the tools run (src/agent). It writes its
//! port and a new random token to agent-bridge.json in the data folder, which only this user can read. A request must
//! carry that token, name 127.0.0.1 as its Host (a page that rebinds a name sends that name) and have no Origin
//! (browsers send one), so web pages can't use it.
//!
//! The framing is a minimal HTTP/1.1, one POST per call and then close, so a browser's request fails cleanly.

use std::collections::HashMap;
use std::io;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, oneshot};

use crate::err;

/// What the running app leaves in its data folder for the relay.
pub const FILE: &str = "agent-bridge.json";
/// How long a call may wait for the window: long enough for the user to answer "Allow …?".
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// The biggest answer the relay takes; the window keeps its answers well under this.
pub const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_HEAD: usize = 16 * 1024;
const MAX_REQUEST: usize = 256 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Calls served at once; more are told to wait.
const MAX_CALLS: usize = 16;

#[derive(Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// The listener while it's on, and the calls waiting for the window's answer.
#[derive(Default)]
pub struct Bridge {
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next: AtomicU64,
}

/// An error the agent can act on: a code to branch on, what happened and what to do (as in src/agent/run.ts).
pub fn error_text(code: &str, message: &str, hint: &str) -> String {
    format!("Error ({code}): {message}\nWhat to do: {hint}")
}

/// [`error_text`] as an MCP tool result.
fn error_result(code: &str, message: &str, hint: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": error_text(code, message, hint) }], "isError": true })
}

/// One HTTP message: its first line, its header lines and its body.
pub struct Message {
    pub head: Vec<String>,
    pub body: Vec<u8>,
}

impl Message {
    /// Every value of the header `name` (any case), trimmed.
    fn headers<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        self.head.iter().skip(1).filter_map(move |line| {
            let (k, v) = line.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

pub async fn read_message(s: &mut (impl AsyncRead + Unpin), max_body: usize) -> io::Result<Message> {
    let bad = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_string());
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return Err(bad("headers too long"));
        }
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(bad("closed before the headers ended"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end])
        .split("\r\n")
        .map(str::to_string)
        .collect();
    let mut msg = Message {
        head,
        body: buf.split_off(end + 4),
    };
    let len: usize = match msg.headers("content-length").next() {
        Some(v) => v.parse().map_err(|_| bad("bad Content-Length"))?,
        None => 0,
    };
    if len > max_body {
        return Err(bad("body too big"));
    }
    msg.body.truncate(len);
    let mut rest = vec![0; len - msg.body.len()];
    s.read_exact(&mut rest).await?;
    msg.body.extend_from_slice(&rest);
    Ok(msg)
}

/// Writes a request or a response: its first line, any extra header lines (each ending in \r\n) and a JSON body.
pub async fn write_message(s: &mut (impl AsyncWrite + Unpin), first: &str, extra: &str, body: &[u8]) -> io::Result<()> {
    let head = format!(
        "{first}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).await?;
    s.write_all(body).await?;
    s.flush().await
}

/// Equal strings, compared in time that doesn't depend on where they differ.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// The call in `req` when it's one from a relay: a POST to /call with the token, from no web page. Else the status
/// line to refuse it with.
fn check(req: &Message, port: u16, token: &str) -> Result<Value, &'static str> {
    if req.head[0] != "POST /call HTTP/1.1" {
        return Err("404 Not Found");
    }
    if !req.headers("host").eq([format!("127.0.0.1:{port}").as_str()]) || req.headers("origin").next().is_some() {
        return Err("403 Forbidden");
    }
    let auth: Vec<_> = req.headers("authorization").collect();
    if auth.len() != 1 || !same(auth[0], &format!("Bearer {token}")) {
        return Err("401 Unauthorized");
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(call) if call["tool"].is_string() => Ok(call),
        _ => Err("400 Bad Request"),
    }
}

/// Serves relays on `listener` until the task is dropped. Each call that passes [`check`] goes to `forward`, and its
/// answer (an MCP tool result) goes back.
pub async fn serve<F, Fut>(listener: TcpListener, token: String, forward: F)
where
    F: Fn(Value) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Value> + Send + 'static,
{
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return;
    };
    let token: Arc<str> = token.into();
    let calls = Arc::new(Semaphore::new(MAX_CALLS));
    loop {
        let mut stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("agent bridge: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let (token, forward, calls) = (token.clone(), forward.clone(), calls.clone());
        tokio::spawn(async move {
            let Ok(Ok(req)) = tokio::time::timeout(READ_TIMEOUT, read_message(&mut stream, MAX_REQUEST)).await else {
                return; // not a request: just close
            };
            let (status, answer) = match (check(&req, port, &token), calls.try_acquire()) {
                (Err(status), _) => {
                    eprintln!("agent bridge: refused a request ({status})");
                    let hint = "Try again. If it keeps failing, ask the user to turn AI agents off and on in Mimikit's Settings.";
                    (
                        status,
                        error_result("refused", "Mimikit refused this connection.", hint),
                    )
                }
                (Ok(_), Err(_)) => (
                    "503 Service Unavailable",
                    error_result(
                        "busy",
                        "Mimikit is busy with other calls.",
                        "Wait a moment, then try again.",
                    ),
                ),
                (Ok(call), Ok(_permit)) => ("200 OK", forward(call).await),
            };
            let _ = write_message(
                &mut stream,
                &format!("HTTP/1.1 {status}"),
                "",
                answer.to_string().as_bytes(),
            )
            .await;
        });
    }
}

/// Hands a call to the window (event `agent-call`) and waits for its `agent_reply`.
async fn to_window(app: AppHandle, call: Value) -> Value {
    let bridge = app.state::<Bridge>();
    let id = bridge.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    let answer = match app.emit("agent-call", json!({ "id": id, "call": call })) {
        Ok(()) => tokio::time::timeout(CALL_TIMEOUT, rx).await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    bridge.pending.lock().unwrap().remove(&id);
    answer.unwrap_or_else(|| {
        let hint = "Check that Mimikit's window is open, then try again.";
        error_result("timeout", "Mimikit's window didn't answer in time.", hint)
    })
}

/// 128 random bits as hex.
fn new_token() -> Result<String, getrandom::Error> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Writes `text` to `path`, readable by this user only on macOS and Linux. On Windows the profile folder it's in
/// already keeps other users out.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    io::Write::write_all(&mut o.open(path)?, text.as_bytes())
}

/// Turns the agent bridge on (a new port and token each time it starts) or off. Returns this program's path, for the
/// setup commands Settings shows.
#[tauri::command]
pub fn set_agent_bridge(app: AppHandle, state: State<'_, Bridge>, on: bool) -> Result<String, String> {
    let file = app.path().app_data_dir().map_err(err)?.join(FILE);
    let mut server = state.server.lock().unwrap();
    if !on {
        if let Some(task) = server.take() {
            task.abort();
        }
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(err(e)),
            _ => {}
        }
    } else if server.is_none() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(err)?;
        listener.set_nonblocking(true).map_err(err)?;
        let port = listener.local_addr().map_err(err)?.port();
        let token = new_token().map_err(err)?;
        write_private(&file, &json!({ "port": port, "token": token }).to_string()).map_err(err)?;
        let app = app.clone();
        *server = Some(tauri::async_runtime::spawn(async move {
            match TcpListener::from_std(listener) {
                Ok(listener) => serve(listener, token, move |call| to_window(app.clone(), call)).await,
                Err(e) => eprintln!("agent bridge: {e}"),
            }
        }));
    }
    // An AppImage runs from a new mount each time: the path that lasts is the AppImage's own.
    let exe = std::env::var_os("APPIMAGE")
        .map(std::path::PathBuf::from)
        .map_or_else(std::env::current_exe, Ok);
    exe.map(|p| p.display().to_string()).map_err(err)
}

/// The window's answer to call `id`.
#[tauri::command]
pub fn agent_reply(state: State<'_, Bridge>, id: u64, result: Value) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

/// The relays among `pids` that are still running. Each call is its own connection, so this is how the window learns
/// that an agent app has closed.
#[tauri::command]
pub fn relays_alive(pids: Vec<u32>) -> Vec<u32> {
    pids.into_iter().filter(|&pid| running(pid)).collect()
}

#[cfg(windows)]
fn running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // A relay an elevated app started can't be opened, but it's there.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0;
        let alive = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(h);
        alive
    }
}

#[cfg(unix)]
fn running(pid: u32) -> bool {
    // 0 and ids past i32 would name process groups to kill().
    let Ok(pid) = i32::try_from(pid) else { return false };
    // SAFETY: signal 0 only checks the process exists. EPERM: it does, as another user's.
    pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

/// Runs `f` to the end on a runtime of its own (the tests have no tokio macros).
#[cfg(test)]
pub fn block_on<F: Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends `head` (the request line and headers, each ending in \r\n, `{port}` filled in) and a call to a bridge
    /// whose token is "secret". Returns the answer's status line and body.
    fn ask(head: &str) -> (String, Value) {
        block_on(async {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(serve(listener, "secret".into(), |call: Value| async move {
                json!({ "content": [{ "type": "text", "text": format!("ran {}", call["tool"]) }] })
            }));
            let mut s = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            let body = br#"{"tool":"overview","args":{}}"#;
            let head = head.replace("{port}", &port.to_string());
            s.write_all(format!("{head}Content-Length: {}\r\n\r\n", body.len()).as_bytes())
                .await
                .unwrap();
            s.write_all(body).await.unwrap();
            let answer = read_message(&mut s, MAX_RESPONSE).await.unwrap();
            (answer.head[0].clone(), serde_json::from_slice(&answer.body).unwrap())
        })
    }

    const RELAY: &str = "POST /call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer secret\r\n";

    #[test]
    fn runs_a_relays_call() {
        let (status, body) = ask(RELAY);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert_eq!(body["content"][0]["text"], r#"ran "overview""#);
    }

    #[test]
    fn refuses_a_bad_token() {
        for head in [
            "POST /call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer guess\r\n",
            "POST /call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer secre\r\n",
            "POST /call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n",
        ] {
            let (status, body) = ask(head);
            assert_eq!(status, "HTTP/1.1 401 Unauthorized", "{head}");
            assert_eq!(body["isError"], true);
            assert!(
                body["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .starts_with("Error (refused)")
            );
        }
    }

    #[test]
    fn refuses_web_pages() {
        // A page's fetch carries an Origin; a page that rebinds its own name to 127.0.0.1 sends that name as Host.
        for head in [
            &format!("{RELAY}Origin: https://example.com\r\n"),
            &format!("{RELAY}Origin: null\r\n"),
            "POST /call HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer secret\r\n",
            "POST /call HTTP/1.1\r\nHost: evil.example:{port}\r\nAuthorization: Bearer secret\r\n",
            "POST /call HTTP/1.1\r\nAuthorization: Bearer secret\r\n",
        ] {
            let (status, _) = ask(head);
            assert_eq!(status, "HTTP/1.1 403 Forbidden", "{head}");
        }
        let (status, _) = ask("GET /call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer secret\r\n");
        assert_eq!(status, "HTTP/1.1 404 Not Found");
    }

    #[test]
    fn tells_running_relays_from_exited_ones() {
        // A process that has exited: this test program, only listing its tests.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let gone = child.id();
        child.wait().unwrap();
        drop(child);
        let me = std::process::id();
        assert_eq!(relays_alive(vec![me, gone, 0, u32::MAX]), vec![me]);
    }
}

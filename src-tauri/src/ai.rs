//! Built-in AI features on the user's own Anthropic API key: "Ask" in the search box, and "Suggest tags" (tagging.rs). The key
//! lives in the OS credential store under the app's identifier. It never goes to the window, the database, the prefs or
//! a log; only to api.anthropic.com, from here.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::AppHandle;

const API: &str = "https://api.anthropic.com/v1";
const API_VERSION: &str = "2026-10-21";
const KEY_USER: &str = "anthropic-api-key";
const ASK_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_WORDS: usize = 500;
const MAX_PROMPT: usize = 64 * 1024;

// The window translates these by their English text (src/locales/en/errors.json), so keep the two the same.
pub const NO_KEY: &str = "No Anthropic API key is set. Add one in Settings.";
const BAD_KEY_FORMAT: &str = "That doesn't look like an API key.";
const BAD_KEY: &str = "Anthropic didn't accept your API key. Check it in Settings.";
const BILLING: &str = "Anthropic refused the request: check the billing of your API account.";
const RATE_LIMITED: &str = "Too many requests to Anthropic. Wait a moment and try again.";
const BUSY: &str = "Anthropic is busy right now. Try again in a moment.";
pub(crate) const OFFLINE: &str = "Couldn't reach Anthropic. Check your internet connection and try again.";
const DECLINED: &str = "Claude declined to answer. Try other words.";
const NO_ANSWER: &str = "Claude's answer was cut short or unreadable. Try again.";
const TOO_LONG: &str = "Ask takes up to 500 characters.";

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, KEY_USER).map_err(store_err)
}

fn store_err(e: keyring::Error) -> String {
    format!("Couldn't use the system's credential store: {e}")
}

fn key(app: &AppHandle) -> Result<String, String> {
    match entry(app)?.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => Err(NO_KEY.into()),
        Err(e) => Err(store_err(e)),
    }
}

/// Whether a key is stored. The key itself never leaves the backend.
#[tauri::command(async)]
pub fn api_key_status(app: AppHandle) -> Result<bool, String> {
    match key(&app) {
        Ok(_) => Ok(true),
        Err(e) if e == NO_KEY => Ok(false),
        Err(e) => Err(e),
    }
}

#[tauri::command(async)]
pub fn set_api_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 256 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(BAD_KEY_FORMAT.into());
    }
    entry(&app)?.set_password(key).map_err(store_err)?;
    // Batches waiting for a key are collected now.
    crate::tagging::wake();
    Ok(())
}

#[tauri::command(async)]
pub fn remove_api_key(app: AppHandle) -> Result<(), String> {
    match entry(&app)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(store_err(e)),
    }
}

/// The models Settings › AI offers (AI_MODELS in src/lib/prefs.ts). Any other value is refused when a command's
/// arguments are read, so the window can't use a model or effort the setting doesn't show.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum Model {
    #[serde(rename = "claude-haiku-5-5")]
    Haiku,
    #[serde(rename = "claude-sonnet-5-5")]
    Sonnet,
    #[serde(rename = "claude-opus-5-5")]
    Opus,
}

impl Model {
    pub fn id(self) -> &'static str {
        match self {
            Model::Haiku => "claude-haiku-5-5",
            Model::Sonnet => "claude-sonnet-5-5",
            Model::Opus => "claude-opus-5-5",
        }
    }
}

/// How much the model thinks before answering (AI_EFFORTS in src/lib/prefs.ts).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AskReply {
    query: String,
    input_tokens: u64,
    output_tokens: u64,
}

/// Turns plain words into a search with one small call. `prompt` is the search language and tag names the window
/// builds (src/lib/ask.ts); the reply is checked there before it runs.
#[tauri::command]
pub async fn ask_search(
    app: AppHandle,
    prompt: String,
    words: String,
    model: Model,
    effort: Effort,
) -> Result<AskReply, String> {
    let words = words.trim().to_string();
    if words.is_empty() || words.chars().count() > MAX_WORDS || prompt.len() > MAX_PROMPT {
        return Err(TOO_LONG.into());
    }
    let key = stored_key(&app).await?;
    parse_ask(
        &post(
            &key,
            "/messages",
            &ask_body(&prompt, &words, model, effort),
            ASK_TIMEOUT,
        )
        .await?,
    )
}

/// The stored key, for a call from here or tagging.rs.
pub(crate) async fn stored_key(app: &AppHandle) -> Result<String, String> {
    // The credential store can block (Secret Service is a D-Bus call), so not on the async runtime.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || key(&app))
        .await
        .map_err(crate::err)?
}

fn ask_body(prompt: &str, words: &str, model: Model, effort: Effort) -> Value {
    json!({
        "model": model,
        // Room for thinking at high effort before the short answer; Haiku at low writes about 20 tokens.
        "max_tokens": 4096,
        "output_config": {
            "effort": effort,
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"],
                    "additionalProperties": false,
                },
            },
        },
        "system": prompt,
        "messages": [{ "role": "user", "content": words }],
    })
}

fn parse_ask(reply: &Value) -> Result<AskReply, String> {
    if reply["stop_reason"] == "refusal" {
        return Err(DECLINED.into());
    }
    // Thinking blocks may come first: read the answer by type.
    let text = reply["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["type"] == "text");
    let query = text
        .and_then(|b| serde_json::from_str::<Value>(b["text"].as_str()?).ok())
        .and_then(|v| Some(v["query"].as_str()?.trim().to_string()))
        .ok_or(NO_ANSWER)?;
    let usage = &reply["usage"];
    Ok(AskReply {
        query,
        input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
    })
}

/// POSTs JSON and returns the JSON reply, or the error to show for it.
pub(crate) async fn post(key: &str, path: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let (status, bytes) = call(key, reqwest::Method::POST, path, Some(body), timeout).await?;
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        Ok(json)
    } else {
        Err(api_error(status, &json))
    }
}

/// One request to the API: the status and body, whatever the status. Errs only when Anthropic can't be reached.
pub(crate) async fn call(
    key: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<(u16, Vec<u8>), String> {
    // reqwest is built without a default crypto provider. Something else in the app may have installed one already:
    // then this does nothing. Without it, the first request (Suggest tags' collector, at launch) panics.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut req = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(crate::err)?
        .request(method, format!("{API}{path}"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION);
    if let Some(body) = body {
        req = req.json(body);
    }
    let res = req.send().await.map_err(|_| OFFLINE.to_string())?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|_| OFFLINE.to_string())?;
    Ok((status, bytes.to_vec()))
}

pub(crate) fn api_error(status: u16, body: &Value) -> String {
    match status {
        401 | 403 => BAD_KEY.into(),
        402 => BILLING.into(),
        429 => RATE_LIMITED.into(),
        500.. => BUSY.into(),
        _ => {
            let msg = body["error"]["message"]
                .as_str()
                .map_or_else(|| format!("HTTP {status}"), str::to_string);
            format!("Anthropic returned an error: {msg}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_body_is_small_and_structured() {
        let b = ask_body("grammar", "dark forest ambience", Model::Haiku, Effort::Low);
        assert_eq!(b["model"], "claude-haiku-5-5");
        assert_eq!(b["output_config"]["effort"], "low");
        let opus = ask_body("grammar", "x", Model::Opus, Effort::High);
        assert_eq!(
            (opus["model"].as_str(), opus["output_config"]["effort"].as_str()),
            (Some("claude-opus-5-5"), Some("high"))
        );
        // Only what Settings offers gets through from the window.
        assert_eq!(
            serde_json::from_value::<Model>(json!("claude-sonnet-5-5")).unwrap(),
            Model::Sonnet
        );
        assert!(serde_json::from_value::<Model>(json!("claude-fable-5-1")).is_err());
        assert!(serde_json::from_value::<Effort>(json!("max")).is_err());
        assert_eq!(b["output_config"]["format"]["schema"]["required"], json!(["query"]));
        assert_eq!(b["messages"][0]["content"], "dark forest ambience");
        // Haiku 5.5 refuses sampling parameters and prefills.
        assert!(b.get("temperature").is_none());
        assert_eq!(b["messages"].as_array().unwrap().last().unwrap()["role"], "user");
    }

    #[test]
    fn reads_the_answer_after_thinking() {
        let reply = json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "thinking", "thinking": "", "signature": "x" }, { "type": "text", "text": "{\"query\":\" type:audio dur:>1m \"}" }],
            "usage": { "input_tokens": 900, "output_tokens": 30 },
        });
        assert_eq!(
            parse_ask(&reply),
            Ok(AskReply {
                query: "type:audio dur:>1m".into(),
                input_tokens: 900,
                output_tokens: 30
            })
        );
        assert_eq!(
            parse_ask(&json!({ "stop_reason": "refusal", "content": [] })),
            Err(DECLINED.into())
        );
        let cut =
            json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{\"query\":\"type:au" }] });
        assert_eq!(parse_ask(&cut), Err(NO_ANSWER.into()));
    }

    #[test]
    fn errors_say_what_to_do() {
        assert_eq!(api_error(401, &Value::Null), BAD_KEY);
        assert_eq!(api_error(429, &Value::Null), RATE_LIMITED);
        assert_eq!(api_error(529, &Value::Null), BUSY);
        let low = json!({ "type": "error", "error": { "type": "invalid_request_error", "message": "Your credit balance is too low." } });
        assert_eq!(
            api_error(400, &low),
            "Anthropic returned an error: Your credit balance is too low."
        );
        assert_eq!(api_error(404, &Value::Null), "Anthropic returned an error: HTTP 404");
    }
}

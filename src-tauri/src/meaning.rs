//! Search by meaning: SigLIP 2 B/32 turns each image, and the words of a search, into vectors whose closeness follows
//! what they show, so "red potion icon" finds red potion icons whatever their names or tags. Models, videos and fonts
//! are indexed from the previews the window draws of them. Both run on this computer
//! with ONNX Runtime, downloaded with the model once the user turns the feature on and confirms the sizes. After that,
//! nothing here goes online. Source files are only read.
//!
//! The vectors live in `meaning.db` in the data folder, attached to the library's connection: not in the cache, so
//! clearing thumbnails doesn't cost hours of indexing, and not in backups (`VACUUM INTO` copies only `main`).

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use image::{Rgba, RgbaImage, imageops::FilterType};
use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::analysis::{self, Pass, Todo};
use crate::db::abs_path;
use crate::{AppState, err, kind, thumbs};

/// The model's id, stored with each vector: another model's vectors are stale.
pub const MODEL: &str = "siglip2-b32-256";
const DIMS: usize = 768;
/// Pictures are fitted into a square this many pixels wide.
const SIZE: usize = 256;
/// Words go in as this many tokens: SigLIP 2 was trained on text padded to 64.
const TOKENS: usize = 64;
const PAD: i64 = 0;
const EOS: i64 = 1;
const UNK: u32 = 3;
/// Images per model run.
const BATCH: usize = 16;
/// Images per stored transaction and progress update.
const STORE: usize = 256;
/// The words' model takes about 720 MB, so it's dropped after this long without a search.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Search words past this are ignored: the model only reads 63 tokens.
const MAX_WORDS: usize = 500;

// The window translates these by their English text (src/locales/en/errors.json), so keep the two the same.
pub const NOT_ON: &str = "Search by meaning isn't on. Turn it on in Settings › Library.";
const UNSUPPORTED: &str = "Search by meaning isn't available on this computer yet.";
const OFFLINE: &str =
    "Couldn't download the files for search by meaning. Check your internet connection and try again.";
const DAMAGED: &str = "A file downloaded for search by meaning was damaged, so it was deleted. Try again.";
const VC_RUNTIME: &str = "Search by meaning needs Microsoft's Visual C++ runtime. Install it, then try again.";
const NOT_INDEXED: &str = "This asset isn't indexed for search by meaning yet.";
/// The same text as thumbs.rs's.
const UNREADABLE: &str = "Mimikit couldn't read this image.";
/// A model, video or font whose preview the window couldn't draw.
const UNDRAWN: &str = "Mimikit couldn't draw a preview of this asset.";

/// A file to download: where from, and what it must be.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct File {
    name: &'static str,
    #[serde(skip)]
    url: &'static str,
    #[serde(skip)]
    sha256: &'static str,
    size: u64,
    /// For the consent dialog: "huggingface" or "github".
    source: &'static str,
}

// Commit-pinned: the same bytes for every download.
const VISION: File = File {
    name: "vision_model_fp16.onnx",
    url: "https://huggingface.co/onnx-community/siglip2-base-patch32-256-ONNX/resolve/7efccb86b5b6601bfe9e14326e1c11b40b68d44c/onnx/vision_model_fp16.onnx",
    sha256: "44fcd984cf4ac4baba5b4776192c0b141a120c6981df49732c681d4fe8ddc718",
    size: 189_374_263,
    source: "huggingface",
};
const TEXT: File = File {
    name: "text_model_fp16.onnx",
    url: "https://huggingface.co/onnx-community/siglip2-base-patch32-256-ONNX/resolve/7efccb86b5b6601bfe9e14326e1c11b40b68d44c/onnx/text_model_fp16.onnx",
    sha256: "3f8149272095410332433ca84f2c99611ed4679429eff43fbf3983ea15664ef3",
    size: 564_862_230,
    source: "huggingface",
};
const TOKENIZER: File = File {
    name: "tokenizer.json",
    url: "https://huggingface.co/onnx-community/siglip2-base-patch32-256-ONNX/resolve/7efccb86b5b6601bfe9e14326e1c11b40b68d44c/tokenizer.json",
    sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
    size: 34_363_039,
    source: "huggingface",
};

/// ONNX Runtime 1.31.1's CPU library, taken from Microsoft's official archive for this platform by
/// `scripts/onnxruntime.mjs` and published on Mimikit's own release `onnxruntime-1.31.1`. Microsoft ships no Intel Mac
/// build, so there is none for it.
#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME: Option<File> = Some(File {
    name: "onnxruntime.dll",
    url: "https://github.com/sanchezrobertodev/mimikit/releases/download/onnxruntime-1.31.1/onnxruntime-1.31.1-win-x64.dll",
    sha256: "cb2fa518b18356617f6f9f460c012501da2819ec7e5c1d80bd8f5de20492db0c",
    size: 17_253_728,
    source: "github",
});
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME: Option<File> = Some(File {
    name: "libonnxruntime.dylib",
    url: "https://github.com/sanchezrobertodev/mimikit/releases/download/onnxruntime-1.31.1/libonnxruntime-1.31.1-osx-arm64.dylib",
    sha256: "17500d6b1e37e70f43a2c57d94233a1bc29fbcb297be0a5f8c7c13184f3307ba",
    size: 44_797_256,
    source: "github",
});
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const RUNTIME: Option<File> = Some(File {
    name: "libonnxruntime.so",
    url: "https://github.com/sanchezrobertodev/mimikit/releases/download/onnxruntime-1.31.1/libonnxruntime-1.31.1-linux-x64.so",
    sha256: "a96f132e5eb5ca04e23a7d2fc1078fb95aa591e8d71d0f237702ece3a1e0f4ea",
    size: 29_345_384,
    source: "github",
});
#[cfg(not(any(
    all(windows, target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const RUNTIME: Option<File> = None;

/// ONNX Runtime's Windows library needs the Visual C++ 2015-2022 runtime, which Windows doesn't always have (Mimikit
/// itself links it statically). Checked before the download, and before loading, for a clear message instead of a
/// failed load.
#[cfg(windows)]
fn vc_runtime() -> bool {
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
    [
        "msvcp140.dll",
        "msvcp140_1.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
    ]
    .iter()
    .all(|name| {
        let name: Vec<u16> = name.encode_utf16().chain([0]).collect();
        // Only System32, where the runtime installs: never a DLL from the current or app folder.
        let module = unsafe { LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
        !module.is_null() && unsafe { FreeLibrary(module) } != 0
    })
}

#[cfg(not(windows))]
fn vc_runtime() -> bool {
    true
}

/// What the download fetches; nothing where search by meaning isn't available.
fn files() -> Vec<File> {
    RUNTIME.map_or(vec![], |rt| vec![VISION, TEXT, TOKENIZER, rt])
}

/// Where the files go: `models/<model id>/` in the data folder.
fn model_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models").join(MODEL)
}

/// In `models/` when a delete couldn't remove everything (a loaded runtime library can't be deleted on Windows): the
/// rest goes at the next launch, before anything loads it.
const DELETE: &str = "delete";

fn installed(dir: &Path) -> bool {
    let files = files();
    !files.is_empty()
        && files
            .iter()
            .all(|f| std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

const SETTING: &str = "meaning_model";

/// Turned on for this model: `settings` holds its id. In the library, not the UI's prefs, because the launch scans
/// need it before the window loads.
pub fn on(conn: &Connection) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [SETTING], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .as_deref()
        == Some(MODEL)
}

/// One vector per version (size, mtime) of an asset, for one model: int8 × [`DIMS`], then the f32 scale. Empty when
/// it couldn't be read or drawn, so it isn't retried until it changes. A foreign key can't reach across files, so a
/// TEMP trigger (one may touch any attached database) deletes a deleted asset's vector at once, also for a removed
/// folder's assets: asset ids get reused, and a new image with the same id, size and mtime must not inherit it.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meaning.vectors (
  asset_id INTEGER PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE TEMP TRIGGER IF NOT EXISTS meaning_forget AFTER DELETE ON assets BEGIN
  DELETE FROM meaning.vectors WHERE asset_id = old.id;
END;
";

/// Attaches `meaning.db` to the library's connection. After a backup restore the library's ids may point at other
/// files, so it starts over. A deleted model's leftovers go now, before anything loads them.
pub fn open(conn: &Connection, data_dir: &Path, restored: bool) -> rusqlite::Result<()> {
    let db = data_dir.join("meaning.db");
    if restored {
        for p in [db.clone(), data_dir.join("meaning.db-journal")] {
            let _ = std::fs::remove_file(p);
        }
    }
    let models = data_dir.join("models");
    if models.join(DELETE).exists() {
        let _ = std::fs::remove_dir_all(&models);
    }
    conn.execute("ATTACH DATABASE ?1 AS meaning", [db.to_string_lossy()])?;
    conn.execute_batch(SCHEMA)
}

/// What gets a vector: images the backend decodes (the same set as image analysis), and models, videos and fonts from
/// their [`preview`].
fn indexed() -> String {
    format!(
        "((a.kind = 'image' AND a.ext IN ({})) OR a.kind IN ('model', 'video', 'font'))",
        kind::decodable_sql()
    )
}

/// The picture a model, video or font is indexed from: the thumbnail the window renders (a model's three-quarter view,
/// a video's frame about 10% in), or the sample line it draws of a font, as for Suggest tags. Named after the file's
/// version, so a changed file gets a new picture and then a new vector. None for an image, read from its own file.
fn preview(thumbs_dir: &Path, t: &Todo) -> Option<PathBuf> {
    let path = t.path.display().to_string();
    match kind::kind_of(&t.ext) {
        "model" | "video" => Some(thumbs_dir.join(thumbs::cache_name(&path, t.size, t.mtime))),
        "font" => Some(thumbs_dir.join(thumbs::sample_name(&path, t.size, t.mtime))),
        _ => None,
    }
}

/// Assets without an up-to-date vector from this model.
pub fn stale(conn: &Connection) -> rusqlite::Result<Vec<Todo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT a.id, r.path, a.rel_path, a.ext, a.size, a.mtime FROM assets a JOIN roots r ON r.id = a.root_id
         LEFT JOIN meaning.vectors v ON v.asset_id = a.id
         WHERE {}
           AND (v.asset_id IS NULL OR v.size != a.size OR v.mtime != a.mtime OR v.model != ?1)",
        indexed()
    ))?;
    stmt.query_map([MODEL], |r| {
        let root: String = r.get(1)?;
        let rel: String = r.get(2)?;
        Ok(Todo {
            id: r.get(0)?,
            path: abs_path(&root, &rel),
            root: root.into(),
            ext: r.get(3)?,
            size: r.get(4)?,
            mtime: r.get(5)?,
        })
    })?
    .collect()
}

/// The stale assets among `ids` (assets that just changed).
fn todo(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<Todo>> {
    let ids: HashSet<i64> = ids.iter().copied().collect();
    Ok(stale(conn)?.into_iter().filter(|t| ids.contains(&t.id)).collect())
}

/// Assets indexed (including ones that couldn't be read or drawn), and assets that can be.
pub fn counts(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    conn.query_row(
        &format!(
            "SELECT count(v.asset_id), count(*) FROM assets a
             LEFT JOIN meaning.vectors v ON v.asset_id = a.id AND v.size = a.size AND v.mtime = a.mtime AND v.model = ?1
             WHERE {}",
            indexed()
        ),
        [MODEL],
        |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as usize)),
    )
}

fn prune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM meaning.vectors WHERE asset_id NOT IN (SELECT id FROM assets)",
        [],
    )
    .map(|_| ())
}

/// Stores vectors for the file versions they were computed from: skipped when the asset is gone or has changed
/// since, or when search by meaning was turned off meanwhile.
fn store(conn: &Connection, rows: &[Row]) -> rusqlite::Result<()> {
    if !on(conn) {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "INSERT INTO meaning.vectors (asset_id, size, mtime, model, vec)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?1 AND size = ?2 AND mtime = ?3)
         ON CONFLICT (asset_id) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime, model = excluded.model, vec = excluded.vec",
    )?;
    for (id, size, mtime, vec) in rows {
        stmt.execute(params![id, size, mtime, MODEL, vec])?;
    }
    Ok(())
}

/// A unit vector as int8 with one scale: [`DIMS`] bytes, then the scale as little-endian f32. Rankings stay the same
/// as with f32 (measured in phase 0: the top 50 of 100,000 identical) at a quarter of the memory.
fn quantize(v: &[f32]) -> Vec<u8> {
    let max = v.iter().fold(0f32, |m, x| m.max(x.abs()));
    let scale = if max > 0.0 { max / 127.0 } else { 1.0 };
    let mut out: Vec<u8> = v.iter().map(|x| (x / scale).round() as i8 as u8).collect();
    out.extend_from_slice(&scale.to_le_bytes());
    out
}

fn unit(v: &[f32]) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter().map(|x| x / n).collect()
}

/// Every indexed asset's vector, for searching.
struct Index {
    ids: Vec<i64>,
    vecs: Vec<i8>,
    scales: Vec<f32>,
}

impl Index {
    fn load(conn: &Connection) -> rusqlite::Result<Index> {
        let mut stmt = conn.prepare(
            "SELECT v.asset_id, v.vec FROM meaning.vectors v
             JOIN assets a ON a.id = v.asset_id AND a.size = v.size AND a.mtime = v.mtime
             WHERE v.model = ?1 AND length(v.vec) = ?2",
        )?;
        let mut index = Index {
            ids: vec![],
            vecs: vec![],
            scales: vec![],
        };
        let mut rows = stmt.query(params![MODEL, (DIMS + 4) as i64])?;
        while let Some(r) = rows.next()? {
            let blob = r.get_ref(1)?.as_blob()?;
            index.ids.push(r.get(0)?);
            index.vecs.extend(blob[..DIMS].iter().map(|&b| b as i8));
            index.scales.push(f32::from_le_bytes(blob[DIMS..].try_into().unwrap()));
        }
        Ok(index)
    }

    /// The cosine of every asset but `skip` with `q` (a unit vector), as (id i32, score f32) little-endian pairs: the
    /// window ranks within whatever else is applied.
    fn scores(&self, q: &[f32], skip: Option<i64>) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.ids.len() * 8);
        for ((id, v), scale) in self.ids.iter().zip(self.vecs.chunks(DIMS)).zip(&self.scales) {
            if skip == Some(*id) {
                continue;
            }
            let dot: f32 = v.iter().zip(q).map(|(&a, &b)| a as f32 * b).sum();
            out.extend_from_slice(&(*id as i32).to_le_bytes());
            out.extend_from_slice(&(dot * scale).to_le_bytes());
        }
        out
    }
}

/// Loaded on the first search. Reloaded after a batch is stored (`DIRTY`): about 100 ms at 100,000 images.
static INDEX: Mutex<Option<Index>> = Mutex::new(None);
static DIRTY: AtomicBool = AtomicBool::new(false);

/// [`Index::scores`] against the index, loaded first if it isn't or has grown.
fn score_all(db: &Mutex<Connection>, q: &[f32], skip: Option<i64>) -> Result<Vec<u8>, String> {
    // INDEX before the db lock, never the other way round.
    let mut index = INDEX.lock().unwrap();
    if index.is_none() || DIRTY.swap(false, SeqCst) {
        *index = Some(Index::load(&db.lock().unwrap()).map_err(err)?);
    }
    Ok(index.as_ref().unwrap().scores(q, skip))
}

/// Find related's query: the vector of `id`'s current version. The errors say why it has none.
fn related_query(conn: &Connection, id: i64) -> Result<Vec<f32>, String> {
    if !on(conn) {
        return Err(NOT_ON.into());
    }
    let row: Option<(Vec<u8>, String)> = conn
        .query_row(
            "SELECT v.vec, a.kind FROM meaning.vectors v JOIN assets a ON a.id = v.asset_id AND a.size = v.size AND a.mtime = v.mtime
             WHERE v.asset_id = ?1 AND v.model = ?2",
            params![id, MODEL],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    match row {
        None => Err(NOT_INDEXED.into()),
        Some((b, kind)) if b.len() != DIMS + 4 => Err(if kind == "image" { UNREADABLE } else { UNDRAWN }.into()),
        Some((b, _)) => {
            let scale = f32::from_le_bytes(b[DIMS..].try_into().unwrap());
            let v: Vec<f32> = b[..DIMS].iter().map(|&x| x as i8 as f32 * scale).collect();
            Ok(unit(&v))
        }
    }
}

/// The model's input for one picture: the whole picture fitted into the square (a wide sprite sheet is seen whole),
/// transparency on mid-grey, and small pixel art (64 px or less) enlarged with sharp edges. Channels first, -1 to 1.
pub fn prepare(img: &RgbaImage) -> Vec<f32> {
    const GREY: u32 = 128;
    let plane = SIZE * SIZE;
    let mut out = vec![GREY as f32 / 127.5 - 1.0; 3 * plane];
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return out;
    }
    let flat = RgbaImage::from_fn(w, h, |x, y| {
        let [r, g, b, a] = img.get_pixel(x, y).0;
        let on_grey = |c: u8| ((c as u32 * a as u32 + GREY * (255 - a as u32) + 127) / 255) as u8;
        Rgba([on_grey(r), on_grey(g), on_grey(b), 255])
    });
    let k = SIZE as f32 / w.max(h) as f32;
    let fit = |n: u32| ((n as f32 * k).round() as u32).clamp(1, SIZE as u32);
    let filter = if w.max(h) <= 64 {
        FilterType::Nearest
    } else {
        FilterType::Triangle
    };
    let fitted = image::imageops::resize(&flat, fit(w), fit(h), filter);
    let (ox, oy) = ((SIZE as u32 - fitted.width()) / 2, (SIZE as u32 - fitted.height()) / 2);
    for (x, y, p) in fitted.enumerate_pixels() {
        let i = ((y + oy) as usize) * SIZE + (x + ox) as usize;
        for (c, &v) in p.0[..3].iter().enumerate() {
            out[c * plane + i] = v as f32 / 127.5 - 1.0;
        }
    }
    out
}

/// SigLIP 2's tokenizer (Gemma's BPE), read from the model's `tokenizer.json`: spaces become ▁, characters missing from
/// the vocabulary fall back to their bytes, and merges apply lowest rank first across the whole text.
pub struct Tokenizer {
    vocab: HashMap<String, u32>,
    /// (left, right) → (rank, merged).
    merges: HashMap<(u32, u32), (u32, u32)>,
    /// `<0x00>`…`<0xFF>`.
    bytes: Vec<Option<u32>>,
}

#[derive(Deserialize)]
struct TokenizerJson {
    model: Bpe,
}

#[derive(Deserialize)]
struct Bpe {
    vocab: HashMap<String, u32>,
    merges: Vec<(String, String)>,
}

impl Tokenizer {
    pub fn parse(json: &[u8]) -> Result<Tokenizer, String> {
        let Bpe { vocab, merges } = serde_json::from_slice::<TokenizerJson>(json).map_err(err)?.model;
        let mut merged = HashMap::with_capacity(merges.len());
        for (rank, (a, b)) in merges.iter().enumerate() {
            if let (Some(&x), Some(&y), Some(&m)) = (vocab.get(a), vocab.get(b), vocab.get(&format!("{a}{b}"))) {
                merged.insert((x, y), (rank as u32, m));
            }
        }
        let bytes = (0..=255u8)
            .map(|b| vocab.get(&format!("<0x{b:02X}>")).copied())
            .collect();
        Ok(Tokenizer {
            vocab,
            merges: merged,
            bytes,
        })
    }

    /// The model's input for some words: lowercased (as SigLIP 2 was trained), tokens, `<eos>`, `<pad>` to 64.
    // shortcut: the vocabulary's added tokens (`<mask>`, `<start_of_turn>`…) aren't matched as one token when typed;
    // nobody types them into a search.
    pub fn encode(&self, text: &str) -> Vec<i64> {
        let text = text.to_lowercase().replace(' ', "▁");
        let mut syms: Vec<u32> = Vec::new();
        let mut buf = [0u8; 4];
        for c in text.chars() {
            let s = c.encode_utf8(&mut buf);
            if let Some(&id) = self.vocab.get(&*s) {
                syms.push(id);
            } else if let Some(ids) = s.bytes().map(|b| self.bytes[b as usize]).collect::<Option<Vec<_>>>() {
                syms.extend(ids);
            } else if syms.last() != Some(&UNK) {
                syms.push(UNK);
            }
        }
        while let Some((_, i, m)) = syms
            .windows(2)
            .enumerate()
            .filter_map(|(i, w)| self.merges.get(&(w[0], w[1])).map(|&(rank, m)| (rank, i, m)))
            .min()
        {
            syms[i] = m;
            syms.remove(i + 1);
        }
        let mut ids: Vec<i64> = syms.into_iter().take(TOKENS - 1).map(i64::from).collect();
        ids.push(EOS);
        ids.resize(TOKENS, PAD);
        ids
    }
}

static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

/// ONNX Runtime, loaded once from the downloaded library by its absolute path, never from PATH or the system folders.
fn env(dir: &Path) -> Result<&'static Environment, String> {
    let rt = RUNTIME.ok_or(UNSUPPORTED)?;
    // Not cached: installing the runtime fixes it without a restart.
    if ENV.get().is_none() && !vc_runtime() {
        return Err(VC_RUNTIME.into());
    }
    ENV.get_or_init(|| {
        ort::init_from(dir.join(rt.name))
            .map_err(err)?
            .with_name("mimikit")
            .build()
            .map_err(err)
    })
    .as_ref()
    .map_err(|e| format!("Couldn't start search by meaning: {e}"))
}

/// ONNX Runtime's threads for indexing, at low OS priority so the UI and on-screen thumbnails come first. They end
/// with the session, as `low_priority` needs.
struct LowPriority;

impl ort::environment::ThreadManager for LowPriority {
    type Thread = std::thread::JoinHandle<()>;

    fn create(&self, work: impl FnOnce() + Send + 'static) -> ort::Result<Self::Thread> {
        Ok(std::thread::spawn(move || {
            crate::low_priority();
            work()
        }))
    }

    fn join(thread: Self::Thread) -> ort::Result<()> {
        thread
            .join()
            .map_err(|_| ort::Error::new("an ONNX Runtime thread panicked"))
    }
}

/// A model on the CPU: half the cores (2 to 4), without spinning, so idle threads don't drain a laptop's battery.
fn session(dir: &Path, file: &File, low: bool) -> Result<Session, String> {
    let builder = Session::builder(env(dir)?)
        .map_err(err)?
        .with_intra_threads(analysis::workers().clamp(2, 4))
        .map_err(err)?
        .with_intra_op_spinning(false)
        .map_err(err)?;
    let mut builder = if low {
        builder.with_thread_manager(LowPriority).map_err(err)?
    } else {
        builder
    };
    builder.commit_from_file(dir.join(file.name)).map_err(err)
}

/// Unit vectors for prepared pictures (one model run).
fn embed_pictures(session: &mut Session, pics: Vec<Vec<f32>>) -> Result<Vec<Vec<f32>>, String> {
    let input = Tensor::from_array(([pics.len(), 3, SIZE, SIZE], pics.concat())).map_err(err)?;
    let out = session.run(ort::inputs!["pixel_values" => input]).map_err(err)?;
    let (_, v) = out["pooler_output"].try_extract_tensor::<f32>().map_err(err)?;
    Ok(v.chunks(DIMS).map(unit).collect())
}

/// The words' model and tokenizer, loaded on the first search.
struct Words {
    session: Session,
    tokenizer: Tokenizer,
    used: Instant,
}

static WORDS: Mutex<Option<Words>> = Mutex::new(None);

fn query(dir: &Path, text: &str) -> Result<Vec<f32>, String> {
    let mut words = WORDS.lock().unwrap();
    if words.is_none() {
        let json = std::fs::read(dir.join(TOKENIZER.name)).map_err(err)?;
        *words = Some(Words {
            session: session(dir, &TEXT, false)?,
            tokenizer: Tokenizer::parse(&json)?,
            used: Instant::now(),
        });
        // shortcut: a fixed idle time; make it smarter if memory complaints come in.
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(60));
                let mut w = WORDS.lock().unwrap();
                if w.as_ref().is_none_or(|w| w.used.elapsed() > IDLE) {
                    *w = None;
                    break;
                }
            }
        });
    }
    let w = words.as_mut().unwrap();
    w.used = Instant::now();
    let text: String = text.trim().chars().take(MAX_WORDS).collect();
    let input = Tensor::from_array(([1, TOKENS], w.tokenizer.encode(&text))).map_err(err)?;
    let out = w.session.run(ort::inputs!["input_ids" => input]).map_err(err)?;
    let (_, v) = out["pooler_output"].try_extract_tensor::<f32>().map_err(err)?;
    Ok(unit(v))
}

/// A row to store: (id, size, mtime, vector).
type Row = (i64, i64, i64, Vec<u8>);

/// Prepared pictures by their place in a group; None for one that couldn't be read.
type Prepared = Vec<(usize, Option<Vec<f32>>)>;

/// Reads and prepares `group` on half the decode permits. A missing preview is asked of `draw`, which says whether the
/// window answered. None for an asset that couldn't be read or drawn; left out when its drive was unplugged or the
/// window didn't answer, so it stays stale for later. True when `gate()` stopped it.
fn prepare_group<G>(
    group: &[&Todo],
    thumbs_dir: &Path,
    gate: &(impl Fn() -> Option<G> + Sync),
    draw: &(impl Fn(&Todo) -> bool + Sync),
) -> (Prepared, bool) {
    let next = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let mut out: Vec<_> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..analysis::workers().min(group.len()))
            .map(|_| {
                s.spawn(|| {
                    crate::low_priority();
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, SeqCst);
                        let Some(t) = group.get(i) else { break };
                        let Some(_permit) = gate() else {
                            stopped.store(true, SeqCst);
                            break;
                        };
                        let picture = match preview(thumbs_dir, t) {
                            None => analysis::pixels(&t.path, &t.ext, &t.thumb(thumbs_dir)),
                            Some(p) if !p.exists() && !(t.root.is_dir() && draw(t)) => continue,
                            Some(p) => image::open(p).map(|img| img.into_rgba8()).map_err(err),
                        };
                        match picture {
                            Ok(img) => out.push((i, Some(prepare(&img)))),
                            Err(_) if !t.root.is_dir() => {}
                            Err(_) => out.push((i, None)),
                        }
                    }
                    out
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    out.sort_unstable_by_key(|p| p.0);
    (out, stopped.load(SeqCst))
}

/// What turns prepared pictures into unit vectors: the vision model, or a stand-in in tests.
type Embed<'a> = dyn FnMut(Vec<Vec<f32>>) -> Result<Vec<Vec<f32>>, String> + Send + 'a;

/// Indexes `todo` [`STORE`] images at a time, each batch stored in one transaction, so the lock is only held for the
/// write. Images go first; then models, videos and fonts, [`BATCH`] at a time, as their previews can wait on the window
/// (`draw`). The work runs on low-priority threads. `gate()` runs before each asset is read and its result (a decode
/// permit) is held meanwhile; None stops the work, and what was done so far is still stored. `after(conn, n)` runs
/// after each commit with the lock held.
fn index_and_store<G>(
    db: &Mutex<Connection>,
    todo: &[Todo],
    thumbs_dir: &Path,
    gate: impl Fn() -> Option<G> + Sync,
    draw: impl Fn(&Todo) -> bool + Sync,
    embed: &mut Embed,
    mut after: impl FnMut(&Connection, usize),
) -> Result<(), String> {
    let (images, previews): (Vec<&Todo>, Vec<&Todo>) = todo.iter().partition(|t| preview(thumbs_dir, t).is_none());
    for chunk in images.chunks(STORE).chain(previews.chunks(BATCH)) {
        let (rows, stopped) = std::thread::scope(|s| {
            s.spawn(|| -> Result<(Vec<Row>, bool), String> {
                crate::low_priority();
                let mut rows = Vec::new();
                for group in chunk.chunks(BATCH) {
                    let (pics, stopped) = prepare_group(group, thumbs_dir, &gate, &draw);
                    let (read, unread): (Vec<_>, Vec<_>) = pics.into_iter().partition(|p| p.1.is_some());
                    rows.extend(
                        unread
                            .iter()
                            .map(|&(i, _)| (group[i].id, group[i].size, group[i].mtime, vec![])),
                    );
                    let at: Vec<usize> = read.iter().map(|p| p.0).collect();
                    if !at.is_empty() {
                        let vecs = embed(read.into_iter().filter_map(|p| p.1).collect())?;
                        for (i, v) in at.into_iter().zip(vecs) {
                            rows.push((group[i].id, group[i].size, group[i].mtime, quantize(&v)));
                        }
                    }
                    if stopped {
                        return Ok((rows, true));
                    }
                }
                Ok((rows, false))
            })
            .join()
            .map_err(|_| "indexing stopped unexpectedly".to_string())?
        })?;
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        store(&tx, &rows).map_err(err)?;
        tx.commit().map_err(err)?;
        DIRTY.store(true, SeqCst);
        after(&conn, rows.len());
        drop(conn);
        if stopped {
            break;
        }
        // The mutex isn't fair: without a pause the next batch can re-lock before a waiting command.
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

/// A download in progress, in bytes over all files.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Progress {
    done: u64,
    total: u64,
}

/// Checks a downloaded file against its hash: kept under its own name when it matches, deleted when it doesn't.
fn keep(part: &Path, path: &Path, sha256: &str) -> Result<(), String> {
    let mut h = Sha256::new();
    std::io::copy(&mut std::fs::File::open(part).map_err(err)?, &mut h).map_err(err)?;
    if format!("{:x}", h.finalize()) != sha256 {
        let _ = std::fs::remove_file(part);
        return Err(DAMAGED.into());
    }
    std::fs::rename(part, path).map_err(err)
}

/// Downloads the files that aren't there yet into `dir`. A `.part` file left by a failure, Cancel or quitting is
/// resumed with a Range request. Each file is checked against its hash before it's kept. False when cancelled.
fn download(dir: &Path, cancelled: impl Fn() -> bool, mut progress: impl FnMut(Progress)) -> Result<bool, String> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let files = files();
    let part = |f: &File| dir.join(format!("{}.part", f.name));
    let have = |f: &File| match std::fs::metadata(dir.join(f.name)) {
        Ok(m) if m.len() == f.size => f.size,
        _ => std::fs::metadata(part(f)).map_or(0, |m| m.len().min(f.size)),
    };
    let total = files.iter().map(|f| f.size).sum();
    let mut done: u64 = files.iter().map(have).sum();
    progress(Progress { done, total });
    // reqwest is built without a default crypto provider (see ai.rs `call`).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    tauri::async_runtime::block_on(async {
        for f in &files {
            let path = dir.join(f.name);
            if std::fs::metadata(&path).is_ok_and(|m| m.len() == f.size) {
                continue;
            }
            // Also between files, since a Cancel during a hash check isn't seen until bytes arrive again.
            if cancelled() {
                return Ok(false);
            }
            let part = part(f);
            let mut got = std::fs::metadata(&part).map_or(0, |m| m.len());
            if got > f.size {
                let _ = std::fs::remove_file(&part);
                done -= f.size;
                got = 0;
            }
            if got < f.size {
                let mut req = client.get(f.url);
                if got > 0 {
                    req = req.header(reqwest::header::RANGE, format!("bytes={got}-"));
                }
                let mut res = req.send().await.map_err(|_| OFFLINE.to_string())?;
                let mut out = match res.status().as_u16() {
                    206 => std::fs::OpenOptions::new().append(true).open(&part),
                    200 => {
                        done -= got;
                        got = 0;
                        std::fs::File::create(&part)
                    }
                    _ => return Err(OFFLINE.to_string()),
                }
                .map_err(err)?;
                let mut shown = Instant::now();
                while let Some(chunk) = res.chunk().await.map_err(|_| OFFLINE.to_string())? {
                    if cancelled() {
                        return Ok(false);
                    }
                    out.write_all(&chunk).map_err(err)?;
                    got += chunk.len() as u64;
                    done += chunk.len() as u64;
                    if shown.elapsed() > Duration::from_millis(250) {
                        progress(Progress { done, total });
                        shown = Instant::now();
                    }
                }
            }
            keep(&part, &path, f.sha256)?;
        }
        Ok(true)
    })
}

/// What the UI shows about search by meaning: sent as `meaning-status` whenever it changes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Assets indexed, including ones that couldn't be read or drawn.
    done: usize,
    /// Assets that can be indexed.
    total: usize,
    /// A pass the UI shows is running (downloading or indexing).
    running: bool,
    paused: bool,
    /// Turned on for this model.
    on: bool,
    /// The model and runtime are downloaded and checked.
    installed: bool,
    download: Option<Progress>,
    /// Why the last pass stopped, if it failed.
    error: Option<String>,
    /// What turning it on downloads, for the consent dialog; empty where search by meaning isn't available.
    files: Vec<File>,
    /// False on Windows without the Visual C++ runtime ONNX Runtime needs.
    vc_runtime: bool,
    /// Bytes in `models/`, finished or not: what Delete model and index frees besides the index.
    downloaded: u64,
    /// The model's id, for agents' `overview`.
    model: &'static str,
}

static DOWNLOAD: Mutex<Option<Progress>> = Mutex::new(None);
static ERROR: Mutex<Option<String>> = Mutex::new(None);

fn status(conn: &Connection, data_dir: &Path) -> rusqlite::Result<Status> {
    let (done, total) = counts(conn)?;
    Ok(Status {
        done,
        total,
        running: PASS.shown.load(SeqCst),
        paused: PASS.paused.load(SeqCst),
        on: on(conn),
        installed: installed(&model_dir(data_dir)),
        download: *DOWNLOAD.lock().unwrap(),
        error: ERROR.lock().unwrap().clone(),
        files: files(),
        vc_runtime: vc_runtime(),
        downloaded: walkdir::WalkDir::new(data_dir.join("models"))
            .into_iter()
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum(),
        model: MODEL,
    })
}

pub fn emit_status(app: &AppHandle, conn: &Connection) {
    match status(conn, &app.state::<AppState>().data_dir) {
        Ok(s) => {
            let _ = app.emit("meaning-status", s);
        }
        Err(e) => eprintln!("meaning: {e}"),
    }
}

static PASS: Pass = Pass::new(|app, all, ids, cancels| {
    let r = pass(app, all, ids, cancels);
    if let Err(e) = &r {
        eprintln!("meaning: {e}");
    }
    *ERROR.lock().unwrap() = r.err();
    *DOWNLOAD.lock().unwrap() = None;
    PASS.shown.store(false, SeqCst);
    emit_status(app, &app.state::<AppState>().db.lock().unwrap());
});

/// How long the window may take to draw one preview: it gives up on a video after 15 s, and a big model takes a while.
const DRAW_TIMEOUT: Duration = Duration::from_secs(60);
/// Set once the window listens for `meaning-preview`: the pass at launch starts before it has loaded.
static WINDOW: AtomicBool = AtomicBool::new(false);
/// Previews asked of the window, by asset id, with where its answer goes.
static DRAWING: Mutex<Vec<(i64, std::sync::mpsc::Sender<()>)>> = Mutex::new(Vec::new());
/// One preview asked at a time, as bulk Suggest tags draws them: asked all at once, big models would time out in its queue.
static DRAW_ONE: Mutex<()> = Mutex::new(());

/// What the window needs to draw an asset's preview: the fields its thumbnail and font code read.
#[derive(Serialize, Clone)]
struct Wanted<'a> {
    id: i64,
    path: String,
    ext: &'a str,
    kind: &'static str,
    size: i64,
    mtime: i64,
}

/// Asks the window to draw `t`'s preview with `emit` (event `meaning-preview`), as it does for its cards and for
/// Suggest tags, and waits for its [`meaning_drawn`]. True once it answered, whether or not it could draw one. Waits
/// while `paused()`, and gives up as soon as `stopped()` (Cancel, or search by meaning turned off).
fn draw_in_window(
    t: &Todo,
    emit: impl FnOnce(&Wanted) -> bool,
    paused: impl Fn() -> bool,
    stopped: impl Fn() -> bool,
) -> bool {
    let _one = DRAW_ONE.lock().unwrap();
    let tick = Duration::from_millis(200);
    // A pause that came while the one before was drawn.
    while paused() && !stopped() {
        std::thread::sleep(tick);
    }
    let since = Instant::now();
    while !WINDOW.load(SeqCst) && !stopped() && since.elapsed() < DRAW_TIMEOUT {
        std::thread::sleep(tick);
    }
    if stopped() || !WINDOW.load(SeqCst) {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    DRAWING.lock().unwrap().push((t.id, tx));
    let wanted = Wanted {
        id: t.id,
        path: t.path.display().to_string(),
        ext: &t.ext,
        kind: kind::kind_of(&t.ext),
        size: t.size,
        mtime: t.mtime,
    };
    let asked = Instant::now();
    let answered = emit(&wanted)
        && loop {
            match rx.recv_timeout(tick) {
                Ok(()) => break true,
                Err(_) if stopped() || asked.elapsed() > DRAW_TIMEOUT => break false,
                Err(_) => {}
            }
        };
    DRAWING.lock().unwrap().retain(|(id, _)| *id != t.id);
    answered
}

/// The window listens for `meaning-preview` from now on.
#[tauri::command]
pub fn meaning_window() {
    WINDOW.store(true, SeqCst);
}

/// The window's answer to `meaning-preview`: it drew asset `id`'s preview, or couldn't.
#[tauri::command]
pub fn meaning_drawn(id: i64) {
    for (_, tx) in DRAWING.lock().unwrap().iter().filter(|(i, _)| *i == id) {
        let _ = tx.send(());
    }
}

/// Downloads what's missing, then indexes the whole library (`all`) or the stale assets among `ids`.
fn pass(app: &AppHandle, all: bool, ids: &[i64], cancels: usize) -> Result<(), String> {
    let state = app.state::<AppState>();
    let emit = || emit_status(app, &state.db.lock().unwrap());
    if !on(&state.db.lock().unwrap()) {
        return Ok(());
    }
    let dir = model_dir(&state.data_dir);
    // Right after the download, everything is to do.
    let all = all || !installed(&dir);
    if !installed(&dir) {
        if RUNTIME.is_none() {
            return Err(UNSUPPORTED.into());
        }
        PASS.shown.store(true, SeqCst);
        let progress = |p| {
            *DOWNLOAD.lock().unwrap() = Some(p);
            emit();
        };
        if !download(&dir, || PASS.cancelled(cancels), progress)? {
            return Ok(());
        }
        *DOWNLOAD.lock().unwrap() = None;
    }
    prune(&state.db.lock().unwrap()).map_err(err)?;
    let started = Instant::now();
    let mut indexed = 0;
    let mut after = |conn: &Connection, n: usize| {
        indexed += n;
        emit_status(app, conn);
    };
    let gate = || PASS.gate(&state, cancels);
    // Previews the window didn't answer for wait for the next pass, or this one would ask again forever.
    let missed = Mutex::new(HashSet::new());
    let draw = |t: &Todo| {
        let answered = draw_in_window(
            t,
            |w| app.emit("meaning-preview", w).is_ok(),
            || PASS.paused.load(SeqCst),
            || PASS.cancelled(cancels),
        );
        if !answered {
            missed.lock().unwrap().insert(t.id);
        }
        answered
    };
    // Loaded only when there's something to index: 376 MB while a pass runs.
    let mut vision: Option<Session> = None;
    let mut run = |todo: &[Todo], after: &mut dyn FnMut(&Connection, usize)| -> Result<(), String> {
        if vision.is_none() {
            vision = Some(session(&dir, &VISION, true)?);
        }
        let session = vision.as_mut().unwrap();
        index_and_store(
            &state.db,
            todo,
            &state.thumbs_dir,
            gate,
            draw,
            &mut |pics| embed_pictures(session, pics),
            after,
        )
    };
    if all {
        PASS.shown.store(true, SeqCst);
        emit();
        // Every stale asset, then again for the ones scans or the watcher added or changed meanwhile.
        while PASS.ready(&state, cancels) {
            let offline = analysis::offline(&state.db).map_err(err)?;
            let missed = missed.lock().unwrap().clone();
            let todo: Vec<_> = stale(&state.db.lock().unwrap())
                .map_err(err)?
                .into_iter()
                .filter(|t| !offline.contains(&t.root) && !missed.contains(&t.id))
                .collect();
            if todo.is_empty() {
                break;
            }
            run(&todo, &mut after)?;
        }
    } else {
        let todo = todo(&state.db.lock().unwrap(), ids).map_err(err)?;
        if todo.is_empty() {
            return Ok(());
        }
        // A few changed files are done before a progress line could be read; a big new folder gets one, with Pause.
        PASS.shown.store(todo.len() > STORE, SeqCst);
        emit();
        run(&todo, &mut after)?;
    }
    let secs = started.elapsed().as_secs_f32();
    eprintln!(
        "meaning: {indexed} assets in {secs:.1}s ({:.1}/s)",
        indexed as f32 / secs
    );
    Ok(())
}

/// At launch: catches up on whatever changed while the app was closed, and finishes a download that was cut short.
pub fn resume(app: &AppHandle) {
    if on(&app.state::<AppState>().db.lock().unwrap()) {
        PASS.all(app);
    }
}

/// After a scan or file events changed `ids`: indexes the assets among them while search by meaning is on.
pub fn changed(app: &AppHandle, ids: &[i64]) {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    if on(&conn) {
        PASS.changed(app, true, ids);
        emit_status(app, &conn);
    }
}

#[tauri::command]
pub fn meaning_status(app: AppHandle) -> Result<Status, String> {
    let state = app.state::<AppState>();
    status(&state.db.lock().unwrap(), &state.data_dir).map_err(err)
}

/// Turns search by meaning on, after the user confirmed the download: downloads what's missing and indexes the library.
#[tauri::command]
pub fn meaning_enable(app: AppHandle) -> Result<(), String> {
    if RUNTIME.is_none() {
        return Err(UNSUPPORTED.into());
    }
    if !vc_runtime() {
        return Err(VC_RUNTIME.into());
    }
    let state = app.state::<AppState>();
    let _ = std::fs::remove_file(state.data_dir.join("models").join(DELETE));
    *ERROR.lock().unwrap() = None;
    state
        .db
        .lock()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![SETTING, MODEL],
        )
        .map_err(err)?;
    PASS.all(&app);
    emit_status(&app, &state.db.lock().unwrap());
    Ok(())
}

#[tauri::command]
pub fn meaning_pause(app: AppHandle, paused: bool) {
    PASS.paused.store(paused, SeqCst);
    emit_status(&app, &app.state::<AppState>().db.lock().unwrap());
}

/// Stops the download or indexing. What's done so far stays; the next launch, or turning it on again, goes on.
#[tauri::command]
pub fn meaning_cancel(app: AppHandle) {
    PASS.cancel();
    emit_status(&app, &app.state::<AppState>().db.lock().unwrap());
}

/// Turns search by meaning off and frees its memory. With `delete`, also removes the model, the runtime and the index.
#[tauri::command]
pub fn meaning_disable(app: AppHandle, delete: bool) -> Result<(), String> {
    PASS.cancel();
    *WORDS.lock().unwrap() = None;
    *INDEX.lock().unwrap() = None;
    *ERROR.lock().unwrap() = None;
    let state = app.state::<AppState>();
    {
        let conn = state.db.lock().unwrap();
        conn.execute("DELETE FROM settings WHERE key = ?1", [SETTING])
            .map_err(err)?;
        if delete {
            conn.execute_batch("DELETE FROM meaning.vectors; VACUUM meaning;")
                .map_err(err)?;
        }
    }
    if delete {
        remove_models(&state.data_dir.join("models")).map_err(err)?;
    }
    emit_status(&app, &state.db.lock().unwrap());
    Ok(())
}

/// Deletes the downloaded files. A loaded ONNX Runtime can't be deleted on Windows, and `remove_dir_all` stops at the
/// first file it can't delete, so each file goes on its own; what stays is deleted at the next launch.
fn remove_models(models: &Path) -> std::io::Result<()> {
    for f in walkdir::WalkDir::new(models).into_iter().flatten() {
        if f.file_type().is_file() {
            let _ = std::fs::remove_file(f.path());
        }
    }
    if models.exists() && std::fs::remove_dir_all(models).is_err() {
        std::fs::write(models.join(DELETE), "")?;
    }
    Ok(())
}

/// The score of every indexed asset for `text`, as raw bytes: (asset id i32, cosine f32) little-endian pairs, about
/// 800 KB at 100,000 assets.
#[tauri::command]
pub async fn meaning_scores(app: AppHandle, text: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir = model_dir(&state.data_dir);
        if !on(&state.db.lock().unwrap()) || !installed(&dir) {
            return Err(NOT_ON.to_string());
        }
        let q = query(&dir, &text)?;
        Ok(tauri::ipc::Response::new(score_all(&state.db, &q, None)?))
    })
    .await
    .map_err(err)?
}

/// Find related: the score of every other indexed asset for asset `id`'s own vector, as in [`meaning_scores`]. Needs
/// no model, so it downloads and loads nothing but the index.
#[tauri::command]
pub async fn meaning_related(app: AppHandle, id: i64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let q = related_query(&state.db.lock().unwrap(), id)?;
        Ok(tauri::ipc::Response::new(score_all(&state.db, &q, Some(id))?))
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, scan};

    /// A library DB with `meaning.db` attached in memory, search by meaning on.
    fn library() -> Connection {
        let conn = db::open_memory();
        conn.execute_batch(&format!("ATTACH ':memory:' AS meaning; {SCHEMA}"))
            .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params![SETTING, MODEL],
        )
        .unwrap();
        conn
    }

    /// A scanned folder of `n` small images (img0.png…), none indexed, and an empty thumbnail folder.
    fn scanned(n: u8) -> (tempfile::TempDir, Connection, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (r, thumbs_dir) = (dir.path().join("lib"), dir.path().join("thumbs"));
        std::fs::create_dir_all(&r).unwrap();
        std::fs::create_dir_all(&thumbs_dir).unwrap();
        for i in 0..n {
            RgbaImage::from_pixel(40, 30, Rgba([i * 40, 90, 0, 255]))
                .save(r.join(format!("img{i}.png")))
                .unwrap();
        }
        let mut conn = library();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [r.display().to_string()])
            .unwrap();
        scan::tests::scan(&mut conn, 1, &r);
        (dir, conn, thumbs_dir)
    }

    /// Stands in for the vision model: a unit vector from the picture's mean red, so tests can tell pictures apart.
    fn fake(pics: Vec<Vec<f32>>) -> Result<Vec<Vec<f32>>, String> {
        Ok(pics
            .iter()
            .map(|p| {
                let red = p[..SIZE * SIZE].iter().sum::<f32>() / (SIZE * SIZE) as f32;
                let mut v = vec![0.0; DIMS];
                v[0] = 1.0;
                v[1] = red + 1.0;
                unit(&v)
            })
            .collect())
    }

    /// Indexes everything stale, with `draw` standing in for the window.
    fn index_drawn(db: &Mutex<Connection>, thumbs_dir: &Path, draw: impl Fn(&Todo) -> bool + Sync) -> usize {
        let todo = stale(&db.lock().unwrap()).unwrap();
        let mut stored = 0;
        index_and_store(db, &todo, thumbs_dir, || Some(()), draw, &mut fake, |_, n| stored += n).unwrap();
        stored
    }

    /// The same without a window to draw previews.
    fn index_all(db: &Mutex<Connection>, thumbs_dir: &Path) -> usize {
        index_drawn(db, thumbs_dir, |_| false)
    }

    #[test]
    fn pictures_are_fitted_whole_on_grey() {
        let grey = 128.0 / 127.5 - 1.0;
        let at = |v: &[f32], c: usize, x: usize, y: usize| v[c * SIZE * SIZE + y * SIZE + x];
        // A wide red strip: fitted to the full width and centred, with grey above and below.
        let wide = prepare(&RgbaImage::from_pixel(512, 128, Rgba([255, 0, 0, 255])));
        assert_eq!(wide.len(), 3 * SIZE * SIZE);
        assert_eq!((at(&wide, 0, 0, 128), at(&wide, 1, 255, 128)), (1.0, -1.0));
        assert_eq!((at(&wide, 0, 128, 0), at(&wide, 0, 128, 95)), (grey, grey));
        assert_eq!(
            (at(&wide, 0, 128, 96), at(&wide, 0, 128, 159), at(&wide, 0, 128, 160)),
            (1.0, 1.0, grey)
        );
        // Transparency is mid-grey, whatever colour the transparent pixels hold; half transparent is halfway there.
        let clear = prepare(&RgbaImage::from_pixel(100, 100, Rgba([255, 255, 255, 0])));
        assert!(clear.iter().all(|&v| v == grey));
        let half = prepare(&RgbaImage::from_pixel(100, 100, Rgba([255, 0, 0, 128])));
        assert!((at(&half, 0, 128, 128) - (192.0 / 127.5 - 1.0)).abs() < 0.01);
        // Small pixel art keeps sharp edges: a 2×2 checker enlarged to 256 has only its two colours.
        let checker = RgbaImage::from_fn(2, 2, |x, y| {
            if (x + y) % 2 == 0 {
                Rgba([255, 255, 255, 255])
            } else {
                Rgba([0, 0, 0, 255])
            }
        });
        let big = prepare(&checker);
        assert!(big.iter().all(|&v| v == 1.0 || v == -1.0));
        assert_eq!((at(&big, 0, 127, 127), at(&big, 0, 128, 127)), (1.0, -1.0));
        // A larger picture is smoothed: the same checker at 128 px blends at the edge.
        let smooth = prepare(&image::imageops::resize(&checker, 128, 128, FilterType::Nearest));
        assert!(smooth.iter().any(|&v| v > -1.0 && v < 1.0));
    }

    /// A tokenizer with a handful of words, merges and byte tokens, in `tokenizer.json`'s shape.
    fn tiny() -> Tokenizer {
        let mut vocab: Vec<(String, u32)> = [
            "<pad>", "<eos>", "<bos>", "<unk>", "r", "e", "d", "▁", "p", "o", "re", "red", "▁p", "▁po", "op",
        ]
        .iter()
        .enumerate()
        .map(|(i, s)| (s.to_string(), i as u32))
        .collect();
        vocab.extend((0..=255u32).map(|b| (format!("<0x{b:02X}>"), 100 + b)));
        let json = serde_json::json!({
            "model": {
                "vocab": vocab.into_iter().collect::<HashMap<_, _>>(),
                "merges": [["o", "p"], ["▁", "p"], ["▁p", "o"], ["r", "e"], ["re", "d"]]
            }
        });
        Tokenizer::parse(json.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn tokenizer_merges_lowest_rank_first_and_falls_back_to_bytes() {
        let t = tiny();
        let ids = |s: &str| t.encode(s).into_iter().take_while(|&i| i != PAD).collect::<Vec<_>>();
        assert_eq!(ids("RED"), vec![11, EOS]);
        assert_eq!(ids(" po"), vec![13, EOS]);
        // "op" (rank 0) merges before "▁p" (rank 1), so "▁po" never forms: ▁p, op. Left to right it would be ▁po, p.
        assert_eq!(ids(" pop"), vec![12, 14, EOS]);
        assert_eq!(ids(" pp"), vec![12, 8, EOS]);
        // Characters missing from the vocabulary become their UTF-8 bytes.
        assert_eq!(ids("é"), vec![100 + 0xC3, 100 + 0xA9, EOS]);
        assert_eq!(ids(""), vec![EOS]);
        // Always 64 ids: long text is cut to 63 tokens and still ends with <eos>.
        let long = t.encode(&"d".repeat(200));
        assert_eq!((long.len(), long[62], long[63]), (TOKENS, 6, EOS));
        assert_eq!(t.encode("r").len(), TOKENS);
    }

    /// Fixtures from transformers' GemmaTokenizer (phase 0). Needs the model's tokenizer.json:
    /// `MEANING_MODEL_DIR=<folder with it> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn tokenizer_matches_transformers() {
        let dir = PathBuf::from(std::env::var("MEANING_MODEL_DIR").expect("MEANING_MODEL_DIR"));
        let t = Tokenizer::parse(&std::fs::read(dir.join(TOKENIZER.name)).unwrap()).unwrap();
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/siglip2-tokens.json")).unwrap();
        let cases = fixtures["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 50);
        for c in cases {
            let mut want: Vec<i64> = serde_json::from_value(c["ids"].clone()).unwrap();
            want.resize(TOKENS, PAD);
            assert_eq!(t.encode(c["text"].as_str().unwrap()), want, "{}", c["text"]);
        }
    }

    /// The real model, end to end. Needs the downloaded files: `MEANING_MODEL_DIR=<models/siglip2-b32-256> cargo test
    /// -- --ignored`.
    #[test]
    #[ignore]
    fn the_model_tells_red_from_blue() {
        let dir = PathBuf::from(std::env::var("MEANING_MODEL_DIR").expect("MEANING_MODEL_DIR"));
        let disc = |c: [u8; 3]| {
            RgbaImage::from_fn(200, 200, |x, y| {
                let r = ((x as f32 - 100.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt();
                if r < 70.0 {
                    Rgba([c[0], c[1], c[2], 255])
                } else {
                    Rgba([0, 0, 0, 0])
                }
            })
        };
        let mut vision = session(&dir, &VISION, true).unwrap();
        let v = embed_pictures(
            &mut vision,
            vec![prepare(&disc([220, 20, 20])), prepare(&disc([20, 40, 220]))],
        )
        .unwrap();
        let cos = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let (red, blue) = (
            query(&dir, "a red circle").unwrap(),
            query(&dir, "a blue circle").unwrap(),
        );
        assert!(cos(&v[0], &red) > cos(&v[0], &blue), "red disc");
        assert!(cos(&v[1], &blue) > cos(&v[1], &red), "blue disc");
        assert!((v[0].iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-4);
    }

    #[test]
    fn int8_ranks_like_f32() {
        // Clustered like real embeddings: every vector near one centre, so the top scores are close.
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as f32 / (1u64 << 31) as f32 - 0.5
        };
        let centre: Vec<f32> = (0..DIMS).map(|_| rnd()).collect();
        let vecs: Vec<Vec<f32>> = (0..2000)
            .map(|_| unit(&centre.iter().map(|c| c + 0.6 * rnd()).collect::<Vec<_>>()))
            .collect();
        let q = unit(&centre.iter().map(|c| c + 0.8 * rnd()).collect::<Vec<_>>());
        let mut index = Index {
            ids: vec![],
            vecs: vec![],
            scales: vec![],
        };
        for (i, v) in vecs.iter().enumerate() {
            let b = quantize(v);
            index.ids.push(i as i64);
            index.vecs.extend(b[..DIMS].iter().map(|&x| x as i8));
            index.scales.push(f32::from_le_bytes(b[DIMS..].try_into().unwrap()));
        }
        let bytes = index.scores(&q, None);
        let int8: Vec<(i32, f32)> = bytes
            .chunks(8)
            .map(|c| {
                (
                    i32::from_le_bytes(c[..4].try_into().unwrap()),
                    f32::from_le_bytes(c[4..].try_into().unwrap()),
                )
            })
            .collect();
        let exact: Vec<f32> = vecs
            .iter()
            .map(|v| v.iter().zip(&q).map(|(a, b)| a * b).sum())
            .collect();
        // The same top 20, though neighbours with nearly equal scores may swap places.
        let top = |s: &mut Vec<(usize, f32)>| {
            s.sort_by(|a, b| b.1.total_cmp(&a.1));
            let mut top: Vec<usize> = s.iter().take(20).map(|p| p.0).collect();
            top.sort();
            top
        };
        let mut a: Vec<(usize, f32)> = int8.iter().map(|&(i, s)| (i as usize, s)).collect();
        let mut b: Vec<(usize, f32)> = exact.iter().copied().enumerate().collect();
        assert_eq!(top(&mut a), top(&mut b));
        assert!(int8.iter().all(|&(i, s)| (s - exact[i as usize]).abs() < 0.01));
    }

    #[test]
    fn index_covers_each_version_and_model_once() {
        let (dir, conn, thumbs_dir) = scanned(3);
        std::fs::write(dir.path().join("lib/broken.png"), "not a png").unwrap();
        let mut conn = conn;
        scan::tests::scan(&mut conn, 1, &dir.path().join("lib"));
        assert_eq!(counts(&conn).unwrap(), (0, 4));
        let db = Mutex::new(conn);
        assert_eq!(index_all(&db, &thumbs_dir), 4);
        let conn = db.into_inner().unwrap();
        assert_eq!(counts(&conn).unwrap(), (4, 4));
        let id = |n: &str| -> i64 {
            conn.query_row("SELECT id FROM assets WHERE name = ?1", [n], |r| r.get(0))
                .unwrap()
        };
        // The broken file gets an empty vector: not retried, not searched.
        assert!(stale(&conn).unwrap().is_empty());
        let index = Index::load(&conn).unwrap();
        assert_eq!(index.ids.len(), 3);
        // Searching gives every indexed image a score; this one leans to the reddest picture.
        let mut q = vec![0.0; DIMS];
        (q[0], q[1]) = (1.0, 4.0);
        let scores = index.scores(&unit(&q), None);
        assert_eq!(scores.len(), 3 * 8);
        let best = scores
            .chunks(8)
            .max_by(|a, b| {
                f32::from_le_bytes(a[4..].try_into().unwrap())
                    .total_cmp(&f32::from_le_bytes(b[4..].try_into().unwrap()))
            })
            .unwrap();
        assert_eq!(i32::from_le_bytes(best[..4].try_into().unwrap()) as i64, id("img2.png"));

        // A new size or mtime, or another model's vector, makes it stale.
        conn.execute("UPDATE assets SET mtime = mtime + 1 WHERE id = ?1", [id("img0.png")])
            .unwrap();
        conn.execute("UPDATE assets SET size = size + 1 WHERE id = ?1", [id("img1.png")])
            .unwrap();
        conn.execute(
            "UPDATE meaning.vectors SET model = 'clip-b32' WHERE asset_id = ?1",
            [id("img2.png")],
        )
        .unwrap();
        let mut left: Vec<i64> = stale(&conn).unwrap().iter().map(|t| t.id).collect();
        left.sort();
        assert_eq!(left, vec![id("img0.png"), id("img1.png"), id("img2.png")]);
        assert_eq!(counts(&conn).unwrap(), (1, 4));
        assert_eq!(Index::load(&conn).unwrap().ids.len(), 0);
        // Only stale images among the changed ones are done by a changed-files pass.
        assert_eq!(todo(&conn, &[id("img0.png"), id("broken.png"), 9999]).unwrap().len(), 1);

        // A deleted asset's vector is pruned; vectors for an asset or version that's gone aren't stored.
        let broken = id("broken.png");
        conn.execute("DELETE FROM assets WHERE id = ?1", [broken]).unwrap();
        prune(&conn).unwrap();
        let rows = |c: &Connection| {
            c.query_row("SELECT count(*) FROM meaning.vectors", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(rows(&conn), 3);
        store(&conn, &[(broken, 1, 1, vec![1]), (id("img0.png"), 0, 0, vec![1])]).unwrap();
        assert_eq!(rows(&conn), 3);
        // Turned off meanwhile: a pass's last batch isn't stored.
        conn.execute("DELETE FROM settings WHERE key = ?1", [SETTING]).unwrap();
        assert!(!on(&conn));
        let db = Mutex::new(conn);
        assert_eq!(index_all(&db, &thumbs_dir), 3);
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (0, 3));
    }

    #[test]
    fn find_related_ranks_the_other_images_closest_first() {
        let (dir, mut conn, thumbs_dir) = scanned(4);
        std::fs::write(dir.path().join("lib/broken.png"), "not a png").unwrap();
        scan::tests::scan(&mut conn, 1, &dir.path().join("lib"));
        let id = |c: &Connection, n: &str| -> i64 {
            c.query_row("SELECT id FROM assets WHERE name = ?1", [n], |r| r.get(0))
                .unwrap()
        };
        let img0 = id(&conn, "img0.png");
        assert_eq!(related_query(&conn, img0), Err(NOT_INDEXED.into()));
        let db = Mutex::new(conn);
        index_all(&db, &thumbs_dir);
        let conn = db.into_inner().unwrap();
        assert_eq!(related_query(&conn, id(&conn, "broken.png")), Err(UNREADABLE.into()));

        // The fake model's vectors follow each picture's red, so img0's nearest are img1, img2, img3 in that order.
        let q = related_query(&conn, img0).unwrap();
        let mut ranked: Vec<(i64, f32)> = Index::load(&conn)
            .unwrap()
            .scores(&q, Some(img0))
            .chunks(8)
            .map(|c| {
                (
                    i32::from_le_bytes(c[..4].try_into().unwrap()) as i64,
                    f32::from_le_bytes(c[4..].try_into().unwrap()),
                )
            })
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let order: Vec<i64> = ranked.iter().map(|r| r.0).collect();
        assert_eq!(order, ["img1.png", "img2.png", "img3.png"].map(|n| id(&conn, n)));
        assert!(ranked[0].1 < 1.0 && ranked[2].1 > 0.0);

        // A changed file needs indexing again, and nothing is related while search by meaning is off.
        conn.execute("UPDATE assets SET mtime = mtime + 1 WHERE id = ?1", [img0])
            .unwrap();
        assert_eq!(related_query(&conn, img0), Err(NOT_INDEXED.into()));
        conn.execute("DELETE FROM settings WHERE key = ?1", [SETTING]).unwrap();
        assert_eq!(related_query(&conn, id(&conn, "img1.png")), Err(NOT_ON.into()));
    }

    #[test]
    fn the_window_is_asked_one_preview_at_a_time_and_pause_and_cancel_stop_it() {
        meaning_window();
        let (paused, stopped) = (AtomicBool::new(false), AtomicBool::new(false));
        let (asked, asks) = std::sync::mpsc::channel();
        let quiet = Duration::from_millis(500);
        std::thread::scope(|s| {
            let draws: Vec<_> = [9001, 9002]
                .map(|id| {
                    let t = Todo {
                        id,
                        path: "m.glb".into(),
                        root: ".".into(),
                        ext: "glb".into(),
                        size: 1,
                        mtime: 1,
                    };
                    let (asked, paused, stopped) = (asked.clone(), &paused, &stopped);
                    s.spawn(move || {
                        draw_in_window(
                            &t,
                            |w| asked.send(w.id).is_ok(),
                            || paused.load(SeqCst),
                            || stopped.load(SeqCst),
                        )
                    })
                })
                .into();
            // One is asked; the other waits until the window answers.
            let first = asks.recv().unwrap();
            assert!(asks.recv_timeout(quiet).is_err());
            // Paused meanwhile: the next isn't asked until Resume.
            paused.store(true, SeqCst);
            meaning_drawn(first);
            assert!(asks.recv_timeout(quiet).is_err());
            paused.store(false, SeqCst);
            assert_ne!(asks.recv_timeout(Duration::from_secs(5)).unwrap(), first);
            // Cancelled: no waiting out the window's time.
            let at = Instant::now();
            stopped.store(true, SeqCst);
            let answered: Vec<bool> = draws.into_iter().map(|h| h.join().unwrap()).collect();
            assert!(at.elapsed() < Duration::from_secs(5));
            assert_eq!(answered, [first == 9001, first == 9002]);
        });
    }

    #[test]
    fn models_videos_and_fonts_are_indexed_from_the_previews_the_window_draws() {
        let (dir, mut conn, thumbs_dir) = scanned(1);
        let lib = dir.path().join("lib");
        for f in ["ship.glb", "clip.mp4", "sans.ttf", "notes.txt", "hit.wav"] {
            std::fs::write(lib.join(f), f).unwrap();
        }
        scan::tests::scan(&mut conn, 1, &lib);
        // Text and audio have no picture; the rest do.
        assert_eq!(counts(&conn).unwrap(), (0, 4));
        let todo = stale(&conn).unwrap();
        let named = |n: &str| todo.iter().find(|t| t.path.ends_with(n)).unwrap();
        let (ship, clip, sans) = (named("ship.glb"), named("clip.mp4"), named("sans.ttf"));
        let picture = |t: &Todo, red: u8| {
            RgbaImage::from_pixel(256, 96, Rgba([red, 0, 0, 255]))
                .save(preview(&thumbs_dir, t).unwrap())
                .unwrap()
        };
        let (ship_id, clip_id, sans_id) = (ship.id, clip.id, sans.id);
        let db = Mutex::new(conn);

        // The window doesn't answer: the image is indexed and the rest wait, not stored as unreadable.
        assert_eq!(index_all(&db, &thumbs_dir), 1);
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (1, 4));
        // A preview the window already drew is used without asking; it draws the font's; it can't draw the video.
        picture(ship, 200);
        let asked = Mutex::new(vec![]);
        let draw = |t: &Todo| {
            asked.lock().unwrap().push(t.id);
            if t.id == sans_id {
                picture(t, 100);
            }
            true
        };
        assert_eq!(index_drawn(&db, &thumbs_dir, draw), 3);
        let mut asked = asked.into_inner().unwrap();
        asked.sort();
        assert_eq!(asked, [clip_id.min(sans_id), clip_id.max(sans_id)]);
        let conn = db.into_inner().unwrap();
        assert_eq!(counts(&conn).unwrap(), (4, 4));
        assert!(stale(&conn).unwrap().is_empty());
        let mut indexed = Index::load(&conn).unwrap().ids;
        indexed.sort();
        assert_eq!(indexed.len(), 3);
        assert!(indexed.contains(&ship_id) && indexed.contains(&sans_id) && !indexed.contains(&clip_id));
        assert_eq!(related_query(&conn, clip_id), Err(UNDRAWN.into()));

        // A changed model needs a new preview, whose vector replaces the old one.
        let before = related_query(&conn, ship_id).unwrap();
        conn.execute("UPDATE assets SET mtime = mtime + 1 WHERE id = ?1", [ship_id])
            .unwrap();
        assert_eq!(related_query(&conn, ship_id), Err(NOT_INDEXED.into()));
        let db = Mutex::new(conn);
        let redraw = |t: &Todo| {
            picture(t, 0);
            true
        };
        assert_eq!(index_drawn(&db, &thumbs_dir, redraw), 1);
        let conn = db.into_inner().unwrap();
        assert_ne!(related_query(&conn, ship_id).unwrap(), before);
        assert_eq!(counts(&conn).unwrap(), (4, 4));
    }

    #[test]
    fn a_reused_asset_id_starts_without_a_vector() {
        let (_dir, conn, thumbs_dir) = scanned(2);
        let db = Mutex::new(conn);
        assert_eq!(index_all(&db, &thumbs_dir), 2);
        let conn = db.into_inner().unwrap();
        let (id, size, mtime): (i64, i64, i64) = conn
            .query_row("SELECT id, size, mtime FROM assets WHERE name = 'img1.png'", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        // Removing the folder deletes its assets by foreign key, and so their vectors.
        conn.execute("DELETE FROM roots WHERE id = 1", []).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM meaning.vectors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        // Another folder's image that gets the same id, size and mtime is still to do.
        conn.execute("INSERT INTO roots (id, path) VALUES (2, 'elsewhere')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO assets (id, root_id, rel_path, name, ext, kind, size, mtime)
             VALUES (?1, 2, 'other.png', 'other.png', 'png', 'image', ?2, ?3)",
            params![id, size, mtime],
        )
        .unwrap();
        let left: Vec<i64> = stale(&conn).unwrap().iter().map(|t| t.id).collect();
        assert_eq!(left, [id]);
    }

    #[test]
    fn a_stopped_pass_keeps_what_it_stored_and_skips_unplugged_drives() {
        let (dir, conn, thumbs_dir) = scanned(5);
        let usb = dir.path().join("usb");
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [usb.display().to_string()])
            .unwrap();
        conn.execute(
            "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime, seen) VALUES (?1, 'a.png', 'a.png', 'png', 'image', 1, 1, 1)",
            [conn.last_insert_rowid()],
        )
        .unwrap();
        let usb_image = conn.last_insert_rowid();
        let (on_usb, here): (Vec<Todo>, Vec<Todo>) = stale(&conn).unwrap().into_iter().partition(|t| t.id == usb_image);
        assert_eq!((on_usb.len(), here.len()), (1, 5));
        let db = Mutex::new(conn);
        // Cancelled after two images: from then on the gate lets nothing through, and those two are stored.
        let allowed = AtomicUsize::new(2);
        let gate = || allowed.fetch_update(SeqCst, SeqCst, |n| n.checked_sub(1)).ok();
        let mut stored = 0;
        index_and_store(&db, &here, &thumbs_dir, gate, |_| false, &mut fake, |_, n| stored += n).unwrap();
        assert_eq!(stored, 2);
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (2, 6));
        // The unplugged drive's image can't be read and isn't stored as unreadable: it waits until the drive is back.
        assert_eq!(index_all(&db, &thumbs_dir), 3);
        assert_eq!(
            stale(&db.lock().unwrap())
                .unwrap()
                .iter()
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            vec![usb_image]
        );
    }

    #[test]
    fn a_restore_starts_the_index_over() {
        let dir = tempfile::tempdir().unwrap();
        let attach = |restored: bool| {
            let conn = db::open(&dir.path().join("asset-den.db")).unwrap();
            open(&conn, dir.path(), restored).unwrap();
            conn
        };
        attach(false)
            .execute("INSERT INTO meaning.vectors VALUES (1, 1, 1, 'm', x'00')", [])
            .unwrap();
        let rows = |c: &Connection| {
            c.query_row("SELECT count(*) FROM meaning.vectors", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(rows(&attach(false)), 1);
        assert_eq!(rows(&attach(true)), 0);
        // Not part of the library file, so backups (VACUUM INTO main) leave it out.
        let conn = attach(false);
        conn.execute("INSERT INTO meaning.vectors VALUES (1, 1, 1, 'm', x'00')", [])
            .unwrap();
        let copy = dir.path().join("copy.db");
        conn.execute("VACUUM INTO ?1", [copy.to_string_lossy()]).unwrap();
        let tables: i64 = Connection::open(&copy)
            .unwrap()
            .query_row("SELECT count(*) FROM sqlite_master WHERE name = 'vectors'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(tables, 0);
        // A delete that couldn't finish is finished at the next launch.
        let models = dir.path().join("models");
        std::fs::create_dir_all(models.join(MODEL)).unwrap();
        std::fs::write(models.join(MODEL).join("onnxruntime.dll"), "x").unwrap();
        attach(false);
        assert!(models.exists());
        std::fs::write(models.join(DELETE), "").unwrap();
        attach(false);
        assert!(!models.exists());
    }

    // As with a loaded onnxruntime.dll: the file in use stays, with the marker; everything else goes now.
    #[cfg(windows)]
    #[test]
    fn delete_removes_all_but_a_file_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let models = dir.path().join("models");
        let model = models.join(MODEL);
        std::fs::create_dir_all(&model).unwrap();
        for name in ["onnxruntime.dll", "text_model_fp16.onnx", "tokenizer.json.part"] {
            std::fs::write(model.join(name), "x").unwrap();
        }
        let in_use = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(model.join("onnxruntime.dll"))
            .unwrap();
        remove_models(&models).unwrap();
        let mut left: Vec<_> = walkdir::WalkDir::new(&models)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, [DELETE, "onnxruntime.dll"]);
        drop(in_use);
        remove_models(&models).unwrap();
        assert!(!models.exists());
    }

    #[test]
    fn a_damaged_download_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (part, path) = (dir.path().join("f.part"), dir.path().join("f"));
        std::fs::write(&part, "hello").unwrap();
        let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(keep(&part, &path, &"0".repeat(64)), Err(DAMAGED.to_string()));
        assert!(!part.exists() && !path.exists());
        std::fs::write(&part, "hello").unwrap();
        keep(&part, &path, sha).unwrap();
        assert!(!part.exists() && path.exists());
    }

    #[test]
    fn every_file_is_pinned() {
        for f in [VISION, TEXT, TOKENIZER].iter().chain(RUNTIME.iter()) {
            assert!(f.url.starts_with("https://"), "{}", f.name);
            assert!(
                f.sha256.len() == 64 && f.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "{}",
                f.name
            );
            assert!(f.size > 0, "{}", f.name);
        }
        assert!(RUNTIME.is_none_or(|rt| rt.url.contains("/releases/download/onnxruntime-1.31.1/")));
    }

    // Where the Visual C++ runtime is installed (CI's Windows runners, a dev machine), the check finds it.
    #[cfg(windows)]
    #[test]
    fn the_vc_runtime_check_finds_an_installed_runtime() {
        assert!(vc_runtime());
    }
}

mod ai;
mod analysis;
mod audio;
mod backup;
mod bridge;
mod db;
mod dupes;
mod kind;
mod mcp;
mod meaning;
mod scan;
mod tagging;
mod thumbs;
mod watch;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use db::{Asset, Collection, Root};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub(crate) thumbs_dir: PathBuf,
    previews_dir: PathBuf,
    drag_icon: PathBuf,
    thumb_permits: tokio::sync::Semaphore,
    watchers: Mutex<HashMap<i64, watch::Watcher>>,
    scanning: Mutex<HashSet<i64>>,
    /// Number of the last `assets-delta` sent. Only changed with the db lock held, so it matches what's committed.
    seq: AtomicU64,
    data_dir: PathBuf,
    /// How restoring a backup at launch went, until the frontend asks.
    restored: Mutex<Option<Result<(), String>>>,
}

impl AppState {
    fn db_path(&self) -> PathBuf {
        self.data_dir.join("asset-den.db")
    }
    fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }
    fn pending_restore(&self) -> PathBuf {
        self.data_dir.join("restore.db")
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn with_db<T>(state: &AppState, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    f(&state.db.lock().unwrap()).map_err(err)
}

fn asset(state: &AppState, id: i64) -> Result<Asset, String> {
    db::asset(&state.db.lock().unwrap(), id)
}

/// Puts the calling thread at low OS priority, so background work yields the CPU to the UI and on-screen thumbnails.
/// Only for threads that end with their work (Linux can't raise it back, so a reused pool thread would stay slow), and
/// that don't hold the db lock (a waiting UI command would wait on a thread that rarely gets the CPU).
pub(crate) fn low_priority() {
    if let Err(e) = thread_priority::set_current_thread_priority(thread_priority::ThreadPriority::Min) {
        eprintln!("thread priority: {e:?}");
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    root_id: i64,
    count: usize,
    done: bool,
    /// The root folder couldn't be read (an unplugged drive, a renamed folder), so its assets were kept as they were.
    missing: bool,
}

/// Changed or added rows and removed ids, numbered so the UI can tell when it missed one and must reload.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AssetsDelta {
    seq: u64,
    upserted: Vec<Asset>,
    removed: Vec<i64>,
}

/// Sends the UI the current state of the rows in `touched`. Call with the db lock held (`conn`), so deltas are numbered
/// and sent in commit order. Emitting only queues the event, so it doesn't hold the lock for long.
pub(crate) fn emit_delta(app: &AppHandle, conn: &Connection, touched: &[i64]) {
    if touched.is_empty() {
        return;
    }
    // On error the number is still used up: the UI sees the gap and reloads everything.
    let seq = app.state::<AppState>().seq.fetch_add(1, Ordering::SeqCst) + 1;
    match db::delta(conn, touched) {
        Ok((upserted, removed)) => {
            let _ = app.emit("assets-delta", AssetsDelta { seq, upserted, removed });
        }
        Err(e) => eprintln!("delta: {e}"),
    }
}

/// Rescans a root on a worker thread, reporting progress. Skips if that root is already being scanned.
fn spawn_scan(app: AppHandle, root: Root) {
    if app.state::<AppState>().scanning.lock().unwrap().insert(root.id) {
        run_scan(app, root);
    }
}

/// The scan itself, for a caller that holds the root's scan slot; frees the slot when it's done.
fn run_scan(app: AppHandle, root: Root) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let progress = |count, done, missing| {
            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    root_id: root.id,
                    count,
                    done,
                    missing,
                },
            );
        };
        // Commits in batches and sends each batch's changes, so the UI shows (and thumbnails) assets while it runs.
        let mut changed = Vec::new();
        let result = scan::scan_root(&state.db, root.id, Path::new(&root.path), |conn, n, touched| {
            emit_delta(&app, conn, touched);
            changed.extend_from_slice(touched);
            progress(n, false, false);
        });
        state.scanning.lock().unwrap().remove(&root.id);
        let scanned = result.unwrap_or_else(|e| {
            eprintln!("scan {}: {e}", root.path);
            Some(0)
        });
        progress(scanned.unwrap_or(0), true, scanned.is_none());
        let _ = app.emit("assets-changed", root.id);
        analysis::changed(&app, &changed);
        meaning::changed(&app, &changed);
    });
}

/// Lets the webview load files under `path`, and watches it for changes.
fn activate_root(app: &AppHandle, root: &Root) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(&root.path, true) {
        eprintln!("asset scope {}: {e}", root.path);
    }
    // Starting a watcher walks the whole tree (file-ID cache), which takes seconds on big folders: do it off-thread.
    let (app, root) = (app.clone(), root.clone());
    tauri::async_runtime::spawn_blocking(
        move || match watch::start(app.clone(), root.id, PathBuf::from(&root.path)) {
            Ok(w) => {
                let state = app.state::<AppState>();
                // The folder may have been removed while the watcher was starting.
                if with_db(&state, |c| db::root(c, root.id)).is_ok() {
                    state.watchers.lock().unwrap().insert(root.id, w);
                }
            }
            Err(e) => eprintln!("watch {}: {e}", root.path),
        },
    );
}

/// Lowercased on Windows and macOS, where paths are usually case-insensitive.
fn path_key(p: &str) -> PathBuf {
    let p = p.trim_end_matches(['/', '\\']);
    if cfg!(any(windows, target_os = "macos")) {
        PathBuf::from(p.to_lowercase())
    } else {
        PathBuf::from(p)
    }
}

/// Whether one folder is the other or inside it.
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (path_key(a), path_key(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// Refuses `path` when it holds, or is inside, one of the app's `own` folders (data, cache): indexing its database and
/// caches would never settle, as each commit changes a file it watches.
fn not_own_folder(path: &str, own: [&Path; 2]) -> Result<(), String> {
    for own in own {
        if overlaps(path, &own.to_string_lossy()) {
            return Err(format!(
                "{path} overlaps the folder where Mimikit keeps its own data ({}). Choose the folder your assets are in instead.",
                own.display()
            ));
        }
    }
    Ok(())
}

/// The user's ignored folder names, plus the app's data and cache folders (both named after its identifier), so a
/// library folder added before root_path refused ones holding them doesn't index them.
fn ignore_folders(names: &[String], data_dir: &Path) {
    let own = data_dir.file_name().map(|n| n.to_string_lossy().into_owned());
    kind::set_extra_ignored(&[names, own.as_slice()].concat());
}

// Off the main thread, and the check below without the db lock: an offline network share can take seconds to answer.
#[tauri::command(async)]
fn list_roots(state: State<'_, AppState>) -> Result<Vec<Root>, String> {
    let mut roots = with_db(&state, db::roots)?;
    // A missing root's startup scan ends before the UI listens for scan-progress.
    for r in &mut roots {
        r.missing = !Path::new(&r.path).is_dir();
    }
    Ok(roots)
}

/// Checks `path` can be a library folder and returns it tidied. `except` is the root being relinked, which may overlap
/// its own old path.
fn root_path(state: &AppState, path: &str, except: Option<i64>) -> Result<String, String> {
    let dir = Path::new(path);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err(format!("{path} is not a folder."));
    }
    not_own_folder(
        path,
        [&state.data_dir, state.thumbs_dir.parent().unwrap_or(&state.thumbs_dir)],
    )?;
    for r in with_db(state, db::roots)? {
        if Some(r.id) != except && overlaps(path, &r.path) {
            return Err(format!(
                "{path} overlaps a folder that's already in the library ({}).",
                r.path
            ));
        }
    }
    let path = path.trim_end_matches(['/', '\\']).to_string();
    Ok(if path.ends_with(':') { format!("{path}\\") } else { path }) // keep drive roots valid
}

#[tauri::command]
fn add_root(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Root, String> {
    let path = root_path(&state, &path, None)?;
    let root = with_db(&state, |c| {
        c.execute("INSERT INTO roots (path) VALUES (?1)", [&path])?;
        Ok(Root {
            id: c.last_insert_rowid(),
            path: path.clone(),
            missing: false,
        })
    })?;
    activate_root(&app, &root);
    spawn_scan(app, root.clone());
    Ok(root)
}

/// Forgets a folder. Only the library entry goes; the files are never touched.
#[tauri::command]
fn remove_root(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.watchers.lock().unwrap().remove(&id);
    with_db(&state, |c| {
        c.execute("DELETE FROM roots WHERE id = ?1", [id])?;
        // Its assets leave the counts Settings shows, as a scan's would.
        analysis::emit_status(&app, c);
        meaning::emit_status(&app, c);
        Ok(())
    })
}

#[tauri::command]
fn rescan(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    // Takes the scan slot before reading the path, so a relink can't change it in between. Already scanning: that scan
    // covers it.
    if !state.scanning.lock().unwrap().insert(id) {
        return Ok(());
    }
    let root = with_db(&state, |c| db::root(c, id)).inspect_err(|_| {
        state.scanning.lock().unwrap().remove(&id);
    })?;
    // A folder that couldn't be reached at startup has no watcher yet.
    if !state.watchers.lock().unwrap().contains_key(&id) {
        activate_root(&app, &root);
    }
    run_scan(app, root);
    Ok(())
}

#[derive(Serialize)]
struct RelinkCheck {
    found: usize,
    checked: usize,
}

/// How many of a root's files (a random sample) are at `path`, so the UI can warn before a relink whose rescan would
/// drop the rest along with their tags.
#[tauri::command(async)]
fn check_relink(state: State<'_, AppState>, id: i64, path: String) -> Result<RelinkCheck, String> {
    let dir = PathBuf::from(root_path(&state, &path, Some(id))?);
    let rels: Vec<String> = with_db(&state, |c| {
        c.prepare("SELECT rel_path FROM assets WHERE root_id = ?1 ORDER BY random() LIMIT 200")?
            .query_map([id], |r| r.get(0))?
            .collect()
    })?;
    let found = rels.iter().filter(|r| dir.join(r.as_str()).is_file()).count();
    Ok(RelinkCheck {
        found,
        checked: rels.len(),
    })
}

/// Points a root at the folder it moved to. Assets keep their ids, so tags, ratings, notes and collections stay; the
/// rescan then sweeps the files that aren't there.
#[tauri::command(async)]
fn relink_root(app: AppHandle, state: State<'_, AppState>, id: i64, path: String) -> Result<Root, String> {
    // Holds the scan slot from before the path changes until the new scan starts: a running scan would carry on in
    // the old place, and one starting meanwhile could read the old path.
    if !state.scanning.lock().unwrap().insert(id) {
        return Err("This folder is being scanned. Try again when it's done.".into());
    }
    let relinked = root_path(&state, &path, Some(id)).and_then(|path| {
        with_db(&state, |c| {
            c.execute("UPDATE roots SET path = ?1 WHERE id = ?2", rusqlite::params![path, id])?;
            db::root(c, id)
        })
    });
    let root = relinked.inspect_err(|_| {
        state.scanning.lock().unwrap().remove(&id);
    })?;
    state.watchers.lock().unwrap().remove(&id);
    activate_root(&app, &root);
    run_scan(app, root.clone());
    Ok(root)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetList {
    /// The last delta these rows include; the UI applies only later ones.
    seq: u64,
    assets: Vec<Asset>,
}

#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<AssetList, String> {
    with_db(&state, |c| {
        Ok(AssetList {
            seq: state.seq.load(Ordering::SeqCst),
            assets: db::assets(c, None)?,
        })
    })
}

/// Cached thumbnail path, generated on first request. None for kinds the backend can't draw (the UI uses an icon,
/// or renders and saves one itself for 3D models). An image shown this way gets analysed from its thumbnail too.
#[tauri::command]
async fn thumbnail(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<Option<String>, String> {
    let a = asset(&state, id)?;
    let out = state.thumbs_dir.join(thumbs::cache_name(&a.path, a.size, a.mtime));
    if !out.exists() {
        if a.kind != "image" || !kind::decodable(&a.ext) {
            return Ok(None);
        }
        let _permit = state.thumb_permits.acquire().await.map_err(err)?;
        let (path, ext, out) = (a.path.clone(), a.ext.clone(), out.clone());
        tauri::async_runtime::spawn_blocking(move || thumbs::thumbnail(Path::new(&path), &ext, &out))
            .await
            .map_err(err)??;
    }
    analysis::viewed(&app, &a);
    Ok(Some(out.display().to_string()))
}

/// Stores a thumbnail the frontend rendered from the file version `size`/`mtime`; refused if the file changed since.
#[tauri::command]
fn save_thumbnail(state: State<'_, AppState>, id: i64, size: i64, mtime: i64, png: Vec<u8>) -> Result<String, String> {
    let a = asset(&state, id)?;
    let out = state
        .thumbs_dir
        .join(thumbs::rendered_name(&a.path, (a.size, a.mtime), (size, mtime))?);
    thumbs::save_png(&png, &out)?;
    Ok(out.display().to_string())
}

/// Stores a font's sample line the frontend drew from the file version `size`/`mtime`, for Suggest tags to send.
#[tauri::command]
fn save_font_sample(state: State<'_, AppState>, id: i64, size: i64, mtime: i64, png: Vec<u8>) -> Result<(), String> {
    let a = asset(&state, id)?;
    thumbs::rendered_name(&a.path, (a.size, a.mtime), (size, mtime))?;
    thumbs::save_png(&png, &state.thumbs_dir.join(thumbs::sample_name(&a.path, size, mtime)))
}

/// Full-size PNG for image formats the webview can't display (TGA, PSD, TIFF).
#[tauri::command]
async fn preview(state: State<'_, AppState>, id: i64) -> Result<String, String> {
    let a = asset(&state, id)?;
    if !kind::decodable(&a.ext) {
        return Err("No preview for this file type".into());
    }
    let out = state.previews_dir.join(thumbs::cache_name(&a.path, a.size, a.mtime));
    if out.exists() {
        return Ok(out.display().to_string());
    }
    let _permit = state.thumb_permits.acquire().await.map_err(err)?;
    let made = tauri::async_runtime::spawn_blocking(move || thumbs::preview(Path::new(&a.path), &a.ext, &out))
        .await
        .map_err(err)??;
    Ok(made.display().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextPreview {
    pub(crate) text: String,
    truncated: bool,
}

const TEXT_LIMIT: u64 = 1024 * 1024;

pub(crate) fn read_capped(path: &Path, limit: u64) -> Result<TextPreview, String> {
    let file = std::fs::File::open(path).map_err(err)?;
    let mut buf = Vec::new();
    file.take(limit + 1).read_to_end(&mut buf).map_err(err)?;
    let truncated = buf.len() as u64 > limit;
    buf.truncate(limit as usize);
    Ok(TextPreview {
        text: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

#[tauri::command]
fn read_text(state: State<'_, AppState>, id: i64) -> Result<TextPreview, String> {
    read_capped(Path::new(&asset(&state, id)?.path), TEXT_LIMIT)
}

#[tauri::command]
fn set_favorite(state: State<'_, AppState>, ids: Vec<i64>, favorite: bool) -> Result<(), String> {
    with_db(&state, |c| db::set_favorite(c, &ids, favorite))
}

#[tauri::command]
fn set_rating(state: State<'_, AppState>, ids: Vec<i64>, rating: u8) -> Result<(), String> {
    db::set_rating(&state.db.lock().unwrap(), &ids, rating)
}

#[tauri::command]
fn list_notes(state: State<'_, AppState>) -> Result<HashMap<i64, String>, String> {
    with_db(&state, db::notes)
}

/// Returns the note as stored (trimmed; null when cleared).
#[tauri::command]
fn set_note(state: State<'_, AppState>, id: i64, note: String) -> Result<Option<String>, String> {
    db::set_note(&state.db.lock().unwrap(), id, &note)
}

#[tauri::command]
fn add_tag(state: State<'_, AppState>, ids: Vec<i64>, tag: String) -> Result<String, String> {
    let tag = db::clean_tag(&tag)?;
    with_db(&state, |c| db::add_tag(c, &ids, &tag))?;
    Ok(tag)
}

#[tauri::command]
fn remove_tag(state: State<'_, AppState>, ids: Vec<i64>, tag: String) -> Result<(), String> {
    with_db(&state, |c| db::remove_tag(c, &ids, &tag))
}

#[tauri::command]
fn get_sprite_sheet(state: State<'_, AppState>, id: i64) -> Result<Option<db::SpriteSheet>, String> {
    with_db(&state, |c| db::sprite_sheet(c, id))
}

#[tauri::command]
fn set_sprite_sheet(state: State<'_, AppState>, id: i64, sheet: db::SpriteSheet) -> Result<(), String> {
    db::set_sprite_sheet(&state.db.lock().unwrap(), id, sheet)
}

#[tauri::command]
fn list_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    with_db(&state, db::collections)
}

/// A plain collection, or a smart one when `rule` is given.
#[tauri::command]
fn create_collection(state: State<'_, AppState>, name: String, rule: Option<db::Rule>) -> Result<i64, String> {
    db::create_collection(&state.db.lock().unwrap(), &name, rule.as_ref())
}

#[tauri::command]
fn set_collection_rule(state: State<'_, AppState>, id: i64, rule: db::Rule) -> Result<(), String> {
    db::set_rule(&state.db.lock().unwrap(), id, &rule)
}

#[tauri::command]
fn delete_collection(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    with_db(&state, |c| {
        c.execute("DELETE FROM collections WHERE id = ?1", [id]).map(|_| ())
    })
}

#[tauri::command]
fn set_in_collection(state: State<'_, AppState>, collection: i64, ids: Vec<i64>, member: bool) -> Result<(), String> {
    with_db(&state, |c| db::set_in_collection(c, collection, &ids, member))
}

#[tauri::command]
async fn find_duplicates(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<dupes::DupGroup>, String> {
    // One check hashes at a time: overlapping ones (launch starts one per root) would read the same files again.
    static HASHING: Mutex<()> = Mutex::new(());
    // Hashes off the lock and stores in batches, so a big first check doesn't block scans and UI commands.
    tauri::async_runtime::spawn_blocking(move || {
        let _one = HASHING.lock().unwrap_or_else(|e| e.into_inner());
        let db = &app.state::<AppState>().db;
        let todo = dupes::unhashed(&db.lock().unwrap())?;
        dupes::hash_and_store(db, &todo)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    with_db(&state, dupes::groups)
}

/// Dominant colours of every analysed image, for search by colour. Later ones arrive with `image-features` events.
#[tauri::command]
fn image_colors(state: State<'_, AppState>) -> Result<Vec<(i64, Vec<analysis::Swatch>)>, String> {
    with_db(&state, analysis::colors)
}

/// Images that look like `id`, closest first: their difference hashes differ in at most `max_distance` of 64 bits.
/// Only analysed images can match; `id` itself is analysed first if it isn't yet.
#[tauri::command]
async fn find_similar(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    max_distance: u32,
) -> Result<Vec<i64>, String> {
    let hash = match with_db(&state, |c| analysis::dhash_of(c, id))? {
        Some(h) => h,
        None => {
            let a = asset(&state, id)?;
            if a.kind != "image" || !kind::decodable(&a.ext) {
                return Err("Find similar works on PNG, JPEG, GIF, WebP, BMP, TGA, PSD, TIFF and ICO images.".into());
            }
            let thumb = state.thumbs_dir.join(thumbs::cache_name(&a.path, a.size, a.mtime));
            let _permit = state.thumb_permits.acquire().await.map_err(err)?;
            let (path, ext) = (a.path.clone(), a.ext.clone());
            let f = tauri::async_runtime::spawn_blocking(move || analysis::features(Path::new(&path), &ext, &thumb))
                .await
                .map_err(err)?
                .map_err(|e| format!("Couldn't read {}: {e}", a.name))?;
            let hash = f.dhash;
            with_db(&state, |c| {
                analysis::store(c, &[(a.id, a.size, a.mtime, Some(f))])?;
                analysis::emit_status(&app, c);
                Ok(())
            })?;
            hash
        }
    };
    with_db(&state, |c| analysis::similar(c, id, hash, max_distance))
}

/// How many images are analysed, and the pass's state. Changes come as `analysis-status` events.
#[tauri::command]
fn analysis_status(state: State<'_, AppState>) -> Result<analysis::Status, String> {
    with_db(&state, analysis::status)
}

/// "Analyse images": analyses every image that isn't yet on low-priority threads, or resumes a paused pass.
#[tauri::command]
fn analyse_images(app: AppHandle) {
    analysis::start(&app);
}

#[tauri::command]
fn pause_analysis(app: AppHandle, paused: bool) {
    analysis::pause(&app, paused);
}

/// Stops the pass. What it analysed so far is kept.
#[tauri::command]
fn cancel_analysis(app: AppHandle) {
    analysis::cancel(&app);
}

#[tauri::command]
fn set_keep_analysed(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<(), String> {
    with_db(&state, |c| {
        analysis::set_keep(c, on)?;
        analysis::emit_status(&app, c);
        Ok(())
    })
}

/// "Not duplicates" / "Keep both": hides a group until it's un-ignored.
#[tauri::command]
fn set_duplicate_ignored(state: State<'_, AppState>, hash: String, ignored: bool) -> Result<(), String> {
    with_db(&state, |c| dupes::set_ignored(c, &hash, ignored))
}

/// The one command that changes files: moves copies of `keep` to the OS trash (restorable there), after
/// re-checking byte for byte that they are still identical, and moves their tags, favorite and collections to `keep`.
#[tauri::command]
async fn trash_duplicates(state: State<'_, AppState>, keep: i64, remove: Vec<i64>) -> Result<usize, String> {
    let kept = asset(&state, keep)?;
    let mut copies = remove
        .iter()
        .map(|id| asset(&state, *id))
        .collect::<Result<Vec<_>, _>>()?;
    let paths: Vec<(i64, PathBuf)> = copies.iter().map(|a| (a.id, PathBuf::from(&a.path))).collect();
    let keep_path = PathBuf::from(&kept.path);
    let ids = tauri::async_runtime::spawn_blocking(move || dupes::trashable((keep, &keep_path), &paths))
        .await
        .map_err(err)??;
    copies.retain(|a| ids.contains(&a.id));
    let mut done = 0;
    for copy in &copies {
        trash::delete(&copy.path).map_err(|e| format!("Couldn't move {} to the trash: {e}", copy.name))?;
        with_db(&state, |c| dupes::merge_and_forget(c, keep, copy.id))?;
        done += 1;
    }
    Ok(done)
}

#[tauri::command]
fn rename_collection(state: State<'_, AppState>, id: i64, name: String) -> Result<String, String> {
    db::rename_collection(&state.db.lock().unwrap(), id, &name)
}

/// `dir/name`, or `dir/stem (2).ext` and so on if that's taken, so copies never overwrite anything.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (1..)
        .map(|n| {
            if n == 1 {
                dir.join(name)
            } else {
                dir.join(format!("{stem} ({n}){ext}"))
            }
        })
        .find(|c| !c.exists())
        .unwrap()
}

fn copy_into(files: &[Asset], dest: &Path) -> (usize, Vec<String>) {
    let mut failed = Vec::new();
    let mut copied = 0;
    for a in files {
        let target = free_path(dest, &a.name);
        let r = std::fs::File::open(&a.path).and_then(|mut src| {
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
            std::io::copy(&mut src, &mut out)
        });
        match r {
            Ok(_) => copied += 1,
            Err(e) => failed.push(format!("{}: {e}", a.name)),
        }
    }
    (copied, failed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyResult {
    copied: usize,
    failed: Vec<String>,
}

/// Copies a collection's files (`ids`: the UI knows a smart collection's members) into `dest`. Originals are only read;
/// existing files in `dest` are never replaced.
#[tauri::command]
async fn copy_collection(state: State<'_, AppState>, ids: Vec<i64>, dest: String) -> Result<CopyResult, String> {
    let dest = PathBuf::from(dest);
    if !dest.is_dir() {
        return Err(format!("{} is not a folder.", dest.display()));
    }
    let files = with_db(&state, |c| db::assets(c, Some(&ids)))?;
    let (copied, failed) = tauri::async_runtime::spawn_blocking(move || copy_into(&files, &dest))
        .await
        .map_err(err)?;
    Ok(CopyResult { copied, failed })
}

/// Writes each cell of a `cols`×`rows` grid over `img` to `dest` as `<stem>_000.png`, `<stem>_001.png`… in reading
/// order. Frames are floor(width / cols) × floor(height / rows), as in the sprite view, so a remainder is dropped.
/// With `skip_empty`, fully transparent frames are left out (the others keep their numbers). Never replaces a file.
/// Returns the files written and the frames that failed.
fn write_frames(
    img: &image::DynamicImage,
    stem: &str,
    cols: u32,
    rows: u32,
    skip_empty: bool,
    dest: &Path,
) -> (Vec<PathBuf>, Vec<String>) {
    let (fw, fh) = (img.width() / cols, img.height() / rows);
    let digits = (cols * rows - 1).max(1).ilog10() as usize + 1;
    let mut failed = Vec::new();
    let mut written = Vec::new();
    for i in 0..cols * rows {
        let frame = img.crop_imm((i % cols) * fw, (i / cols) * fh, fw, fh);
        if skip_empty && frame.to_rgba8().pixels().all(|p| p[3] == 0) {
            continue;
        }
        let name = format!("{stem}_{i:0w$}.png", w = digits.max(3));
        let target = free_path(dest, &name);
        let r = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(err)
            .and_then(|f| {
                frame
                    .write_to(&mut std::io::BufWriter::new(f), image::ImageFormat::Png)
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&target); // our own half-written file
                        err(e)
                    })
            });
        match r {
            Ok(()) => written.push(target),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }
    (written, failed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    written: usize,
    failed: Vec<String>,
    /// The first frame written, to show in the file manager.
    first: Option<String>,
}

/// Saves each frame of a sprite sheet as its own PNG in `dest`, cut from the original file (not the size-capped
/// preview). The original is only read.
#[tauri::command]
async fn export_frames(
    state: State<'_, AppState>,
    id: i64,
    cols: u32,
    rows: u32,
    skip_empty: bool,
    dest: String,
) -> Result<ExportResult, String> {
    let a = asset(&state, id)?;
    if !kind::decodable(&a.ext) {
        return Err(format!("Mimikit can't cut frames from .{} files.", a.ext));
    }
    let dest = PathBuf::from(dest);
    if !dest.is_dir() {
        return Err(format!("{} is not a folder.", dest.display()));
    }
    let _permit = state.thumb_permits.acquire().await.map_err(err)?;
    let (written, failed) = tauri::async_runtime::spawn_blocking(move || {
        let img = thumbs::decode(Path::new(&a.path), &a.ext)?;
        if cols == 0 || rows == 0 || cols > img.width() || rows > img.height() {
            return Err(format!(
                "A {cols}×{rows} grid doesn't fit this {}×{} image.",
                img.width(),
                img.height()
            ));
        }
        let stem = Path::new(&a.name)
            .file_stem()
            .map_or("frame".into(), |s| s.to_string_lossy().into_owned());
        Ok(write_frames(&img, &stem, cols, rows, skip_empty, &dest))
    })
    .await
    .map_err(err)??;
    Ok(ExportResult {
        written: written.len(),
        failed,
        first: written.first().map(|p| p.display().to_string()),
    })
}

/// Shows a file or folder in the system file manager (selected in its parent). Never opens or runs it.
#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("{path} no longer exists."));
    }
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
fn reveal(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    app.opener().reveal_item_in_dir(asset(&state, id)?.path).map_err(err)
}

/// Opens in the default app. Refused for unknown file types, which could be programs or scripts.
#[tauri::command]
fn open_default(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let a = asset(&state, id)?;
    if a.kind == "other" {
        return Err("Mimikit only opens known asset types. Use Show in folder instead.".into());
    }
    app.opener().open_path(a.path, None::<&str>).map_err(err)
}

/// Whether this install can update itself from the feed: Windows x64, macOS (one universal build) and the Linux
/// AppImage. Anything else would get a missing-platform error on every check, so it doesn't check at all.
#[tauri::command]
fn app_updates_supported() -> bool {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        // AppImages set APPIMAGE to their own path; a .deb install is the package manager's to update.
        return std::env::var_os("APPIMAGE").is_some();
    }
    cfg!(any(
        all(target_os = "windows", target_arch = "x86_64"),
        target_os = "macos"
    ))
}

#[tauri::command]
fn drag_icon(state: State<'_, AppState>) -> String {
    state.drag_icon.display().to_string()
}

#[tauri::command]
fn ignored_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_db(&state, db::ignored_folders)
}

/// Saves the user's ignored folder names. Scans and file events skip them from now on; rows already indexed under
/// them leave the library on the next rescan.
#[tauri::command]
fn set_ignored_folders(state: State<'_, AppState>, names: Vec<String>) -> Result<Vec<String>, String> {
    let names = db::set_ignored_folders(&state.db.lock().unwrap(), &names)?;
    ignore_folders(&names, &state.data_dir);
    Ok(names)
}

/// Total size of the files directly in `dirs`.
fn files_size(dirs: &[PathBuf]) -> u64 {
    dirs.iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .filter_map(|e| e.ok()?.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Deletes the files directly in `dirs`, keeping the folders and anything inside subfolders.
fn delete_files(dirs: &[PathBuf]) -> std::io::Result<()> {
    for d in dirs {
        for e in std::fs::read_dir(d)? {
            let e = e?;
            if e.file_type()?.is_file() {
                match std::fs::remove_file(e.path()) {
                    Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err),
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

/// Bytes used by the app's own thumbnail and preview caches.
#[tauri::command]
async fn cache_size(state: State<'_, AppState>) -> Result<u64, String> {
    let dirs = [state.thumbs_dir.clone(), state.previews_dir.clone()];
    tauri::async_runtime::spawn_blocking(move || files_size(&dirs))
        .await
        .map_err(err)
}

/// Empties the app's own thumbnail and preview caches; they are rebuilt on demand. Never touches asset files.
#[tauri::command]
async fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<(), String> {
    let dirs = [state.thumbs_dir.clone(), state.previews_dir.clone()];
    tauri::async_runtime::spawn_blocking(move || delete_files(&dirs))
        .await
        .map_err(err)?
        .map_err(|e| format!("Couldn't clear the thumbnail cache: {e}"))
}

/// Saves a copy of the library (tags, ratings, notes, collections, sprite grids, settings) into `dest`. Returns its path.
#[tauri::command]
async fn backup_library(state: State<'_, AppState>, dest: String) -> Result<String, String> {
    let db = state.db_path();
    tauri::async_runtime::spawn_blocking(move || backup::backup_to(&db, Path::new(&dest)))
        .await
        .map_err(err)?
        .map(|p| p.display().to_string())
}

/// Where the automatic backups, and the copies saved before a restore, are kept.
#[tauri::command]
fn backups_folder(state: State<'_, AppState>) -> String {
    state.backups_dir().display().to_string()
}

/// Checks `path` is a library backup, then restarts to swap it in before anything else opens the database.
#[tauri::command]
async fn restore_library(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let pending = state.pending_restore();
    tauri::async_runtime::spawn_blocking(move || backup::stage(Path::new(&path), &pending))
        .await
        .map_err(err)??;
    app.restart()
}

/// Whether this launch restored a backup. Answers once.
#[tauri::command]
fn restore_result(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .restored
        .lock()
        .unwrap()
        .take()
        .map(|r| r.map(|()| true))
        .unwrap_or(Ok(false))
}

/// Opens one of the app's web pages in the browser: a fixed list, so the webview can't open arbitrary URLs.
#[tauri::command]
fn open_link(app: AppHandle, link: String) -> Result<(), String> {
    let url = match link.as_str() {
        "releases" => "https://github.com/sanchezrobertodev/mimikit/releases",
        "source" => "https://github.com/sanchezrobertodev/mimikit",
        "ko-fi" => "https://ko-fi.com/sanchezrobertodev",
        "anthropic-keys" => "https://platform.claude.com/settings/keys",
        "vc-redist" => "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist",
        _ => return Err(format!("Unknown link {link}.")),
    };
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// The app's config and embedded window files, built once for `run` and `mcp`.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

/// `mimikit mcp`: serves an agent app on stdio, relaying its tool calls to the running Mimikit (mcp.rs).
pub fn mcp() {
    // The folder Tauri's app_data_dir() is, which the relay can't ask Tauri for without starting an app.
    let Some(dir) = dirs::data_dir().map(|d| d.join(&context().config().identifier)) else {
        eprintln!("mimikit mcp: no data folder");
        std::process::exit(1);
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build();
    if let Err(e) = runtime.map_err(Into::into).and_then(|r| r.block_on(mcp::serve(dir))) {
        eprintln!("mimikit mcp: {e}");
        std::process::exit(1);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(bridge::Bridge::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            let thumbs_dir = cache.join("thumbs");
            let previews_dir = cache.join("previews");
            let backups = data.join("backups");
            for d in [&data, &thumbs_dir, &previews_dir, &backups] {
                std::fs::create_dir_all(d)?;
            }
            let drag_icon = cache.join("drag-icon.png");
            if !drag_icon.exists() {
                image::RgbaImage::from_pixel(48, 48, image::Rgba([34, 197, 94, 255])).save(&drag_icon)?;
            }
            app.asset_protocol_scope().allow_directory(&cache, true)?;

            let db_path = data.join("asset-den.db");
            let restored = match backup::apply_pending(&db_path, &data.join("restore.db"), &backups) {
                Ok(false) => None,
                r => Some(r.map(|_| ())),
            };
            let conn = db::open(&db_path)?;
            conn.execute_batch(analysis::SCHEMA)?;
            meaning::open(&conn, &data, matches!(restored, Some(Ok(()))))?;
            let roots = db::roots(&conn)?;
            // Before the catch-up scans below, so they skip the user's ignored folders too.
            ignore_folders(&db::ignored_folders(&conn)?, &data);
            app.manage(AppState {
                db: Mutex::new(conn),
                thumbs_dir,
                previews_dir,
                drag_icon,
                // One decode per core (2 to 8): the frontend only sends what's on screen, so use the CPU for it.
                thumb_permits: tokio::sync::Semaphore::new(
                    std::thread::available_parallelism().map_or(4, |n| n.get().clamp(2, 8)),
                ),
                watchers: Mutex::new(HashMap::new()),
                scanning: Mutex::new(HashSet::new()),
                seq: AtomicU64::new(0),
                data_dir: data,
                restored: Mutex::new(restored),
            });
            std::thread::spawn(move || {
                low_priority();
                if let Err(e) = backup::auto(&db_path, &backups) {
                    eprintln!("Automatic backup failed: {e}");
                }
            });
            // Catch up on anything that changed while the app was closed.
            for root in roots {
                activate_root(app.handle(), &root);
                spawn_scan(app.handle().clone(), root);
            }
            // Batches sent before Mimikit closed are collected now.
            tagging::start(app.handle());
            meaning::resume(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_roots,
            add_root,
            remove_root,
            rescan,
            check_relink,
            relink_root,
            list_assets,
            thumbnail,
            save_thumbnail,
            save_font_sample,
            preview,
            read_text,
            set_favorite,
            set_rating,
            list_notes,
            set_note,
            add_tag,
            remove_tag,
            get_sprite_sheet,
            set_sprite_sheet,
            list_collections,
            create_collection,
            set_collection_rule,
            delete_collection,
            set_in_collection,
            find_duplicates,
            image_colors,
            find_similar,
            analysis_status,
            analyse_images,
            pause_analysis,
            cancel_analysis,
            set_keep_analysed,
            set_duplicate_ignored,
            trash_duplicates,
            rename_collection,
            copy_collection,
            export_frames,
            reveal,
            reveal_path,
            open_default,
            drag_icon,
            app_updates_supported,
            ignored_folders,
            set_ignored_folders,
            cache_size,
            clear_thumbnail_cache,
            backup_library,
            backups_folder,
            restore_library,
            restore_result,
            open_link,
            bridge::set_agent_bridge,
            bridge::agent_reply,
            bridge::relays_alive,
            ai::api_key_status,
            ai::set_api_key,
            ai::remove_api_key,
            ai::ask_search,
            tagging::suggest_tags,
            tagging::tagging_asked,
            tagging::tagging_status,
            tagging::cancel_tagging,
            tagging::accept_suggestions,
            tagging::reject_suggestions,
            tagging::ai_tag_count,
            tagging::remove_ai_tags,
            meaning::meaning_status,
            meaning::meaning_enable,
            meaning::meaning_pause,
            meaning::meaning_cancel,
            meaning::meaning_disable,
            meaning::meaning_scores,
            meaning::meaning_related,
            meaning::meaning_window,
            meaning::meaning_drawn
        ])
        .run(context())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn copies_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let (src, dest) = (dir.path().join("src"), dir.path().join("dest"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(src.join("hero.png"), "new").unwrap();
        std::fs::write(dest.join("hero.png"), "old").unwrap();
        let a = crate::db::Asset {
            id: 1,
            root_id: 1,
            rel_path: "hero.png".into(),
            path: src.join("hero.png").display().to_string(),
            name: "hero.png".into(),
            ext: "png".into(),
            kind: "image".into(),
            size: 3,
            mtime: 0,
            width: None,
            height: None,
            favorite: false,
            tags: vec![],
            suggested: vec![],
            rating: 0,
            duration_ms: None,
            sample_rate: None,
            channels: None,
            bits: None,
        };
        let (copied, failed) = super::copy_into(&[a.clone(), a], &dest);
        assert_eq!((copied, failed.len()), (2, 0));
        assert_eq!(std::fs::read_to_string(dest.join("hero.png")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(dest.join("hero (2).png")).unwrap(), "new");
        assert!(dest.join("hero (3).png").exists());
    }

    #[test]
    fn frames_are_cut_and_never_overwrite() {
        use image::{DynamicImage, Rgba, RgbaImage};
        let dir = tempfile::tempdir().unwrap();
        // 3×2 grid of 10×8 frames plus a 2px / 1px remainder; frame 4 is fully transparent.
        let mut img = RgbaImage::from_pixel(32, 17, Rgba([200, 0, 0, 255]));
        for y in 8..16 {
            for x in 10..20 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
        let img = DynamicImage::ImageRgba8(img);
        std::fs::write(dir.path().join("hero_000.png"), "old").unwrap();

        let (written, failed) = super::write_frames(&img, "hero", 3, 2, false, dir.path());
        assert_eq!((written.len(), failed.len()), (6, 0));
        assert_eq!(written[0], dir.path().join("hero_000 (2).png"));
        assert_eq!(std::fs::read_to_string(dir.path().join("hero_000.png")).unwrap(), "old");
        let first = image::open(dir.path().join("hero_000 (2).png")).unwrap();
        assert_eq!((first.width(), first.height()), (10, 8));
        let empty = image::open(dir.path().join("hero_004.png")).unwrap().to_rgba8();
        assert!(empty.pixels().all(|p| p[3] == 0));

        // Skipping empty frames leaves out frame 4; the rest go next to the first export.
        let (written, _) = super::write_frames(&img, "hero", 3, 2, true, dir.path());
        assert_eq!(written.len(), 5);
        assert!(dir.path().join("hero_005 (2).png").exists() && !dir.path().join("hero_004 (2).png").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 12);

        // Big grids get wider numbers so names sort.
        let (written, _) = super::write_frames(&img, "big", 32, 17, false, dir.path());
        assert_eq!(written.len(), 544);
        assert!(dir.path().join("big_543.png").exists());
        let (written, _) = super::write_frames(&DynamicImage::new_rgba8(100, 20), "wide", 100, 20, false, dir.path());
        assert_eq!(written.len(), 2000);
        assert!(dir.path().join("wide_1999.png").exists() && dir.path().join("wide_0000.png").exists());
    }

    #[test]
    fn clearing_the_cache_only_deletes_its_files() {
        let dir = tempfile::tempdir().unwrap();
        let (thumbs, previews) = (dir.path().join("thumbs"), dir.path().join("previews"));
        std::fs::create_dir_all(thumbs.join("sub")).unwrap();
        std::fs::create_dir_all(&previews).unwrap();
        std::fs::write(thumbs.join("a.png"), "1234").unwrap();
        std::fs::write(thumbs.join("sub/keep.png"), "x").unwrap();
        std::fs::write(previews.join("b.png"), "12").unwrap();
        std::fs::write(dir.path().join("drag-icon.png"), "x").unwrap();
        let dirs = [thumbs.clone(), previews.clone()];
        assert_eq!(super::files_size(&dirs), 6);
        super::delete_files(&dirs).unwrap();
        assert_eq!(super::files_size(&dirs), 0);
        assert!(thumbs.join("sub/keep.png").exists() && dir.path().join("drag-icon.png").exists());
    }

    #[test]
    fn folders_overlap_when_one_holds_the_other() {
        let data = "/home/you/.local/share/dev.sanchezroberto.assetden";
        let own = [
            std::path::Path::new(data),
            std::path::Path::new("/home/you/.cache/dev.sanchezroberto.assetden"),
        ];
        assert!(super::not_own_folder("/home/you", own).is_err());
        assert!(super::not_own_folder("/", own).is_err());
        assert!(super::not_own_folder(&format!("{data}/backups/"), own).is_err());
        assert!(super::not_own_folder("/home/you/.cache/dev.sanchezroberto.assetden/previews", own).is_err());
        assert!(super::not_own_folder("/home/you/Pictures", own).is_ok());
        assert!(super::not_own_folder("/home/you/.local/share/dev.sanchezroberto.assetden2", own).is_ok());
    }

    #[test]
    fn read_text_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.json");
        std::fs::write(&p, "x".repeat(100)).unwrap();
        let t = super::read_capped(&p, 10).unwrap();
        assert_eq!((t.text.len(), t.truncated), (10, true));
        let t = super::read_capped(&p, 100).unwrap();
        assert_eq!((t.text.len(), t.truncated), (100, false));
    }
}

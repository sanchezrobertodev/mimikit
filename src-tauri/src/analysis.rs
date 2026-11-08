//! Image analysis for "Find similar" and search by colour: a 64-bit difference hash and a few dominant colours per
//! image, computed from the cached thumbnail (or the file shrunk to thumbnail size) and kept until the file changes.
//! Nothing runs by itself: images are analysed as their thumbnails are shown, when the user asks for a pass, and, once
//! "keep analysed" is on, when they change. Source files are only read.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use image::{GrayImage, Luma, RgbaImage, imageops::FilterType};
use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use crate::db::{self, Asset, abs_path};
use crate::kind;
use crate::thumbs;

/// Features of one version (size, mtime) of an image. dhash and colors are NULL when it couldn't be decoded, so it isn't
/// retried until the file changes.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS image_features (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  dhash INTEGER,
  colors TEXT
);
";

/// r, g, b and the share of the image's opaque pixels in percent.
pub type Swatch = [u8; 4];

pub struct Features {
    pub dhash: u64,
    pub colors: Vec<Swatch>,
}

/// 64-bit difference hash: the image as 9×8 lightness, one bit per horizontal neighbour pair (set when it gets
/// brighter). Lightness is HSL's (max + min) / 2, which a hue shift doesn't change, so recoloured copies stay close.
/// Transparent pixels count as black, so a sprite keeps its outline against the background.
pub fn dhash(img: &RgbaImage) -> u64 {
    let gray = GrayImage::from_fn(img.width(), img.height(), |x, y| {
        let [r, g, b, a] = img.get_pixel(x, y).0;
        let l = (r.max(g).max(b) as u32 + r.min(g).min(b) as u32) * a as u32 / 510;
        Luma([l as u8])
    });
    let small = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h = h << 1 | u64::from(small.get_pixel(x, y).0[0] < small.get_pixel(x + 1, y).0[0]);
        }
    }
    h
}

fn linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB (0–255) to OKLab, where Euclidean distance follows perceived colour difference.
pub fn oklab(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb.map(|c| linear(c / 255.0));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

const COLORS: usize = 5;

/// Up to [`COLORS`] dominant colours, heaviest first: k-means in OKLab over a 4-bit-per-channel histogram of the
/// opaque pixels (alpha ≥ 128). Colours under 3% of those pixels are dropped.
pub fn dominant_colors(img: &RgbaImage) -> Vec<Swatch> {
    // Per bin: pixel count and sRGB sums.
    let mut bins = vec![(0u32, [0f32; 3]); 4096];
    for p in img.pixels() {
        let [r, g, b, a] = p.0;
        if a < 128 {
            continue;
        }
        let bin = &mut bins[(r as usize >> 4) << 8 | (g as usize >> 4) << 4 | b as usize >> 4];
        bin.0 += 1;
        bin.1[0] += r as f32;
        bin.1[1] += g as f32;
        bin.1[2] += b as f32;
    }
    // (weight, mean sRGB, OKLab), heaviest first.
    let mut points: Vec<(f32, [f32; 3], [f32; 3])> = bins
        .iter()
        .filter(|b| b.0 > 0)
        .map(|&(n, s)| {
            let rgb = s.map(|c| c / n as f32);
            (n as f32, rgb, oklab(rgb))
        })
        .collect();
    let total: f32 = points.iter().map(|p| p.0).sum();
    if total == 0.0 {
        return vec![];
    }
    points.sort_by(|a, b| b.0.total_cmp(&a.0));
    // Start from the heaviest bins that differ visibly from the ones already picked.
    let mut centers: Vec<[f32; 3]> = Vec::new();
    for p in &points {
        if centers.len() == COLORS {
            break;
        }
        if centers.iter().all(|c| dist2(*c, p.2) > 0.08 * 0.08) {
            centers.push(p.2);
        }
    }
    let mut sums = vec![(0f32, [0f32; 3], [0f32; 3]); centers.len()];
    for _ in 0..8 {
        sums.iter_mut().for_each(|s| *s = (0.0, [0.0; 3], [0.0; 3]));
        for (w, rgb, lab) in &points {
            let k = (0..centers.len())
                .min_by(|&i, &j| dist2(centers[i], *lab).total_cmp(&dist2(centers[j], *lab)))
                .unwrap();
            let s = &mut sums[k];
            s.0 += w;
            for c in 0..3 {
                s.1[c] += w * rgb[c];
                s.2[c] += w * lab[c];
            }
        }
        for (c, s) in centers.iter_mut().zip(&sums) {
            if s.0 > 0.0 {
                *c = s.2.map(|v| v / s.0);
            }
        }
    }
    let mut out: Vec<Swatch> = sums
        .iter()
        .filter(|s| s.0 / total >= 0.03)
        .map(|s| {
            let [r, g, b] = s.1.map(|v| (v / s.0).round().clamp(0.0, 255.0) as u8);
            [r, g, b, (100.0 * s.0 / total).round() as u8]
        })
        .collect();
    out.sort_by(|a, b| b[3].cmp(&a[3]));
    out
}

/// Pixels to analyse: the cached thumbnail when there is one, otherwise the file decoded and shrunk the same way.
pub fn pixels(src: &Path, ext: &str, thumb: &Path) -> std::result::Result<RgbaImage, String> {
    if let Ok(img) = image::open(thumb) {
        return Ok(img.into_rgba8());
    }
    // shortcut: the shrunk copy isn't written to the thumbnail cache, so 91k images don't fill the disk with thumbnails
    // nobody looked at; write it here if scrolling unvisited folders after a pass ever feels slow.
    let img = thumbs::decode(src, ext)?;
    let max = thumbs::THUMB_SIZE;
    let img = if img.width() > max || img.height() > max {
        img.thumbnail(max, max)
    } else {
        img
    };
    Ok(img.into_rgba8())
}

pub fn features(src: &Path, ext: &str, thumb: &Path) -> std::result::Result<Features, String> {
    let img = pixels(src, ext, thumb)?;
    Ok(Features {
        dhash: dhash(&img),
        colors: dominant_colors(&img),
    })
}

/// An image whose features are missing or out of date.
pub struct Todo {
    pub id: i64,
    pub path: PathBuf,
    /// Its library folder.
    pub root: PathBuf,
    pub ext: String,
    pub size: i64,
    pub mtime: i64,
}

impl Todo {
    fn of(a: &Asset) -> Todo {
        let path = PathBuf::from(&a.path);
        Todo {
            id: a.id,
            // The path is the root joined with each part of rel_path (abs_path).
            root: path
                .ancestors()
                .nth(a.rel_path.split('/').count())
                .unwrap_or(&path)
                .into(),
            path,
            ext: a.ext.clone(),
            size: a.size,
            mtime: a.mtime,
        }
    }

    pub fn thumb(&self, thumbs_dir: &Path) -> PathBuf {
        thumbs_dir.join(thumbs::cache_name(
            &self.path.display().to_string(),
            self.size,
            self.mtime,
        ))
    }
}

fn stale_sql(select: &str) -> String {
    let exts = kind::decodable_sql();
    format!(
        "SELECT {select} FROM assets a JOIN roots r ON r.id = a.root_id
         LEFT JOIN image_features f ON f.asset_id = a.id
         WHERE a.kind = 'image' AND a.ext IN ({exts})
           AND (f.asset_id IS NULL OR f.size != a.size OR f.mtime != a.mtime)"
    )
}

pub fn stale(conn: &Connection) -> Result<Vec<Todo>> {
    let mut stmt = conn.prepare(&stale_sql("a.id, r.path, a.rel_path, a.ext, a.size, a.mtime"))?;
    stmt.query_map([], |r| {
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

/// The stale images among `ids` (images that just changed).
pub fn todo(conn: &Connection, ids: &[i64]) -> Result<Vec<Todo>> {
    let ids: HashSet<i64> = ids.iter().copied().collect();
    Ok(stale(conn)?.into_iter().filter(|t| ids.contains(&t.id)).collect())
}

/// Whether this version of the image still needs analysing.
pub fn is_stale(conn: &Connection, a: &Asset) -> Result<bool> {
    conn.query_row(
        "SELECT NOT EXISTS (SELECT 1 FROM image_features WHERE asset_id = ?1 AND size = ?2 AND mtime = ?3)",
        params![a.id, a.size, a.mtime],
        |r| r.get(0),
    )
}

/// Images analysed (including ones that couldn't be read, which aren't retried), and images that can be.
pub fn counts(conn: &Connection) -> Result<(usize, usize)> {
    // shortcut: images of an unplugged drive stay in the total though no pass analyses them, so "Analyse now" does
    // nothing until it's back; leave out the roots list_roots finds missing if people find that confusing.
    let exts = kind::decodable_sql();
    conn.query_row(
        &format!(
            "SELECT count(f.asset_id), count(*) FROM assets a
             LEFT JOIN image_features f ON f.asset_id = a.id AND f.size = a.size AND f.mtime = a.mtime
             WHERE a.kind = 'image' AND a.ext IN ({exts})"
        ),
        [],
        |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as usize)),
    )
}

const KEEP: &str = "keep_analysed";

/// "Keep new and changed images analysed": off until a whole-library pass has finished once, then on unless the user
/// turned it off. Kept in the library, not the UI's prefs, because the catch-up scans at launch need it first.
pub fn keep(conn: &Connection) -> Result<bool> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEEP], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map(|v| v.as_deref() == Some("1"))
}

pub fn set_keep(conn: &Connection, on: bool) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![KEEP, if on { "1" } else { "0" }],
    )
    .map(|_| ())
}

/// After a whole-library pass: "keep analysed" goes on, unless the user already chose.
fn keep_by_default(conn: &Connection) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, '1')", [KEEP])
        .map(|_| ())
}

/// Stores features for the file versions they were computed from. Skipped when the asset is gone or has changed since.
pub fn store(conn: &Connection, rows: &[(i64, i64, i64, Option<Features>)]) -> Result<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO image_features (asset_id, size, mtime, dhash, colors)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?1 AND size = ?2 AND mtime = ?3)
         ON CONFLICT (asset_id) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime, dhash = excluded.dhash, colors = excluded.colors",
    )?;
    for (id, size, mtime, f) in rows {
        let colors = f.as_ref().map(|f| serde_json::to_string(&f.colors).unwrap_or_default());
        stmt.execute(params![id, size, mtime, f.as_ref().map(|f| f.dhash as i64), colors])?;
    }
    Ok(())
}

const FRESH: &str =
    "FROM image_features f JOIN assets a ON a.id = f.asset_id AND a.size = f.size AND a.mtime = f.mtime";

/// Dominant colours of every analysed image.
pub fn colors(conn: &Connection) -> Result<Vec<(i64, Vec<Swatch>)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT f.asset_id, f.colors {FRESH} WHERE f.colors IS NOT NULL"
    ))?;
    stmt.query_map([], |r| {
        let json: String = r.get(1)?;
        Ok((r.get(0)?, serde_json::from_str(&json).unwrap_or_default()))
    })?
    .collect()
}

/// The image's hash, if it's analysed and up to date.
pub fn dhash_of(conn: &Connection, id: i64) -> Result<Option<u64>> {
    conn.query_row(
        &format!("SELECT f.dhash {FRESH} WHERE f.asset_id = ?1 AND f.dhash IS NOT NULL"),
        [id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map(|h| h.map(|h| h as u64))
}

/// Other images within `max` differing bits of `hash`, closest first.
pub fn similar(conn: &Connection, id: i64, hash: u64, max: u32) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT f.asset_id, f.dhash {FRESH} WHERE f.dhash IS NOT NULL AND f.asset_id != ?1"
    ))?;
    let mut hits = Vec::new();
    for row in stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
        let (other, h) = row?;
        let d = (h as u64 ^ hash).count_ones();
        if d <= max {
            hits.push((d, other));
        }
    }
    hits.sort_unstable();
    Ok(hits.into_iter().map(|(_, other)| other).collect())
}

const BATCH: usize = 500;

/// Analyses `todo` [`BATCH`] images at a time on `workers` low-priority threads and stores each batch in one
/// transaction, so the lock is only held for the write. `gate()` runs before each image and its result (a decode permit)
/// is held while that image is read; None stops the work, and what was analysed so far is still stored.
/// `after(conn, colours)` runs after each commit with the lock held.
pub fn analyse_and_store<G>(
    db: &Mutex<Connection>,
    todo: &[Todo],
    workers: usize,
    thumbs_dir: &Path,
    gate: impl Fn() -> Option<G> + Sync,
    mut after: impl FnMut(&Connection, Vec<(i64, Vec<Swatch>)>),
) -> Result<()> {
    for batch in todo.chunks(BATCH) {
        let next = AtomicUsize::new(0);
        let stopped = AtomicBool::new(false);
        let rows: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..workers.max(1))
                .map(|_| {
                    s.spawn(|| {
                        crate::low_priority();
                        let mut out = Vec::new();
                        while let Some(t) = batch.get(next.fetch_add(1, SeqCst)) {
                            let Some(_permit) = gate() else {
                                stopped.store(true, SeqCst);
                                break;
                            };
                            let f = features(&t.path, &t.ext, &t.thumb(thumbs_dir)).ok();
                            // Its drive was unplugged: left stale for when it's back, not stored as unreadable for good.
                            if f.is_none() && !t.root.is_dir() {
                                continue;
                            }
                            out.push((t.id, t.size, t.mtime, f));
                        }
                        out
                    })
                })
                .collect();
            // A worker that panicked stores nothing: its images stay stale, and the pass thread lives on.
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        // Images that couldn't be read get no colours, so a stale palette of an earlier version is dropped too.
        let colours = rows
            .iter()
            .map(|(id, _, _, f)| (*id, f.as_ref().map(|f| f.colors.clone()).unwrap_or_default()))
            .collect();
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        store(&tx, &rows)?;
        tx.commit()?;
        after(&conn, colours);
        drop(conn);
        if stopped.load(SeqCst) {
            break;
        }
        // The mutex isn't fair: without a pause the next batch can re-lock before a waiting command.
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

/// What the UI shows about analysis: sent as `analysis-status` whenever it changes.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Images analysed, including ones that couldn't be read.
    done: usize,
    /// Images that can be analysed.
    total: usize,
    /// A pass the UI shows is running: the user's, or one keeping many changed images analysed.
    running: bool,
    paused: bool,
    /// "Keep new and changed images analysed".
    keep: bool,
}

pub fn status(conn: &Connection) -> Result<Status> {
    let (done, total) = counts(conn)?;
    Ok(Status {
        done,
        total,
        running: PASS.shown.load(SeqCst),
        paused: PASS.paused.load(SeqCst),
        keep: keep(conn)?,
    })
}

pub fn emit_status(app: &AppHandle, conn: &Connection) {
    match status(conn) {
        Ok(s) => {
            let _ = app.emit("analysis-status", s);
        }
        Err(e) => eprintln!("analysis: {e}"),
    }
}

/// Work waiting for a pass thread.
struct Queue {
    /// The whole library: the user asked, or a pass catches up.
    all: bool,
    /// Images that changed while the pass keeps them up to date.
    ids: Vec<i64>,
    /// The pass thread is alive; it takes work until there's none left.
    running: bool,
}

impl Queue {
    /// Queues work; true when the pass thread must be started for it.
    fn add(&mut self, all: bool, ids: &[i64]) -> bool {
        self.all |= all;
        self.ids.extend_from_slice(ids);
        let start = !self.running && (self.all || !self.ids.is_empty());
        self.running |= start;
        start
    }

    /// Queues changed images, only if the pass keeps them up to date (`on`). True when the pass thread must be started.
    fn changed(&mut self, on: bool, ids: &[i64]) -> bool {
        !ids.is_empty() && on && self.add(false, ids)
    }

    /// The next pass: (whole library, changed images). None, and the thread ends, when nothing is queued.
    fn take(&mut self) -> Option<(bool, Vec<i64>)> {
        if !self.all && self.ids.is_empty() {
            self.running = false;
            return None;
        }
        Some((std::mem::take(&mut self.all), std::mem::take(&mut self.ids)))
    }

    fn clear(&mut self) {
        self.all = false;
        self.ids.clear();
    }
}

/// One pass: (whole library, changed images, the Cancel count it started with).
pub type Run = fn(&AppHandle, bool, &[i64], usize);

/// A background pass over the library's images, with its own thread and the user's Pause and Cancel. Image analysis
/// and search by meaning (meaning.rs) each have one.
pub struct Pass {
    queue: Mutex<Queue>,
    /// Bumped by Cancel (with the queue locked): a pass stops once this differs from the value it started with.
    cancels: AtomicUsize,
    pub paused: AtomicBool,
    /// A pass the UI shows is running: the user's, or one keeping many changed images up to date.
    pub shown: AtomicBool,
    run: Run,
}

impl Pass {
    pub const fn new(run: Run) -> Pass {
        Pass {
            queue: Mutex::new(Queue {
                all: false,
                ids: Vec::new(),
                running: false,
            }),
            cancels: AtomicUsize::new(0),
            paused: AtomicBool::new(false),
            shown: AtomicBool::new(false),
            run,
        }
    }

    /// Brings every image up to date, resuming a paused pass.
    pub fn all(&'static self, app: &AppHandle) {
        self.paused.store(false, SeqCst);
        if self.queue.lock().unwrap().add(true, &[]) {
            self.spawn(app);
        }
    }

    /// Images among `ids` that a scan or file events changed, when the pass keeps them up to date (`on`).
    pub fn changed(&'static self, app: &AppHandle, on: bool, ids: &[i64]) {
        if self.queue.lock().unwrap().changed(on, ids) {
            self.spawn(app);
        }
    }

    /// Stops the running pass and drops queued work. Batches already stored stay.
    pub fn cancel(&self) {
        {
            let mut q = self.queue.lock().unwrap();
            q.clear();
            self.cancels.fetch_add(1, SeqCst);
        }
        self.paused.store(false, SeqCst);
    }

    pub fn cancelled(&self, since: usize) -> bool {
        self.cancels.load(SeqCst) != since
    }

    /// Waits for running scans (they add images) and says whether to go on.
    pub fn ready(&self, state: &AppState, since: usize) -> bool {
        while !self.cancelled(since) && !state.scanning.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(200));
        }
        !self.cancelled(since)
    }

    /// Before each image is read: a decode permit, or None once cancelled. At most half the thumbnail permits, so
    /// thumbnails for what's on screen always have the other half. Waits while paused and while scans run.
    pub fn gate<'a>(&self, state: &'a AppState, since: usize) -> Option<tokio::sync::SemaphorePermit<'a>> {
        loop {
            if self.cancelled(since) {
                return None;
            }
            // Scans go first: they hold the lock often and the UI is waiting for them.
            if !self.paused.load(SeqCst) && state.scanning.lock().unwrap().is_empty() {
                if let Ok(permit) = state.thumb_permits.try_acquire() {
                    return Some(permit);
                }
                std::thread::sleep(Duration::from_millis(10));
            } else {
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    fn spawn(&'static self, app: &AppHandle) {
        let app = app.clone();
        // Normal priority: this thread holds the db lock to read and store. Its workers run low.
        std::thread::spawn(move || {
            loop {
                let (work, cancels) = {
                    let mut q = self.queue.lock().unwrap();
                    (q.take(), self.cancels.load(SeqCst))
                };
                let Some((all, ids)) = work else { break };
                (self.run)(&app, all, &ids, cancels);
                self.shown.store(false, SeqCst);
                // A pause that came as the pass ended mustn't hold up the next one, which may have no Resume button.
                self.paused.store(false, SeqCst);
            }
        });
    }
}

/// Workers for a pass's decoding: half the thumbnail permits, at least one.
pub fn workers() -> usize {
    (std::thread::available_parallelism().map_or(4, |n| n.get().clamp(2, 8)) / 2).max(1)
}

static PASS: Pass = Pass::new(|app, all, ids, cancels| {
    if let Err(e) = pass(app, all, ids, cancels) {
        eprintln!("analysis: {e}");
    }
});

/// "Analyse images": brings every image up to date, resuming a paused pass.
pub fn start(app: &AppHandle) {
    PASS.all(app);
    let state = app.state::<AppState>();
    emit_status(app, &state.db.lock().unwrap());
}

pub fn pause(app: &AppHandle, paused: bool) {
    PASS.paused.store(paused, SeqCst);
    let state = app.state::<AppState>();
    emit_status(app, &state.db.lock().unwrap());
}

/// Stops the running pass and drops queued work. Batches already stored stay.
pub fn cancel(app: &AppHandle) {
    PASS.cancel();
    let state = app.state::<AppState>();
    emit_status(app, &state.db.lock().unwrap());
}

/// After a scan or file events changed `ids` (added, modified or removed rows): analyses the images among them if
/// "keep analysed" is on, and tells the UI the new counts either way.
pub fn changed(app: &AppHandle, ids: &[i64]) {
    let state = app.state::<AppState>();
    let conn = state.db.lock().unwrap();
    PASS.changed(app, keep(&conn).unwrap_or(false), ids);
    emit_status(app, &conn);
}

/// Library folders that aren't there (an unplugged drive): a whole-library pass leaves their images out, or it would
/// never end. Checked without the lock: an offline network share can take seconds to answer.
pub fn offline(db: &Mutex<Connection>) -> Result<Vec<PathBuf>> {
    let roots = db::roots(&db.lock().unwrap())?;
    Ok(roots
        .into_iter()
        .map(|r| PathBuf::from(r.path))
        .filter(|p| !p.is_dir())
        .collect())
}

/// A whole-library pass: every stale image, then again for the ones scans or the watcher added or changed meanwhile,
/// until none are left. `ready()` runs before each look at what's stale: it waits for running scans (they add images)
/// and says whether to go on. True when it ended with every image analysed, false when `ready()` stopped it.
pub fn analyse_all<G>(
    db: &Mutex<Connection>,
    workers: usize,
    thumbs_dir: &Path,
    ready: impl Fn() -> bool,
    gate: impl Fn() -> Option<G> + Sync,
    mut after: impl FnMut(&Connection, Vec<(i64, Vec<Swatch>)>),
) -> Result<bool> {
    loop {
        if !ready() {
            return Ok(false);
        }
        let offline = offline(db)?;
        let todo: Vec<_> = stale(&db.lock().unwrap())?
            .into_iter()
            .filter(|t| !offline.contains(&t.root))
            .collect();
        if todo.is_empty() {
            return Ok(true);
        }
        analyse_and_store(db, &todo, workers, thumbs_dir, &gate, &mut after)?;
    }
}

fn pass(app: &AppHandle, all: bool, ids: &[i64], cancels: usize) -> Result<()> {
    let state = app.state::<AppState>();
    let started = Instant::now();
    let workers = workers();
    let gate = || PASS.gate(&state, cancels);
    let mut analysed = 0;
    let after = |conn: &Connection, colors: Vec<(i64, Vec<Swatch>)>| {
        analysed += colors.len();
        let _ = app.emit("image-features", colors);
        emit_status(app, conn);
    };
    if all {
        PASS.shown.store(true, SeqCst);
        emit_status(app, &state.db.lock().unwrap());
        let ready = || PASS.ready(&state, cancels);
        let complete = analyse_all(&state.db, workers, &state.thumbs_dir, ready, gate, after)?;
        if complete {
            keep_by_default(&state.db.lock().unwrap())?;
        }
    } else {
        let todo = todo(&state.db.lock().unwrap(), ids)?;
        if todo.is_empty() {
            return Ok(());
        }
        // A few changed files are done before a progress line could be read; a big new folder gets one, with Pause.
        PASS.shown.store(todo.len() > BATCH, SeqCst);
        emit_status(app, &state.db.lock().unwrap());
        analyse_and_store(&state.db, &todo, workers, &state.thumbs_dir, gate, after)?;
    }
    PASS.shown.store(false, SeqCst);
    emit_status(app, &state.db.lock().unwrap());
    let secs = started.elapsed().as_secs_f32();
    eprintln!(
        "analysis: {analysed} images in {secs:.1}s ({:.0}/s, {workers} workers)",
        analysed as f32 / secs
    );
    Ok(())
}

static VIEWED: OnceLock<SyncSender<Todo>> = OnceLock::new();

/// Analyses an image whose thumbnail the UI just got, from that thumbnail (small, so cheap), unless it's up to date.
/// One thread does them in the order they come; when fast scrolling outruns it, the rest are left for a pass.
pub fn viewed(app: &AppHandle, a: &Asset) {
    if a.kind != "image" || !kind::decodable(&a.ext) {
        return;
    }
    let state = app.state::<AppState>();
    if !is_stale(&state.db.lock().unwrap(), a).unwrap_or(false) {
        return;
    }
    let queue = VIEWED.get_or_init(|| {
        let (tx, rx) = sync_channel::<Todo>(1000);
        let app = app.clone();
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            while let Ok(first) = rx.recv() {
                // Thumbnails arrive a screenful at a time: one write and one status update for all of them.
                std::thread::sleep(Duration::from_millis(250));
                let batch: Vec<Todo> = std::iter::once(first).chain(rx.try_iter()).collect();
                let r = analyse_and_store(
                    &state.db,
                    &batch,
                    1,
                    &state.thumbs_dir,
                    || Some(()),
                    |conn, colors| {
                        let _ = app.emit("image-features", colors);
                        emit_status(&app, conn);
                    },
                );
                if let Err(e) = r {
                    eprintln!("analysis: {e}");
                }
            }
        });
        tx
    });
    let _ = queue.try_send(Todo::of(a));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, scan};
    use image::{Rgba, imageops};

    /// A picture with structure: a diagonal gradient, a disc and two bars.
    fn scene(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            if (u - 0.35).powi(2) + (v - 0.45).powi(2) < 0.04 {
                Rgba([220, 60, 40, 255])
            } else if (0.6..0.7).contains(&u) || (0.75..0.85).contains(&v) {
                Rgba([30, 40, 160, 255])
            } else {
                let g = (255.0 * (u + v) / 2.0) as u8;
                Rgba([g, g / 2 + 60, 255 - g, 255])
            }
        })
    }

    /// A different picture: checkerboard of large cells.
    fn other(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            if (x * 5 / w + y * 3 / h).is_multiple_of(2) {
                Rgba([240, 240, 240, 255])
            } else {
                Rgba([20, 20, 20, 255])
            }
        })
    }

    fn d(a: &RgbaImage, b: &RgbaImage) -> u32 {
        (dhash(a) ^ dhash(b)).count_ones()
    }

    #[test]
    fn dhash_is_close_for_edits_and_far_for_other_images() {
        let a = scene(240, 180);
        assert_eq!(d(&a, &a.clone()), 0);
        assert!(d(&a, &scene(96, 72)) <= 3, "resized: {}", d(&a, &scene(96, 72)));
        assert!(d(&a, &imageops::resize(&a, 600, 450, FilterType::Lanczos3)) <= 3);
        // Recoloured: a hue shift (channels rotated) keeps lightness, so the hash; a strong tint moves it some.
        let recolor = |f: fn([u8; 4]) -> [u8; 4]| RgbaImage::from_fn(240, 180, |x, y| Rgba(f(a.get_pixel(x, y).0)));
        assert_eq!(d(&a, &recolor(|[r, g, b, al]| [g, b, r, al])), 0);
        let tinted = recolor(|[r, g, b, al]| [r / 2 + 100, g, b / 2, al]);
        assert!(d(&a, &tinted) <= 12, "tinted: {}", d(&a, &tinted));
        let cropped = imageops::crop_imm(&a, 8, 6, 224, 168).to_image();
        assert!(d(&a, &cropped) <= 10, "cropped: {}", d(&a, &cropped));
        assert!(d(&a, &other(240, 180)) >= 24, "different: {}", d(&a, &other(240, 180)));
    }

    #[test]
    fn dhash_keeps_a_recoloured_sprite_close() {
        // A ring on a transparent background, in red and in green.
        let sprite = |c: [u8; 3]| {
            RgbaImage::from_fn(64, 64, |x, y| {
                let r = ((x as f32 - 31.5).powi(2) + (y as f32 - 31.5).powi(2)).sqrt();
                if (14.0..26.0).contains(&r) {
                    Rgba([c[0], c[1], c[2], 255])
                } else {
                    Rgba([0, 0, 0, 0])
                }
            })
        };
        let (red, green) = (sprite([220, 30, 30]), sprite([40, 200, 60]));
        assert!(d(&red, &green) <= 4, "{}", d(&red, &green));
    }

    #[test]
    fn colours_of_solid_two_tone_and_transparent_images() {
        let solid = RgbaImage::from_pixel(32, 32, Rgba([255, 0, 0, 255]));
        assert_eq!(dominant_colors(&solid), vec![[255, 0, 0, 100]]);

        let two = RgbaImage::from_fn(100, 10, |x, _| {
            if x < 70 {
                Rgba([20, 60, 200, 255])
            } else {
                Rgba([250, 220, 30, 255])
            }
        });
        assert_eq!(dominant_colors(&two), vec![[20, 60, 200, 70], [250, 220, 30, 30]]);

        // Transparent pixels don't count, whatever their colour.
        let half = RgbaImage::from_fn(10, 10, |x, _| {
            if x < 5 {
                Rgba([255, 255, 255, 0])
            } else {
                Rgba([0, 180, 0, 255])
            }
        });
        assert_eq!(dominant_colors(&half), vec![[0, 180, 0, 100]]);
        assert!(dominant_colors(&RgbaImage::new(4, 4)).is_empty());

        // A busy picture still gives at most five colours, heaviest first, weights adding up to about 100.
        let c = dominant_colors(&scene(120, 90));
        assert!((2..=COLORS).contains(&c.len()));
        assert!(c.windows(2).all(|w| w[0][3] >= w[1][3]));
        let sum: u32 = c.iter().map(|s| s[3] as u32).sum();
        assert!((90..=102).contains(&sum), "{c:?}");
    }

    #[test]
    fn pass_stores_features_and_finds_near_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let (r, thumbs_dir) = (dir.path().join("lib"), dir.path().join("thumbs"));
        std::fs::create_dir_all(&r).unwrap();
        std::fs::create_dir_all(&thumbs_dir).unwrap();
        scene(480, 360).save(r.join("hero.png")).unwrap();
        scene(120, 90).save(r.join("hero-small.png")).unwrap();
        other(240, 180).save(r.join("checker.png")).unwrap();
        RgbaImage::from_pixel(16, 16, Rgba([255, 0, 0, 255]))
            .save(r.join("red.png"))
            .unwrap();
        std::fs::write(r.join("broken.png"), "not a png").unwrap();
        std::fs::write(r.join("icon.svg"), "<svg/>").unwrap();
        let mut conn = db::open_memory();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [r.display().to_string()])
            .unwrap();
        scan::tests::scan(&mut conn, 1, &r);
        let id = |name: &str| -> i64 {
            conn.query_row("SELECT id FROM assets WHERE name = ?1", [name], |r| r.get(0))
                .unwrap()
        };
        let (hero, small, checker, red) = (id("hero.png"), id("hero-small.png"), id("checker.png"), id("red.png"));
        let broken = id("broken.png");

        // The red square has a cached thumbnail that is blue: the thumbnail is what gets analysed.
        let todo = stale(&conn).unwrap();
        assert_eq!(todo.len(), 5); // not the SVG
        let red_todo = todo.iter().find(|t| t.id == red).unwrap();
        RgbaImage::from_pixel(16, 16, Rgba([0, 0, 255, 255]))
            .save(red_todo.thumb(&thumbs_dir))
            .unwrap();

        let db = Mutex::new(conn);
        let mut reported = Vec::new();
        analyse_and_store(
            &db,
            &todo,
            2,
            &thumbs_dir,
            || Some(()),
            |_, colors| reported.push(colors),
        )
        .unwrap();
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0].len(), 5);
        // The broken file is reported without colours, so the UI drops any it had for an earlier version.
        assert!(reported[0].iter().any(|(id, c)| *id == broken && c.is_empty()));
        let conn = db.into_inner().unwrap();
        assert_eq!(counts(&conn).unwrap(), (5, 5));
        let colors = colors(&conn).unwrap();
        assert_eq!(colors.iter().find(|c| c.0 == red).unwrap().1, vec![[0, 0, 255, 100]]);

        let h = dhash_of(&conn, hero).unwrap().unwrap();
        assert_eq!(similar(&conn, hero, h, 10).unwrap(), vec![small]);
        assert!(similar(&conn, hero, h, 64).unwrap().contains(&checker));

        // A changed file is stale until analysed again, and its old hash isn't used.
        conn.execute("UPDATE assets SET mtime = mtime + 1 WHERE id = ?1", [small])
            .unwrap();
        assert_eq!(counts(&conn).unwrap(), (4, 5));
        assert!(dhash_of(&conn, small).unwrap().is_none());
        assert!(similar(&conn, hero, h, 10).unwrap().is_empty());
        // Results for a version that's gone, or an asset that's gone, aren't stored.
        let f = || Some(features(&r.join("hero.png"), "png", Path::new("")).unwrap());
        store(&conn, &[(small, 0, 0, f()), (9999, 0, 0, f())]).unwrap();
        assert_eq!(counts(&conn).unwrap(), (4, 5));
        assert!(dhash_of(&conn, 9999).unwrap().is_none());
    }

    /// A scanned library of `n` small images (img0.png…), none analysed, and an empty thumbnail folder.
    fn library(n: u8) -> (tempfile::TempDir, Connection, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (r, thumbs_dir) = (dir.path().join("lib"), dir.path().join("thumbs"));
        std::fs::create_dir_all(&r).unwrap();
        std::fs::create_dir_all(&thumbs_dir).unwrap();
        for i in 0..n {
            RgbaImage::from_pixel(40, 30, Rgba([i * 40, 90, 0, 255]))
                .save(r.join(format!("img{i}.png")))
                .unwrap();
        }
        let mut conn = db::open_memory();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [r.display().to_string()])
            .unwrap();
        scan::tests::scan(&mut conn, 1, &r);
        (dir, conn, thumbs_dir)
    }

    #[test]
    fn a_viewed_image_is_analysed_from_its_thumbnail() {
        let (dir, conn, thumbs_dir) = library(2);
        let a = db::assets(&conn, None).unwrap().remove(0);
        assert!(is_stale(&conn, &a).unwrap());
        // The thumbnail command writes this file, then `viewed` queues the image for the thread that analyses it.
        let thumb = thumbs_dir.join(thumbs::cache_name(&a.path, a.size, a.mtime));
        thumbs::thumbnail(Path::new(&a.path), &a.ext, &thumb).unwrap();
        let t = Todo::of(&a);
        assert_eq!(t.thumb(&thumbs_dir), thumb);
        assert_eq!(t.root, dir.path().join("lib"));
        let db = Mutex::new(conn);
        analyse_and_store(&db, &[t], 1, &thumbs_dir, || Some(()), |_, _| {}).unwrap();
        let conn = db.into_inner().unwrap();
        assert!(!is_stale(&conn, &a).unwrap());
        assert_eq!(counts(&conn).unwrap(), (1, 2));
        assert_eq!(stale(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_cancelled_pass_keeps_what_it_stored() {
        let (_dir, conn, thumbs_dir) = library(5);
        let work = stale(&conn).unwrap();
        let db = Mutex::new(conn);
        // Cancelled after two images: from then on the gate lets nothing through.
        let allowed = AtomicUsize::new(2);
        let gate = || allowed.fetch_update(SeqCst, SeqCst, |n| n.checked_sub(1)).ok();
        let mut reported = 0;
        analyse_and_store(&db, &work, 1, &thumbs_dir, gate, |_, colors| reported += colors.len()).unwrap();
        assert_eq!(reported, 2);
        let conn = db.into_inner().unwrap();
        assert_eq!(counts(&conn).unwrap(), (2, 5));
        // The next pass picks up the rest.
        assert_eq!(stale(&conn).unwrap().len(), 3);
    }

    #[test]
    fn keeping_analysed_only_touches_changed_images() {
        let (_dir, conn, thumbs_dir) = library(4);
        let ids: Vec<i64> = db::assets(&conn, None).unwrap().iter().map(|a| a.id).collect();
        // A watcher batch changed one image and removed some other row; three images were never analysed.
        let work = todo(&conn, &[ids[2], 9999]).unwrap();
        assert_eq!(work.iter().map(|t| t.id).collect::<Vec<_>>(), vec![ids[2]]);
        let db = Mutex::new(conn);
        analyse_and_store(&db, &work, 2, &thumbs_dir, || Some(()), |_, _| {}).unwrap();
        let conn = db.into_inner().unwrap();
        assert_eq!(counts(&conn).unwrap(), (1, 4));
    }

    #[test]
    fn images_of_an_unplugged_drive_wait_until_it_is_back() {
        let (dir, conn, thumbs_dir) = library(2);
        let usb = dir.path().join("usb");
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [usb.display().to_string()])
            .unwrap();
        conn.execute(
            "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime, seen) VALUES (?1, 'a.png', 'a.png', 'png', 'image', 1, 1, 1)",
            [conn.last_insert_rowid()],
        )
        .unwrap();
        let usb_image = conn.last_insert_rowid();
        let db = Mutex::new(conn);
        // Unplugged after the pass made its list: the image can't be read, and isn't stored as unreadable.
        let work = stale(&db.lock().unwrap()).unwrap();
        analyse_and_store(&db, &work, 1, &thumbs_dir, || Some(()), |_, _| {}).unwrap();
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (2, 3));
        // A whole-library pass leaves it out, so it ends, rather than trying it round after round.
        let rounds = AtomicUsize::new(0);
        let ready = || rounds.fetch_add(1, SeqCst) < 2;
        assert!(analyse_all(&db, 1, &thumbs_dir, ready, || Some(()), |_, _| {}).unwrap());
        // Plugged back in: analysed.
        std::fs::create_dir(&usb).unwrap();
        RgbaImage::from_pixel(8, 8, Rgba([0, 200, 0, 255]))
            .save(usb.join("a.png"))
            .unwrap();
        assert!(analyse_all(&db, 1, &thumbs_dir, || true, || Some(()), |_, _| {}).unwrap());
        assert!(dhash_of(&db.lock().unwrap(), usb_image).unwrap().is_some());
    }

    /// Writes an image into the library folder and indexes it, as a scan or the watcher would.
    fn index(conn: &Connection, root: &Path, name: &str) {
        RgbaImage::from_pixel(20, 20, Rgba([0, 0, 200, 255]))
            .save(root.join(name))
            .unwrap();
        conn.execute(
            "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime, seen) VALUES (1, ?1, ?1, 'png', 'image', 1, 1, 1)",
            [name],
        )
        .unwrap();
    }

    #[test]
    fn a_whole_library_pass_covers_images_indexed_while_it_runs() {
        let (dir, conn, thumbs_dir) = library(2);
        let root = dir.path().join("lib");
        let db = Mutex::new(conn);
        // The user starts it during a scan: `ready` waits for the scan, which indexes one more image. While the first
        // round runs, the watcher indexes another.
        let readies = AtomicUsize::new(0);
        let ready = || {
            if readies.fetch_add(1, SeqCst) == 0 {
                index(&db.lock().unwrap(), &root, "scanned.png");
            }
            true
        };
        let mut rounds = 0;
        let after = |conn: &Connection, _: Vec<(i64, Vec<Swatch>)>| {
            rounds += 1;
            if rounds == 1 {
                index(conn, &root, "late.png");
            }
        };
        assert!(analyse_all(&db, 2, &thumbs_dir, ready, || Some(()), after).unwrap());
        assert_eq!(rounds, 2);
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (4, 4));

        // Stopped before it's done (Cancel): not complete, so "keep analysed" isn't turned on, and the rest stays.
        index(&db.lock().unwrap(), &root, "after.png");
        assert!(!analyse_all(&db, 2, &thumbs_dir, || false, || Some(()), |_, _| {}).unwrap());
        assert_eq!(counts(&db.lock().unwrap()).unwrap(), (4, 5));
    }

    #[test]
    fn changes_start_a_pass_only_when_keep_analysed_is_on() {
        let conn = db::open_memory();
        let mut q = Queue {
            all: false,
            ids: vec![],
            running: false,
        };
        let on = || keep(&conn).unwrap();
        // Off by default: changes queue nothing and start nothing.
        assert!(!on());
        assert!(!q.changed(on(), &[1, 2]));
        assert_eq!(q.take(), None);
        // A finished whole-library pass turns it on. Changes then start the pass thread, once.
        keep_by_default(&conn).unwrap();
        assert!(on());
        assert!(q.changed(on(), &[1, 2]));
        assert!(!q.changed(on(), &[3]));
        assert_eq!(q.take(), Some((false, vec![1, 2, 3])));
        assert_eq!(q.take(), None);
        assert!(q.add(true, &[]));
        assert_eq!(q.take(), Some((true, vec![])));
        assert_eq!(q.take(), None);
        // Turned off by the user, it stays off after the next whole-library pass.
        set_keep(&conn, false).unwrap();
        keep_by_default(&conn).unwrap();
        assert!(!q.changed(on(), &[4]));
        assert_eq!(q.take(), None);
    }
}

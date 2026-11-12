//! Keeps the `assets` table in step with the files under a root. Only ever reads the files.

use std::fs::Metadata;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OptionalExtension, Result, params};
use walkdir::WalkDir;

use crate::db::abs_path;
use crate::kind::{DECODABLE, decodable_sql, ignored_dir, ignored_name, ignored_rel, kind_of};

/// `path` relative to `root`, with `/` separators. None when it's outside the root or ignored.
pub fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let rel = parts.join("/");
    (!ignored_rel(&rel, || path.is_dir())).then_some(rel)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Width and height from the file header, without decoding pixels.
fn dimensions(path: &Path, ext: &str) -> Option<(u32, u32)> {
    match ext {
        // PSD header: signature(4) version(2) reserved(6) channels(2) height(4) width(4)
        "psd" => {
            let mut h = [0u8; 22];
            std::fs::File::open(path).ok()?.read_exact(&mut h).ok()?;
            (&h[..4] == b"8BPS").then(|| {
                let be = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
                (be(&h[18..22]), be(&h[14..18]))
            })
        }
        "ase" | "aseprite" => {
            let mut h = [0u8; 12];
            std::fs::File::open(path).ok()?.read_exact(&mut h).ok()?;
            crate::aseprite::size(&h)
        }
        // Caught like in thumbs::decode: a decoder panic here would poison the db lock the watcher holds.
        e if DECODABLE.contains(&e) => std::panic::catch_unwind(|| image::image_dimensions(path).ok())
            .ok()
            .flatten(),
        _ => None,
    }
}

/// The last `seen` stamp handed out, so stamps only go up even when the clock steps back.
static LAST_SEEN: AtomicI64 = AtomicI64::new(0);

/// Now, as a `seen` stamp, above every stamp before it. A scan's sweep keeps rows stamped after it began, such as
/// files the watcher saw change.
fn seen_now() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(1, |d| d.as_nanos() as i64);
    let last = LAST_SEEN.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |l| Some(now.max(l + 1)));
    now.max(last.unwrap() + 1)
}

/// Inserts or refreshes one file's row; returns false if it isn't an indexable file. Adds the row's id to `touched`
/// when it was added or changed. Unchanged files keep their hash and dimensions. With `with_dims` false, changed images get their dimensions
/// later from [`fill_dimensions`], so a big scan isn't slowed down by opening every image. Audio details always come
/// later, from [`crate::audio::fill_audio`], which reads the files without holding the db lock.
#[allow(clippy::too_many_arguments)]
pub fn upsert_file(
    conn: &Connection,
    root_id: i64,
    root: &Path,
    path: &Path,
    meta: &Metadata,
    seen: i64,
    with_dims: bool,
    touched: &mut Vec<i64>,
) -> Result<bool> {
    let Some(rel) = rel_of(root, path) else {
        return Ok(false);
    };
    if !meta.is_file() {
        return Ok(false);
    }
    let size = meta.len() as i64;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);

    let prev: Option<(i64, i64)> = conn
        .query_row(
            "SELECT size, mtime FROM assets WHERE root_id = ?1 AND rel_path = ?2",
            params![root_id, rel],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if prev == Some((size, mtime)) {
        conn.execute(
            "UPDATE assets SET seen = ?3 WHERE root_id = ?1 AND rel_path = ?2",
            params![root_id, rel, seen],
        )?;
        return Ok(true);
    }

    let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
    let ext = ext_of(&name);
    let kind = kind_of(&ext);
    let dims = if with_dims && kind == "image" {
        Some(dimensions(path, &ext).unwrap_or((0, 0)))
    } else {
        None
    };
    let id = conn.query_row(
        "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime, width, height, seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (root_id, rel_path) DO UPDATE SET
           name = excluded.name, ext = excluded.ext, kind = excluded.kind, size = excluded.size,
           mtime = excluded.mtime, width = excluded.width, height = excluded.height, seen = excluded.seen,
           hash = NULL
         RETURNING id",
        params![
            root_id,
            rel,
            name,
            ext,
            kind,
            size,
            mtime,
            dims.map(|d| d.0),
            dims.map(|d| d.1),
            seen
        ],
        |r| r.get(0),
    )?;
    touched.push(id);
    Ok(true)
}

/// Files under `dir`, with the metadata the directory listing already provides (no extra stat on Windows). A folder or
/// file that can't be read (missing, on an unplugged drive, no access) comes as `Err(path)`.
fn walk(dir: &Path) -> impl Iterator<Item = std::result::Result<(PathBuf, Metadata), PathBuf>> {
    WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            e.depth() == 0
                || !if e.file_type().is_dir() {
                    ignored_dir(&name)
                } else {
                    ignored_name(&name)
                }
        })
        .filter_map(move |e| match e {
            Err(err) => Some(Err(err.path().unwrap_or(dir).to_path_buf())),
            Ok(e) if !e.file_type().is_file() => None,
            Ok(e) => Some(match e.metadata() {
                Ok(m) => Ok((e.into_path(), m)),
                Err(_) => Err(e.into_path()),
            }),
        })
}

/// Whether `rel` is the path `dir` or under it.
fn under(rel: &str, dir: &str) -> bool {
    rel == dir || rel.strip_prefix(dir).is_some_and(|r| r.starts_with('/'))
}

/// Whether `rel` is under one of the `unread` paths of a scan.
pub(crate) fn unreadable(rel: &str, unread: &[String]) -> bool {
    unread.iter().any(|d| under(rel, d))
}

const BATCH: usize = 500;

/// Full rescan of a root: upserts every file, then drops rows for files that are gone. Commits every
/// [`BATCH`] files and releases the lock in between, so the UI can show (and thumbnail) assets while it runs.
/// `report(conn, count, touched)` is called after every batch, including the sweep and the dimensions pass, with the
/// lock still held and the ids of the rows that batch added, changed or removed. Returns the number of files, or None
/// when the root itself can't be read, or reads as empty while it has rows: then every row is kept as it was.
pub fn scan_root(
    db: &Mutex<Connection>,
    root_id: i64,
    root: &Path,
    mut report: impl FnMut(&Connection, usize, &[i64]),
) -> Result<Option<usize>> {
    // Above every stamp already stored, even ones from a clock that was ahead, so the sweep sees all of them.
    let seen = {
        let conn = db.lock().unwrap();
        let max: Option<i64> = conn.query_row("SELECT MAX(seen) FROM assets WHERE root_id = ?1", [root_id], |r| {
            r.get(0)
        })?;
        LAST_SEEN.fetch_max(max.unwrap_or(0), Ordering::Relaxed);
        seen_now()
    };
    let mut count = 0;
    // What couldn't be read, relative to the root ("" for the root itself).
    let mut unread = Vec::new();
    let mut files = walk(root).peekable();
    while files.peek().is_some() {
        let batch: Vec<_> = files.by_ref().take(BATCH).collect();
        let mut touched = Vec::new();
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        for file in &batch {
            match file {
                Ok((path, meta)) => {
                    if upsert_file(&tx, root_id, root, path, meta, seen, false, &mut touched)? {
                        count += 1;
                    }
                }
                Err(path) => unread.push(rel_of(root, path).unwrap_or_default()),
            }
        }
        tx.commit()?;
        report(&conn, count, &touched);
        drop(conn);
        // The mutex isn't fair: without a pause this thread re-locks at once and UI commands starve until the end.
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    // An unplugged drive or a renamed folder isn't a library whose files were all deleted. The passes below would also
    // store every file not read yet as unreadable, for good.
    if unread.iter().any(|d| d.is_empty()) {
        return Ok(None);
    }
    // Nor is an empty folder that had files: a mount point with its drive not mounted reads as empty. Only one with
    // nothing in it at all, though: files now all under ignored folders leave as usual.
    if count == 0 && std::fs::read_dir(root).is_ok_and(|mut d| d.next().is_none()) {
        let had: bool = db.lock().unwrap().query_row(
            "SELECT EXISTS (SELECT 1 FROM assets WHERE root_id = ?1)",
            [root_id],
            |r| r.get(0),
        )?;
        if had {
            return Ok(None);
        }
    }
    {
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        let stale: Vec<(i64, String)> = tx
            .prepare("SELECT id, rel_path FROM assets WHERE root_id = ?1 AND seen < ?2")?
            .query_map(params![root_id, seen], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_>>()?;
        // Files under a folder that couldn't be read may well still be there.
        let gone: Vec<i64> = stale
            .into_iter()
            .filter(|(_, rel)| !unreadable(rel, &unread))
            .map(|(id, _)| id)
            .collect();
        for id in &gone {
            tx.execute("DELETE FROM assets WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        report(&conn, count, &gone);
    }
    fill_dimensions(db, root_id, root, &unread, |conn, ids| report(conn, count, ids))?;
    crate::audio::fill_audio(db, root_id, root, &unread, None, |conn, ids| report(conn, count, ids))?;
    Ok(Some(count))
}

/// Reads image dimensions for rows that don't have them yet, from file headers, in parallel and in batches.
/// Unreadable files get 0x0 so they aren't retried every scan; files under the scan's `unread` paths wait for the next
/// one. `report(conn, ids)` gets each batch's ids, lock held.
pub fn fill_dimensions(
    db: &Mutex<Connection>,
    root_id: i64,
    root: &Path,
    unread: &[String],
    mut report: impl FnMut(&Connection, &[i64]),
) -> Result<()> {
    let exts = decodable_sql();
    // By id, so rows skipped (left without dimensions) aren't selected again.
    let sql = format!(
        "SELECT id, rel_path, ext FROM assets
         WHERE root_id = ?1 AND id > ?2 AND width IS NULL AND ext IN ({exts}) ORDER BY id LIMIT {BATCH}"
    );
    let root_str = root.to_string_lossy();
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    let mut after = 0;
    loop {
        let todo: Vec<(i64, String, String)> = {
            let conn = db.lock().unwrap();
            let mut stmt = conn.prepare(&sql)?;
            stmt.query_map(params![root_id, after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_>>()?
        };
        let Some(last) = todo.last() else {
            return Ok(());
        };
        after = last.0;
        let todo: Vec<_> = todo
            .into_iter()
            .filter(|(_, rel, _)| !unreadable(rel, unread))
            .collect();
        if todo.is_empty() {
            continue;
        }
        let root_str = &root_str;
        let dims: Vec<(i64, (u32, u32))> = std::thread::scope(|s| {
            let handles: Vec<_> = todo
                .chunks(todo.len().div_ceil(workers))
                .map(|chunk| {
                    s.spawn(move || {
                        chunk
                            .iter()
                            .map(|(id, rel, ext)| (*id, dimensions(&abs_path(root_str, rel), ext).unwrap_or((0, 0))))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
        });
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        for (id, (w, h)) in &dims {
            tx.execute(
                "UPDATE assets SET width = ?2, height = ?3 WHERE id = ?1",
                params![id, w, h],
            )?;
        }
        tx.commit()?;
        report(&conn, &dims.iter().map(|(id, _)| *id).collect::<Vec<_>>());
        drop(conn);
        std::thread::sleep(std::time::Duration::from_millis(1)); // let waiting UI commands in, see scan_root
    }
}

/// Drops the rows for `rel` and everything under it, adding their ids to `touched`.
fn delete_under(conn: &Connection, root_id: i64, rel: &str, touched: &mut Vec<i64>) -> Result<()> {
    let mut stmt = conn.prepare(
        "DELETE FROM assets WHERE root_id = ?1 AND (rel_path = ?2 OR substr(rel_path, 1, length(?2) + 1) = ?2 || '/')
         RETURNING id",
    )?;
    for id in stmt.query_map(params![root_id, rel], |r| r.get(0))? {
        touched.push(id?);
    }
    Ok(())
}

/// Syncs one path after a change event: a file, a whole folder, or something that's gone. Adds the ids of rows it
/// added, changed or removed to `touched`.
pub fn refresh_path(conn: &Connection, root_id: i64, root: &Path, path: &Path, touched: &mut Vec<i64>) -> Result<()> {
    let Some(rel) = rel_of(root, path) else { return Ok(()) };
    let seen = seen_now();
    if path.is_dir() {
        for (f, meta) in walk(path).flatten() {
            upsert_file(conn, root_id, root, &f, &meta, seen, true, touched)?;
        }
    } else if let Some(meta) = std::fs::metadata(path).ok().filter(|m| m.is_file()) {
        upsert_file(conn, root_id, root, path, &meta, seen, true, touched)?;
    } else {
        delete_under(conn, root_id, &rel, touched)?;
    }
    Ok(())
}

/// Moves rows in place so a renamed file or folder keeps its tags, favorite and collections.
pub fn rename_path(
    conn: &Connection,
    root_id: i64,
    root: &Path,
    from: &Path,
    to: &Path,
    touched: &mut Vec<i64>,
) -> Result<()> {
    let (Some(from_rel), Some(to_rel)) = (rel_of(root, from), rel_of(root, to)) else {
        // Moved in or out of the root (or to/from an ignored place): treat as delete + add.
        refresh_path(conn, root_id, root, from, touched)?;
        return refresh_path(conn, root_id, root, to, touched);
    };
    // Anything the move overwrote is replaced.
    delete_under(conn, root_id, &to_rel, touched)?;
    conn.execute(
        "UPDATE assets SET rel_path = ?3 || substr(rel_path, length(?2) + 1)
         WHERE root_id = ?1 AND (rel_path = ?2 OR substr(rel_path, 1, length(?2) + 1) = ?2 || '/')",
        params![root_id, from_rel, to_rel],
    )?;
    // Names, extensions and kinds of the moved rows.
    let mut stmt = conn.prepare(
        "SELECT id, rel_path FROM assets WHERE root_id = ?1 AND (rel_path = ?2 OR substr(rel_path, 1, length(?2) + 1) = ?2 || '/')",
    )?;
    let moved: Vec<(i64, String)> = stmt
        .query_map(params![root_id, to_rel], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_>>()?;
    for (id, rel) in moved {
        touched.push(id);
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let ext = ext_of(&name);
        conn.execute(
            "UPDATE assets SET name = ?2, ext = ?3, kind = ?4 WHERE id = ?1",
            params![id, name, ext, kind_of(&ext)],
        )?;
    }
    // Picks up content changes and anything the rows didn't cover.
    refresh_path(conn, root_id, root, to, touched)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::db;
    use std::fs;

    fn setup() -> (tempfile::TempDir, Connection, i64) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open_memory();
        conn.execute(
            "INSERT INTO roots (path) VALUES (?1)",
            [dir.path().display().to_string()],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        (dir, conn, id)
    }

    fn rels(conn: &Connection) -> Vec<String> {
        let mut v: Vec<String> = db::assets(conn, None)
            .unwrap()
            .into_iter()
            .map(|a| a.rel_path)
            .collect();
        v.sort();
        v
    }

    /// Runs a full scan on a plain connection (the app passes its shared Mutex). Returns the file count.
    pub fn scan(conn: &mut Connection, root: i64, r: &Path) -> usize {
        scan_touched(conn, root, r).0.unwrap()
    }

    /// A full scan, with every id its batches reported.
    fn scan_touched(conn: &mut Connection, root: i64, r: &Path) -> (Option<usize>, Vec<i64>) {
        let db = Mutex::new(std::mem::replace(conn, Connection::open_in_memory().unwrap()));
        let mut touched = Vec::new();
        let n = scan_root(&db, root, r, |_, _, ids| touched.extend_from_slice(ids)).unwrap();
        *conn = db.into_inner().unwrap();
        (n, touched)
    }

    /// The delta the UI would get for `touched`: (sorted upserted rel paths, removed ids).
    fn delta(conn: &Connection, touched: &[i64]) -> (Vec<String>, Vec<i64>) {
        let (rows, removed) = db::delta(conn, touched).unwrap();
        let mut rels: Vec<String> = rows.into_iter().map(|a| a.rel_path).collect();
        rels.sort();
        (rels, removed)
    }

    fn png(path: &Path, w: u32, h: u32) {
        image::RgbaImage::new(w, h).save(path).unwrap();
    }

    #[test]
    fn scan_upserts_and_sweeps() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("sprites/.hidden")).unwrap();
        png(&r.join("sprites/hero.png"), 32, 16);
        fs::write(r.join("sprites/hero.png.meta"), "x").unwrap();
        fs::write(r.join("sprites/.hidden/x.png"), "x").unwrap();
        fs::write(r.join("jump.wav"), "RIFF").unwrap();

        assert_eq!(scan(&mut conn, root, r), 2);
        assert_eq!(rels(&conn), ["jump.wav", "sprites/hero.png"]);
        let hero = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .find(|a| a.name == "hero.png")
            .unwrap();
        assert_eq!(
            (hero.kind.as_str(), hero.width, hero.height),
            ("image", Some(32), Some(16))
        );
        assert!(
            hero.path
                .ends_with(&format!("sprites{}hero.png", std::path::MAIN_SEPARATOR))
        );

        // Tags survive a rescan; deleted files drop out.
        db::add_tag(&conn, &[hero.id], "player").unwrap();
        fs::remove_file(r.join("jump.wav")).unwrap();
        scan(&mut conn, root, r);
        let all = db::assets(&conn, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].id, all[0].tags.clone()), (hero.id, vec!["player".to_string()]));
    }

    #[test]
    fn a_missing_root_keeps_its_rows() {
        let (dir, mut conn, root) = setup();
        let lib = dir.path().join("lib");
        fs::create_dir_all(lib.join("art")).unwrap();
        // A new, empty folder is just empty.
        assert_eq!(scan_touched(&mut conn, root, &lib), (Some(0), vec![]));
        png(&lib.join("art/a.png"), 4, 4);
        fs::write(lib.join("b.ogg"), "x").unwrap();
        scan(&mut conn, root, &lib);
        let ids: Vec<i64> = db::assets(&conn, None).unwrap().iter().map(|a| a.id).collect();
        db::add_tag(&conn, &ids, "keep").unwrap();

        // An unplugged drive or a renamed folder isn't a library whose files were all deleted.
        fs::rename(&lib, dir.path().join("away")).unwrap();
        assert_eq!(scan_touched(&mut conn, root, &lib), (None, vec![]));
        let all = db::assets(&conn, None).unwrap();
        assert_eq!(rels(&conn), ["art/a.png", "b.ogg"]);
        assert!(all.iter().all(|a| a.tags == ["keep"]));

        // So isn't an empty folder in its place: a mount point whose drive isn't mounted.
        fs::create_dir(&lib).unwrap();
        assert_eq!(scan_touched(&mut conn, root, &lib), (None, vec![]));
        assert_eq!(rels(&conn), ["art/a.png", "b.ogg"]);
        fs::remove_dir(&lib).unwrap();

        // Back again: a rescan finds the same rows.
        fs::rename(dir.path().join("away"), &lib).unwrap();
        assert_eq!(scan_touched(&mut conn, root, &lib), (Some(2), vec![]));

        // The sweep keeps what's under a subfolder that couldn't be read.
        assert!(under("art/a.png", "art") && under("art", "art"));
        assert!(!under("artwork/a.png", "art") && !under("b.ogg", "art"));

        // Moved for good and relinked: rows are matched by their path in the root, so they keep ids and tags.
        let moved = dir.path().join("moved");
        let a_id = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .find(|a| a.rel_path == "art/a.png")
            .unwrap()
            .id;
        fs::rename(&lib, &moved).unwrap();
        fs::remove_file(moved.join("b.ogg")).unwrap();
        conn.execute(
            "UPDATE roots SET path = ?1 WHERE id = ?2",
            rusqlite::params![moved.to_str(), root],
        )
        .unwrap();
        assert_eq!(scan_touched(&mut conn, root, &moved).0, Some(1));
        let all = db::assets(&conn, None).unwrap();
        assert_eq!(
            all.iter().map(|a| (a.id, a.rel_path.as_str())).collect::<Vec<_>>(),
            [(a_id, "art/a.png")]
        );
        assert_eq!(all[0].tags, ["keep"]);
        assert!(all[0].path.starts_with(moved.to_str().unwrap()));
    }

    #[test]
    fn passes_leave_unreadable_files_for_later() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("art")).unwrap();
        png(&r.join("art/a.png"), 4, 4);
        fs::write(r.join("art/b.ogg"), "x").unwrap();
        png(&r.join("c.png"), 2, 2);
        scan(&mut conn, root, r);
        // As if a scan stopped before the passes, and art/ couldn't be read on the next one.
        conn.execute("UPDATE assets SET width = NULL, height = NULL", [])
            .unwrap();
        conn.execute("DELETE FROM audio_info", []).unwrap();
        fs::rename(r.join("art"), r.join("away")).unwrap();

        let db = Mutex::new(conn);
        let unread = ["art".to_string()];
        fill_dimensions(&db, root, r, &unread, |_, _| {}).unwrap();
        crate::audio::fill_audio(&db, root, r, &unread, None, |_, _| {}).unwrap();
        let conn = db.into_inner().unwrap();
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        // Only c.png was read; art/a.png and art/b.ogg wait for a scan that can read them.
        assert_eq!(count("SELECT count(*) FROM assets WHERE width IS NULL"), 2);
        assert_eq!(count("SELECT count(*) FROM audio_info"), 0);
        assert_eq!(count("SELECT width FROM assets WHERE rel_path = 'c.png'"), 2);
    }

    #[test]
    fn rename_keeps_tags() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("old")).unwrap();
        fs::write(r.join("old/a.png"), "x").unwrap();
        fs::write(r.join("b.ogg"), "x").unwrap();
        scan(&mut conn, root, r);
        let ids: Vec<i64> = db::assets(&conn, None).unwrap().iter().map(|a| a.id).collect();
        db::add_tag(&conn, &ids, "keep").unwrap();

        // File rename that changes the kind.
        fs::rename(r.join("b.ogg"), r.join("b.txt")).unwrap();
        rename_path(&conn, root, r, &r.join("b.ogg"), &r.join("b.txt"), &mut vec![]).unwrap();
        // Folder rename.
        fs::rename(r.join("old"), r.join("new")).unwrap();
        rename_path(&conn, root, r, &r.join("old"), &r.join("new"), &mut vec![]).unwrap();

        let all = db::assets(&conn, None).unwrap();
        assert_eq!(rels(&conn), ["b.txt", "new/a.png"]);
        assert!(all.iter().all(|a| a.tags == ["keep"]));
        assert_eq!(all.iter().find(|a| a.name == "b.txt").unwrap().kind, "text");
    }

    #[test]
    fn scan_reports_changes_and_sweep() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::write(r.join("a.png"), "x").unwrap();
        fs::write(r.join("b.wav"), "x").unwrap();
        let (_, touched) = scan_touched(&mut conn, root, r);
        assert_eq!(delta(&conn, &touched), (vec!["a.png".into(), "b.wav".into()], vec![]));

        // A rescan with nothing changed reports nothing, so the UI does no work.
        assert!(scan_touched(&mut conn, root, r).1.is_empty());

        // The sweep reports deleted files; changed files come back as rows.
        let gone = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .find(|a| a.name == "b.wav")
            .unwrap()
            .id;
        fs::remove_file(r.join("b.wav")).unwrap();
        fs::write(r.join("a.png"), "longer").unwrap();
        let (_, touched) = scan_touched(&mut conn, root, r);
        assert_eq!(delta(&conn, &touched), (vec!["a.png".into()], vec![gone]));
    }

    #[test]
    fn files_the_watcher_sees_during_a_scan_survive_its_sweep() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::write(r.join("a.png"), "x").unwrap();
        fs::write(r.join("b.png"), "x").unwrap();
        scan(&mut conn, root, r);
        let a = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .find(|x| x.name == "a.png")
            .unwrap()
            .id;
        db::add_tag(&conn, &[a], "keep").unwrap();

        fs::remove_file(r.join("b.png")).unwrap();
        // b.png was last seen while the clock was an hour ahead: it's still swept.
        conn.execute("UPDATE assets SET seen = seen + 3600000000000 WHERE name = 'b.png'", [])
            .unwrap();
        let shared = Mutex::new(conn);
        let mut first = true;
        scan_root(&shared, root, r, |conn, _, _| {
            // After the files were walked, before the sweep: a.png is saved and renamed, and the watcher catches up.
            if std::mem::take(&mut first) {
                fs::write(r.join("a.png"), "edited").unwrap();
                refresh_path(conn, root, r, &r.join("a.png"), &mut vec![]).unwrap();
                fs::rename(r.join("a.png"), r.join("c.png")).unwrap();
                rename_path(conn, root, r, &r.join("a.png"), &r.join("c.png"), &mut vec![]).unwrap();
            }
        })
        .unwrap();
        let conn = shared.into_inner().unwrap();
        let all = db::assets(&conn, None).unwrap();
        assert_eq!(rels(&conn), ["c.png"]);
        assert_eq!((all[0].id, all[0].tags.clone()), (a, vec!["keep".to_string()]));
    }

    #[test]
    fn watcher_reports_add_rename_and_remove() {
        use notify_debouncer_full::notify::event::{
            AccessKind, CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode,
        };
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("old")).unwrap();
        fs::write(r.join("old/a.png"), "x").unwrap();
        scan(&mut conn, root, r);
        let a = db::assets(&conn, None).unwrap()[0].id;
        db::add_tag(&conn, &[a], "keep").unwrap();

        // Add.
        fs::write(r.join("new.png"), "x").unwrap();
        let t = crate::watch::apply(
            &conn,
            root,
            r,
            &EventKind::Create(CreateKind::File),
            &[r.join("new.png")],
        );
        assert_eq!(delta(&conn, &t), (vec!["new.png".into()], vec![]));
        let added = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .find(|x| x.name == "new.png")
            .unwrap()
            .id;

        // Folder rename: same id, new path, tags kept.
        fs::rename(r.join("old"), r.join("moved")).unwrap();
        let t = crate::watch::apply(
            &conn,
            root,
            r,
            &EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &[r.join("old"), r.join("moved")],
        );
        let (rows, removed) = db::delta(&conn, &t).unwrap();
        assert!(removed.is_empty());
        assert_eq!(
            rows.iter()
                .map(|x| (x.id, x.rel_path.as_str(), x.tags.clone()))
                .collect::<Vec<_>>(),
            [(a, "moved/a.png", vec!["keep".to_string()])]
        );

        // Remove.
        fs::remove_file(r.join("new.png")).unwrap();
        let t = crate::watch::apply(
            &conn,
            root,
            r,
            &EventKind::Remove(RemoveKind::File),
            &[r.join("new.png")],
        );
        assert_eq!(delta(&conn, &t), (vec![], vec![added]));

        // Access events touch nothing.
        let t = crate::watch::apply(
            &conn,
            root,
            r,
            &EventKind::Access(AccessKind::Any),
            &[r.join("moved/a.png")],
        );
        assert!(t.is_empty());
    }

    #[test]
    fn sprite_sheet_survives_rename_and_rescan() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        png(&r.join("walk.png"), 256, 64);
        scan(&mut conn, root, r);
        let id = db::assets(&conn, None).unwrap()[0].id;
        assert_eq!(db::sprite_sheet(&conn, id).unwrap(), None);

        let sheet = db::SpriteSheet {
            cols: 4,
            rows: 1,
            fps: 12,
        };
        db::set_sprite_sheet(&conn, id, sheet).unwrap();
        let faster = db::SpriteSheet { fps: 24, ..sheet };
        db::set_sprite_sheet(&conn, id, faster).unwrap();
        assert!(db::set_sprite_sheet(&conn, id, db::SpriteSheet { cols: 0, ..sheet }).is_err());

        fs::rename(r.join("walk.png"), r.join("run.png")).unwrap();
        rename_path(&conn, root, r, &r.join("walk.png"), &r.join("run.png"), &mut vec![]).unwrap();
        scan(&mut conn, root, r);
        let all = db::assets(&conn, None).unwrap();
        assert_eq!((all.len(), all[0].id, all[0].name.as_str()), (1, id, "run.png"));
        assert_eq!(db::sprite_sheet(&conn, id).unwrap(), Some(faster));

        // Gone with the file (the watcher's path: a rescan of a root left empty keeps its rows).
        fs::remove_file(r.join("run.png")).unwrap();
        refresh_path(&conn, root, r, &r.join("run.png"), &mut vec![]).unwrap();
        let left: i64 = conn
            .query_row("SELECT count(*) FROM sprite_sheets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn user_ignored_folders_leave_on_rescan() {
        let (dir, mut conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("Exports-zz/old")).unwrap();
        fs::create_dir_all(r.join("art-zz")).unwrap();
        fs::create_dir_all(r.join("b")).unwrap();
        fs::write(r.join("Exports-zz/old/a.png"), "x").unwrap();
        fs::write(r.join("art-zz/c.png"), "x").unwrap();
        // A file named like an ignored folder.
        fs::write(r.join("b/exports-zz"), "x").unwrap();
        fs::write(r.join("b.png"), "x").unwrap();
        assert_eq!(scan(&mut conn, root, r), 4);
        // A second folder whose files are all under a folder about to be ignored.
        let only = tempfile::tempdir().unwrap();
        fs::create_dir_all(only.path().join("exports-zz")).unwrap();
        fs::write(only.path().join("exports-zz/d.png"), "x").unwrap();
        conn.execute(
            "INSERT INTO roots (path) VALUES (?1)",
            [only.path().display().to_string()],
        )
        .unwrap();
        let only_root = conn.last_insert_rowid();
        assert_eq!(scan(&mut conn, only_root, only.path()), 1);

        assert!(db::set_ignored_folders(&conn, &["art/old".into()]).is_err());
        let names = db::set_ignored_folders(
            &conn,
            &[
                " exports-ZZ ".into(),
                "EXPORTS-zz".into(),
                "Backup-zz".into(),
                "".into(),
            ],
        )
        .unwrap();
        assert_eq!(names, ["Backup-zz", "exports-ZZ"]);
        // The list is process-wide and tests run in parallel: only this test sets it, with names no other test uses.
        crate::kind::set_extra_ignored(&names);
        // A folder renamed to an ignored name leaves at once; folders already indexed leave on the next scan.
        fs::rename(r.join("art-zz"), r.join("backup-zz")).unwrap();
        rename_path(&conn, root, r, &r.join("art-zz"), &r.join("backup-zz"), &mut vec![]).unwrap();
        let renamed = rels(&conn);
        scan(&mut conn, root, r);
        // Its files leave too: it isn't empty, like an unmounted drive's mount point would be.
        let only_left = scan_touched(&mut conn, only_root, only.path()).0;
        let skipped = rels(&conn);
        crate::kind::set_extra_ignored(&[]);
        assert_eq!(only_left, Some(0));
        assert_eq!(
            renamed,
            ["Exports-zz/old/a.png", "b.png", "b/exports-zz", "exports-zz/d.png"]
        );
        assert_eq!(skipped, ["b.png", "b/exports-zz"]);

        scan(&mut conn, root, r);
        assert_eq!(
            rels(&conn),
            ["Exports-zz/old/a.png", "b.png", "b/exports-zz", "backup-zz/c.png"]
        );
    }

    #[test]
    fn refresh_adds_and_removes() {
        let (dir, conn, root) = setup();
        let r = dir.path();
        fs::create_dir_all(r.join("pack/sub")).unwrap();
        fs::write(r.join("pack/sub/a.glb"), "x").unwrap();
        refresh_path(&conn, root, r, &r.join("pack"), &mut vec![]).unwrap();
        assert_eq!(rels(&conn), ["pack/sub/a.glb"]);
        fs::remove_dir_all(r.join("pack")).unwrap();
        refresh_path(&conn, root, r, &r.join("pack"), &mut vec![]).unwrap();
        assert!(rels(&conn).is_empty());
        // Ignored paths are never added.
        fs::write(r.join("x.png.meta"), "x").unwrap();
        refresh_path(&conn, root, r, &r.join("x.png.meta"), &mut vec![]).unwrap();
        assert!(rels(&conn).is_empty());

        // Audio details aren't read under the lock: the watcher fills in just the files it saw, after it.
        crate::audio::tests::wav(&r.join("a.wav"), 8_000, 1, 16, 8_000);
        crate::audio::tests::wav(&r.join("b.wav"), 8_000, 1, 16, 8_000);
        refresh_path(&conn, root, r, &r.join("b.wav"), &mut vec![]).unwrap();
        let mut touched = vec![];
        refresh_path(&conn, root, r, &r.join("a.wav"), &mut touched).unwrap();
        let shared = Mutex::new(conn);
        crate::audio::fill_audio(&shared, root, r, &[], Some(&touched), |_, _| {}).unwrap();
        let conn = shared.into_inner().unwrap();
        let mut got: Vec<_> = db::assets(&conn, None)
            .unwrap()
            .into_iter()
            .map(|a| (a.name, a.duration_ms))
            .collect();
        got.sort();
        assert_eq!(got, [("a.wav".to_string(), Some(1000)), ("b.wav".to_string(), None)]);
    }
}

#[cfg(test)]
mod bench {
    /// `BENCH_DIR=<folder> cargo test --release scan_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scan_bench() {
        let dir = std::path::PathBuf::from(std::env::var("BENCH_DIR").unwrap());
        let tmp = tempfile::tempdir().unwrap();
        let conn = crate::db::open(&tmp.path().join("b.db")).unwrap();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [dir.display().to_string()])
            .unwrap();
        let db = std::sync::Mutex::new(conn);
        let t = std::time::Instant::now();
        let mut first = None;
        let n = super::scan_root(&db, 1, &dir, |_, _, _| {
            first.get_or_insert(t.elapsed());
        })
        .unwrap()
        .expect("BENCH_DIR can't be read");
        println!(
            "cold scan: {n} files in {:?}, first batch visible after {:?}",
            t.elapsed(),
            first.unwrap()
        );
        let t = std::time::Instant::now();
        super::scan_root(&db, 1, &dir, |_, _, _| {}).unwrap();
        println!("rescan: {:?}", t.elapsed());
    }
}

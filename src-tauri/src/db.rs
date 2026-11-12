use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::{Deserialize, Serialize};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS roots (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  hash TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  UNIQUE (root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS assets_size ON assets(size);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag)
);
CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS ignored_dups (hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS collection_assets (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, asset_id)
);
CREATE TABLE IF NOT EXISTS sprite_sheets (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  fps INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_info (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  size INTEGER,
  mtime INTEGER,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  bits INTEGER
);
CREATE TABLE IF NOT EXISTS ignored_folders (name TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS asset_meta (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  note TEXT
);
CREATE TABLE IF NOT EXISTS collection_rules (
  collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  filters TEXT NOT NULL /* JSON */
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
/* Suggest tags (tagging.rs): Claude's suggestions waiting for review, the tags accepted from them (for Remove all AI
   tags), the version of each asset already asked about, and the batches sent. */
CREATE TABLE IF NOT EXISTS tag_suggestions (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag)
);
CREATE TABLE IF NOT EXISTS ai_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag)
);
CREATE TABLE IF NOT EXISTS ai_asked (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  model TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_batches (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  created INTEGER NOT NULL, /* ms; the same for every batch of one run */
  items TEXT NOT NULL, /* JSON: custom_id -> [[asset id, size, mtime], ...] */
  done INTEGER NOT NULL DEFAULT 0,
  usage TEXT /* JSON token totals */
);
/* However a tag goes (removed, a duplicate merged away), it stops counting as Claude's; and a tag the asset gets by any
   way is no longer a suggestion. */
CREATE TRIGGER IF NOT EXISTS ai_tag_removed AFTER DELETE ON asset_tags BEGIN
  DELETE FROM ai_tags WHERE asset_id = OLD.asset_id AND tag = OLD.tag;
END;
CREATE TRIGGER IF NOT EXISTS suggestion_taken AFTER INSERT ON asset_tags BEGIN
  DELETE FROM tag_suggestions WHERE asset_id = NEW.asset_id AND tag = NEW.tag;
END;
/* Suggestions are about the file Claude saw: a changed file drops them (and counts as not asked, see tagging::asked). */
CREATE TRIGGER IF NOT EXISTS suggestions_stale AFTER UPDATE OF size, mtime ON assets
WHEN OLD.size IS NOT NEW.size OR OLD.mtime IS NOT NEW.mtime BEGIN
  DELETE FROM tag_suggestions WHERE asset_id = NEW.id;
END;
";

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Files indexed before their extension had a kind stay "other", since scans skip unchanged files: gives them their kind.
/// The next scan then reads image dimensions for them like for any new image.
pub fn reclassify(conn: &Connection) -> Result<()> {
    let exts = conn
        .prepare("SELECT DISTINCT ext FROM assets WHERE kind = 'other'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>>>()?;
    for ext in exts {
        let kind = crate::kind::kind_of(&ext);
        if kind != "other" {
            conn.execute(
                "UPDATE assets SET kind = ?2 WHERE kind = 'other' AND ext = ?1",
                params![ext, kind],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn open_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub id: i64,
    pub path: String,
    /// The folder can't be reached right now. Only `list_roots` checks; elsewhere it's false.
    pub missing: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: i64,
    pub root_id: i64,
    pub rel_path: String,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: String,
    pub size: i64,
    pub mtime: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub favorite: bool,
    pub tags: Vec<String>,
    /// Tags Claude suggested that the user hasn't accepted or rejected yet (tagging.rs).
    pub suggested: Vec<String>,
    /// 0 (unrated) to 5 stars.
    pub rating: u8,
    /// Audio details, when read from the current version of the file.
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bits: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    /// Empty for a smart collection: the UI computes its members from `rule`.
    pub asset_ids: Vec<i64>,
    pub rule: Option<Rule>,
}

/// A smart collection's saved search: the search-bar query and the Filters panel state (a JSON object).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rule {
    pub query: String,
    pub filters: serde_json::Value,
}

/// `rel` always uses `/`; join it component by component so paths use the OS separator.
pub fn abs_path(root: &str, rel: &str) -> PathBuf {
    rel.split('/').fold(PathBuf::from(root), |p, c| p.join(c))
}

pub fn roots(conn: &Connection) -> Result<Vec<Root>> {
    let mut stmt = conn.prepare("SELECT id, path FROM roots ORDER BY path")?;
    stmt.query_map([], |r| {
        Ok(Root {
            id: r.get(0)?,
            path: r.get(1)?,
            missing: false,
        })
    })?
    .collect()
}

pub fn root(conn: &Connection, id: i64) -> Result<Root> {
    conn.query_row("SELECT id, path FROM roots WHERE id = ?1", [id], |r| {
        Ok(Root {
            id: r.get(0)?,
            path: r.get(1)?,
            missing: false,
        })
    })
}

const TAG_SEP: char = '\u{1f}';

/// All assets, or only those with the given ids.
pub fn assets(conn: &Connection, only: Option<&[i64]>) -> Result<Vec<Asset>> {
    let roots: HashMap<i64, String> = roots(conn)?.into_iter().map(|r| (r.id, r.path)).collect();
    let mut stmt = conn.prepare(
        "SELECT a.id, a.root_id, a.rel_path, a.name, a.ext, a.kind, a.size, a.mtime, a.width, a.height, a.favorite,
                (SELECT group_concat(tag, char(31)) FROM asset_tags t WHERE t.asset_id = a.id), coalesce(m.rating, 0),
                i.duration_ms, i.sample_rate, i.channels, i.bits,
                (SELECT group_concat(tag, char(31)) FROM tag_suggestions s WHERE s.asset_id = a.id)
         FROM assets a LEFT JOIN asset_meta m ON m.asset_id = a.id
         LEFT JOIN audio_info i ON i.asset_id = a.id AND a.kind = 'audio' AND i.size = a.size AND i.mtime = a.mtime
         WHERE ?1 IS NULL OR a.id IN (SELECT value FROM json_each(?1))",
    )?;
    let only = only.map(|ids| serde_json::to_string(ids).unwrap_or_default());
    stmt.query_map([only], |r| {
        let root_id: i64 = r.get(1)?;
        let rel_path: String = r.get(2)?;
        let split = |s: Option<String>| {
            s.map(|t| t.split(TAG_SEP).map(String::from).collect())
                .unwrap_or_default()
        };
        Ok(Asset {
            id: r.get(0)?,
            root_id,
            path: abs_path(roots.get(&root_id).map(String::as_str).unwrap_or_default(), &rel_path)
                .display()
                .to_string(),
            rel_path,
            name: r.get(3)?,
            ext: r.get(4)?,
            kind: r.get(5)?,
            size: r.get(6)?,
            mtime: r.get(7)?,
            width: r.get(8)?,
            height: r.get(9)?,
            favorite: r.get(10)?,
            tags: split(r.get(11)?),
            suggested: split(r.get(17)?),
            rating: r.get(12)?,
            duration_ms: r.get(13)?,
            sample_rate: r.get(14)?,
            channels: r.get(15)?,
            bits: r.get(16)?,
        })
    })?
    .collect()
}

/// The current state of rows a change touched: rows that still exist, and the ids that are gone.
pub fn delta(conn: &Connection, touched: &[i64]) -> Result<(Vec<Asset>, Vec<i64>)> {
    let rows = assets(conn, Some(touched))?;
    let found: std::collections::HashSet<i64> = rows.iter().map(|a| a.id).collect();
    let mut removed: Vec<i64> = touched.iter().copied().filter(|id| !found.contains(id)).collect();
    removed.sort_unstable();
    removed.dedup();
    Ok((rows, removed))
}

pub fn asset(conn: &Connection, id: i64) -> std::result::Result<Asset, String> {
    assets(conn, Some(&[id]))
        .map_err(|e| e.to_string())?
        .pop()
        .ok_or_else(|| "That asset is no longer in the library. It may have been moved or deleted.".into())
}

pub fn set_favorite(conn: &Connection, ids: &[i64], favorite: bool) -> Result<()> {
    conn.execute(
        "UPDATE assets SET favorite = ?2 WHERE id IN (SELECT value FROM json_each(?1))",
        params![serde_json::to_string(ids).unwrap_or_default(), favorite],
    )?;
    Ok(())
}

pub fn set_rating(conn: &Connection, ids: &[i64], rating: u8) -> std::result::Result<(), String> {
    if rating > 5 {
        return Err("Ratings go from 0 to 5 stars.".into());
    }
    // Ids that are gone by now are skipped.
    conn.execute(
        "INSERT INTO asset_meta (asset_id, rating) SELECT value, ?2 FROM json_each(?1) WHERE value IN (SELECT id FROM assets)
         ON CONFLICT (asset_id) DO UPDATE SET rating = excluded.rating",
        params![serde_json::to_string(ids).unwrap_or_default(), rating],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub const NOTE_MAX: usize = 5000;

/// Every note, by asset id. Only assets with a note are in it, so it stays small next to the asset list.
pub fn notes(conn: &Connection) -> Result<HashMap<i64, String>> {
    let mut stmt = conn.prepare("SELECT asset_id, note FROM asset_meta WHERE note IS NOT NULL")?;
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

/// Saves a trimmed note; an empty one clears it. Returns what was stored.
pub fn set_note(conn: &Connection, id: i64, note: &str) -> std::result::Result<Option<String>, String> {
    let note = note.trim();
    if note.chars().count() > NOTE_MAX {
        return Err(format!("Notes can be up to {NOTE_MAX} characters."));
    }
    let note = (!note.is_empty()).then(|| note.to_string());
    conn.execute(
        "INSERT INTO asset_meta (asset_id, note) VALUES (?1, ?2) ON CONFLICT (asset_id) DO UPDATE SET note = ?2",
        params![id, note],
    )
    .map_err(|e| e.to_string())?;
    Ok(note)
}

/// Trims a user-typed tag; rejects empty, overlong and control-character tags.
pub fn clean_tag(tag: &str) -> std::result::Result<String, String> {
    let t = tag.trim();
    if t.is_empty() || t.chars().count() > 64 || t.chars().any(char::is_control) {
        return Err("Tags must be 1 to 64 characters, without control characters.".into());
    }
    Ok(t.to_lowercase())
}

/// Folder names the user chose to skip while scanning (Settings > Library), on top of [`crate::kind::ignored_name`].
pub fn ignored_folders(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM ignored_folders ORDER BY name COLLATE NOCASE")?;
    stmt.query_map([], |r| r.get(0))?.collect()
}

/// Replaces the ignored folder names and returns them cleaned: trimmed, without repeats that differ only in case.
/// Each must be a single folder name, not a path.
pub fn set_ignored_folders(conn: &Connection, names: &[String]) -> std::result::Result<Vec<String>, String> {
    let names: Vec<&str> = names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).collect();
    if let Some(bad) = names
        .iter()
        .find(|n| n.chars().count() > 255 || n.contains(['/', '\\']) || n.chars().any(char::is_control))
    {
        return Err(format!(
            "“{bad}” isn't a folder name. Enter one name, like Backup, not a path."
        ));
    }
    let save = || -> Result<Vec<String>> {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM ignored_folders", [])?;
        for n in &names {
            tx.execute("INSERT OR IGNORE INTO ignored_folders (name) VALUES (?1)", [n])?;
        }
        tx.commit()?;
        ignored_folders(conn)
    };
    save().map_err(|e| e.to_string())
}

/// One statement for all `ids`, so it applies to all or none; ids that are gone by now are skipped.
pub fn add_tag(conn: &Connection, ids: &[i64], tag: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO asset_tags (asset_id, tag)
         SELECT value, ?2 FROM json_each(?1) WHERE value IN (SELECT id FROM assets)",
        params![serde_json::to_string(ids).unwrap_or_default(), tag],
    )?;
    Ok(())
}

pub fn remove_tag(conn: &Connection, ids: &[i64], tag: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM asset_tags WHERE tag = ?2 AND asset_id IN (SELECT value FROM json_each(?1))",
        params![serde_json::to_string(ids).unwrap_or_default(), tag],
    )?;
    Ok(())
}

pub fn collections(conn: &Connection) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, (SELECT group_concat(asset_id) FROM collection_assets ca WHERE ca.collection_id = c.id),
                r.query, r.filters
         FROM collections c LEFT JOIN collection_rules r ON r.collection_id = c.id ORDER BY c.name COLLATE NOCASE",
    )?;
    stmt.query_map([], |r| {
        let ids: Option<String> = r.get(2)?;
        let query: Option<String> = r.get(3)?;
        let filters: Option<String> = r.get(4)?;
        Ok(Collection {
            id: r.get(0)?,
            name: r.get(1)?,
            asset_ids: ids
                .map(|s| s.split(',').filter_map(|i| i.parse().ok()).collect())
                .unwrap_or_default(),
            rule: query.map(|query| Rule {
                query,
                filters: filters
                    .and_then(|f| serde_json::from_str(&f).ok())
                    .unwrap_or_else(|| serde_json::json!({})),
            }),
        })
    })?
    .collect()
}

fn collection_name(conn: &Connection, name: &str, except: Option<i64>) -> std::result::Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Collection names must be 1 to 80 characters.".into());
    }
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM collections WHERE name = ?1", [name], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some_and(|id| Some(id) != except) {
        return Err(format!("A collection named \"{name}\" already exists."));
    }
    Ok(name.to_string())
}

/// A plain collection, or a smart one with `rule`.
pub fn create_collection(conn: &Connection, name: &str, rule: Option<&Rule>) -> std::result::Result<i64, String> {
    let name = collection_name(conn, name, None)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO collections (name) VALUES (?1)", [&name])
        .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    if let Some(rule) = rule {
        set_rule(&tx, id, rule)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn set_rule(conn: &Connection, id: i64, rule: &Rule) -> std::result::Result<(), String> {
    let filters = rule.filters.to_string();
    if rule.query.chars().count() > 500 || !rule.filters.is_object() || filters.len() > 20_000 {
        return Err("That search can't be saved: the query is over 500 characters or the filters are invalid.".into());
    }
    conn.execute(
        "INSERT INTO collection_rules (collection_id, query, filters) VALUES (?1, ?2, ?3)
         ON CONFLICT (collection_id) DO UPDATE SET query = ?2, filters = ?3",
        params![id, rule.query, filters],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn rename_collection(conn: &Connection, id: i64, name: &str) -> std::result::Result<String, String> {
    let name = collection_name(conn, name, Some(id))?;
    conn.execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| e.to_string())?;
    Ok(name)
}

/// Like [`add_tag`]: one statement, skipping ids that are gone.
pub fn set_in_collection(conn: &Connection, collection: i64, ids: &[i64], member: bool) -> Result<()> {
    let sql = if member {
        "INSERT OR IGNORE INTO collection_assets (collection_id, asset_id)
         SELECT ?1, value FROM json_each(?2) WHERE value IN (SELECT id FROM assets)"
    } else {
        "DELETE FROM collection_assets WHERE collection_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))"
    };
    conn.execute(sql, params![collection, serde_json::to_string(ids).unwrap_or_default()])?;
    Ok(())
}

/// How an image is sliced into animation frames. Keyed by asset id like tags, so it survives rescans and renames.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct SpriteSheet {
    pub cols: u32,
    pub rows: u32,
    pub fps: u32,
}

pub fn sprite_sheet(conn: &Connection, id: i64) -> Result<Option<SpriteSheet>> {
    conn.query_row(
        "SELECT cols, rows, fps FROM sprite_sheets WHERE asset_id = ?1",
        [id],
        |r| {
            Ok(SpriteSheet {
                cols: r.get(0)?,
                rows: r.get(1)?,
                fps: r.get(2)?,
            })
        },
    )
    .optional()
}

pub fn set_sprite_sheet(conn: &Connection, id: i64, s: SpriteSheet) -> std::result::Result<(), String> {
    if !(1..=1024).contains(&s.cols) || !(1..=1024).contains(&s.rows) || !(1..=60).contains(&s.fps) {
        return Err("Use 1 to 1024 columns and rows, and 1 to 60 fps.".into());
    }
    conn.execute(
        "INSERT INTO sprite_sheets (asset_id, cols, rows, fps) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (asset_id) DO UPDATE SET cols = ?2, rows = ?3, fps = ?4",
        params![id, s.cols, s.rows, s.fps],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_assets(n: i64) -> Connection {
        let conn = open_memory();
        conn.execute("INSERT INTO roots (path) VALUES ('/r')", []).unwrap();
        for i in 1..=n {
            conn.execute(
                "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime) VALUES (1, ?1, ?1, 'png', 'image', 1, 0)",
                [format!("{i}.png")],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn ratings_and_notes() {
        let conn = with_assets(3);
        set_rating(&conn, &[1, 2, 99], 4).unwrap(); // 99 doesn't exist: skipped
        set_rating(&conn, &[2], 0).unwrap();
        assert!(set_rating(&conn, &[1], 6).is_err());
        let ratings: Vec<u8> = assets(&conn, None).unwrap().iter().map(|a| a.rating).collect();
        assert_eq!(ratings, vec![4, 0, 0]);

        assert_eq!(
            set_note(&conn, 1, "  needs a 2x version \n").unwrap().as_deref(),
            Some("needs a 2x version")
        );
        set_note(&conn, 3, "temp").unwrap();
        assert_eq!(set_note(&conn, 3, "   ").unwrap(), None);
        assert!(set_note(&conn, 2, &"x".repeat(NOTE_MAX + 1)).is_err());
        assert!(set_note(&conn, 99, "gone").is_err());
        assert_eq!(notes(&conn).unwrap(), [(1, "needs a 2x version".to_string())].into());
        assert_eq!(assets(&conn, Some(&[1])).unwrap()[0].rating, 4); // the note kept the rating

        conn.execute("DELETE FROM assets WHERE id = 1", []).unwrap();
        assert!(notes(&conn).unwrap().is_empty());
    }

    #[test]
    fn reclassify_gives_old_rows_their_new_kind() {
        let conn = with_assets(1);
        for (name, ext) in [
            ("a.aseprite", "aseprite"),
            ("b.blend", "blend"),
            ("c.aif", "aif"),
            ("d.xyz", "xyz"),
        ] {
            conn.execute(
                "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime) VALUES (1, ?1, ?1, ?2, 'other', 1, 0)",
                [name, ext],
            )
            .unwrap();
        }
        reclassify(&conn).unwrap();
        let kinds: Vec<String> = assets(&conn, None).unwrap().into_iter().map(|a| a.kind).collect();
        assert_eq!(kinds, ["image", "image", "model", "audio", "other"]);
    }

    #[test]
    fn bulk_edits_skip_missing_ids() {
        let conn = with_assets(3);
        conn.execute("DELETE FROM assets WHERE id = 2", []).unwrap();
        add_tag(&conn, &[1, 2, 3], "keep").unwrap();
        set_favorite(&conn, &[1, 2, 3], true).unwrap();
        let c = create_collection(&conn, "Level", None).unwrap();
        set_in_collection(&conn, c, &[1, 2, 3], true).unwrap();
        let tagged: Vec<(Vec<String>, bool)> = assets(&conn, None)
            .unwrap()
            .into_iter()
            .map(|a| (a.tags, a.favorite))
            .collect();
        assert_eq!(tagged, vec![(vec!["keep".to_string()], true); 2]);
        assert_eq!(collections(&conn).unwrap()[0].asset_ids, vec![1, 3]);

        remove_tag(&conn, &[1, 2, 3], "keep").unwrap();
        set_in_collection(&conn, c, &[3, 2], false).unwrap();
        assert!(assets(&conn, None).unwrap().iter().all(|a| a.tags.is_empty()));
        assert_eq!(collections(&conn).unwrap()[0].asset_ids, vec![1]);
    }

    #[test]
    fn smart_collection_rules() {
        let conn = with_assets(1);
        let rule = Rule {
            query: "#player rating:>=4".into(),
            filters: serde_json::json!({ "exts": ["png"], "minRating": null }),
        };
        let smart = create_collection(&conn, "Best", Some(&rule)).unwrap();
        let plain = create_collection(&conn, "Level", None).unwrap();
        let bad = Rule {
            query: "x".into(),
            filters: serde_json::json!([1]),
        };
        assert!(create_collection(&conn, "Bad", Some(&bad)).is_err());
        assert!(
            set_rule(
                &conn,
                plain,
                &Rule {
                    query: "q".repeat(501),
                    filters: serde_json::json!({})
                }
            )
            .is_err()
        );

        let cols = collections(&conn).unwrap();
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["Best", "Level"]
        ); // "Bad" rolled back
        assert_eq!((cols[0].rule.as_ref(), cols[1].rule.as_ref()), (Some(&rule), None));

        let edited = Rule {
            query: "type:audio".into(),
            filters: serde_json::json!({}),
        };
        set_rule(&conn, smart, &edited).unwrap();
        assert_eq!(collections(&conn).unwrap()[0].rule, Some(edited));

        conn.execute("DELETE FROM collections WHERE id = ?1", [smart]).unwrap();
        let left: i64 = conn
            .query_row("SELECT count(*) FROM collection_rules", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}

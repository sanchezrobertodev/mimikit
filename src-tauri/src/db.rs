use std::collections::{HashMap, HashSet};
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
/* Tag groups (Style, Biome…), in `position` order; a tag is in at most one, and a tag without a row is ungrouped. A
   membership outlives the tag's last asset. AUTOINCREMENT so a deleted group's id is never reused: Undo brings it back. */
CREATE TABLE IF NOT EXISTS tag_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_group_members (
  tag TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE
);
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
/// The next scan then reads image dimensions for them like for any new image, and for DDS files left at 0×0 by 0.15.0,
/// which only read BC1–BC3 headers.
pub fn reclassify(conn: &Connection) -> Result<()> {
    // shortcut: runs every launch, so a broken .dds header is re-read once per launch (20 bytes); fine unless this grows.
    conn.execute(
        "UPDATE assets SET width = NULL, height = NULL WHERE ext = 'dds' AND width = 0",
        [],
    )?;
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

fn json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// A tag group and its tags, A–Z. A tag with no assets left stays in its group.
#[derive(Serialize, Debug, PartialEq)]
pub struct TagGroup {
    pub id: i64,
    pub name: String,
    pub tags: Vec<String>,
}

const GROUP_GONE: &str = "That tag group no longer exists.";

pub fn tag_groups(conn: &Connection) -> Result<Vec<TagGroup>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, (SELECT group_concat(tag, char(31)) FROM tag_group_members m WHERE m.group_id = g.id)
         FROM tag_groups g ORDER BY g.position, g.id",
    )?;
    stmt.query_map([], |r| {
        let mut tags: Vec<String> = r
            .get::<_, Option<String>>(2)?
            .map(|s| s.split(TAG_SEP).map(String::from).collect())
            .unwrap_or_default();
        tags.sort_unstable();
        Ok(TagGroup {
            id: r.get(0)?,
            name: r.get(1)?,
            tags,
        })
    })?
    .collect()
}

/// How a group is written in search, as `groupWord` in filter.ts: `#sound-fx:` for "Sound FX".
fn group_word(name: &str) -> String {
    let half = |c: char| match c {
        '：' | '＃' | '＞' | '＜' | '＝' => char::from_u32(c as u32 - 0xfee0).unwrap_or(c),
        _ => c,
    };
    name.chars()
        .map(half)
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// A trimmed group name: 1 to 64 characters without control characters or `:` (`#style:` searches a group), and no
/// other group's search word (`Sound FX` and `sound-fx` would both be `#sound-fx:`).
fn group_name(conn: &Connection, name: &str, except: Option<i64>) -> std::result::Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(|c| c.is_control() || c == ':') {
        return Err("Group names must be 1 to 64 characters, without control characters or colons.".into());
    }
    // Compared here: COLLATE NOCASE only folds ASCII letters.
    let word = group_word(name);
    let names = conn
        .prepare("SELECT id, name FROM tag_groups")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?;
    if let Some((_, taken)) = names
        .iter()
        .find(|(id, n)| Some(*id) != except && group_word(n) == word)
    {
        return Err(format!("A tag group named \"{taken}\" already exists."));
    }
    Ok(name.to_string())
}

/// A new group at the end of the list.
pub fn create_tag_group(conn: &Connection, name: &str) -> std::result::Result<i64, String> {
    let name = group_name(conn, name, None)?;
    conn.execute(
        "INSERT INTO tag_groups (name, position) SELECT ?1, coalesce(max(position) + 1, 0) FROM tag_groups",
        [&name],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_tag_group(conn: &Connection, id: i64, name: &str) -> std::result::Result<String, String> {
    let name = group_name(conn, name, Some(id))?;
    let n = conn
        .execute("UPDATE tag_groups SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(GROUP_GONE.into());
    }
    Ok(name)
}

/// Deletes a group; its tags become ungrouped. Returns what Undo needs to bring it back.
pub fn delete_tag_group(conn: &Connection, id: i64) -> Result<TagSnapshot> {
    let tags: Vec<String> = conn
        .prepare("SELECT tag FROM tag_group_members WHERE group_id = ?1")?
        .query_map([id], |r| r.get(0))?
        .collect::<Result<_>>()?;
    let snap = snapshot(conn, &tags, true, &[id])?;
    // ON DELETE CASCADE takes its members.
    conn.execute("DELETE FROM tag_groups WHERE id = ?1", [id])?;
    Ok(snap)
}

/// Moves a group to `position` in the list (0 is first, past the end is last).
pub fn move_tag_group(conn: &Connection, id: i64, position: usize) -> Result<()> {
    let mut ids: Vec<i64> = conn
        .prepare("SELECT id FROM tag_groups ORDER BY position, id")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_>>()?;
    let Some(at) = ids.iter().position(|&g| g == id) else {
        return Ok(());
    };
    ids.remove(at);
    ids.insert(position.min(ids.len()), id);
    let tx = conn.unchecked_transaction()?;
    for (i, g) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tag_groups SET position = ?2 WHERE id = ?1",
            params![g, i as i64],
        )?;
    }
    tx.commit()
}

/// Puts `tags` in a group, or with None makes them ungrouped. Returns what Undo needs.
pub fn set_tag_group(
    conn: &Connection,
    tags: &[String],
    group: Option<i64>,
) -> std::result::Result<TagSnapshot, String> {
    let tags = tags
        .iter()
        .map(|t| clean_tag(t))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let run = || -> Result<Option<TagSnapshot>> {
        if let Some(g) = group
            && conn
                .query_row("SELECT 1 FROM tag_groups WHERE id = ?1", [g], |_| Ok(()))
                .optional()?
                .is_none()
        {
            return Ok(None);
        }
        let snap = snapshot(conn, &tags, true, &[])?;
        let list = json(&tags);
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM tag_group_members WHERE tag IN (SELECT value FROM json_each(?1))",
            [&list],
        )?;
        if let Some(g) = group {
            tx.execute(
                "INSERT OR IGNORE INTO tag_group_members (tag, group_id) SELECT value, ?2 FROM json_each(?1)",
                params![list, g],
            )?;
        }
        tx.commit()?;
        Ok(Some(snap))
    };
    run().map_err(|e| e.to_string())?.ok_or_else(|| GROUP_GONE.into())
}

/// What a tag change replaces, for its Undo ([`restore_tags`]). Only the window's Undo keeps it.
#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagSnapshot {
    /// Restoring replaces every row of these tags with the ones below.
    tags: Vec<String>,
    /// Only the tags' groups were saved: their asset, AI and suggestion rows are left as they are.
    groups_only: bool,
    asset_tags: Vec<(i64, String)>,
    ai_tags: Vec<(i64, String)>,
    suggestions: Vec<(i64, String)>,
    members: Vec<(String, i64)>,
    /// Groups as they were (id, name, position), brought back if deleted since.
    groups: Vec<(i64, String, i64)>,
    /// The smart collections' rules that name the tags: collection id, query, filters (JSON).
    rules: Vec<(i64, String, String)>,
}

fn snapshot(conn: &Connection, tags: &[String], groups_only: bool, groups: &[i64]) -> Result<TagSnapshot> {
    let list = json(tags);
    let rows = |table: &str| -> Result<Vec<(i64, String)>> {
        if groups_only {
            return Ok(vec![]);
        }
        conn.prepare(&format!(
            "SELECT asset_id, tag FROM {table} WHERE tag IN (SELECT value FROM json_each(?1))"
        ))?
        .query_map([&list], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
    };
    let members = conn
        .prepare("SELECT tag, group_id FROM tag_group_members WHERE tag IN (SELECT value FROM json_each(?1))")?
        .query_map([&list], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_>>()?;
    let groups = conn
        .prepare("SELECT id, name, position FROM tag_groups WHERE id IN (SELECT value FROM json_each(?1))")?
        .query_map([json(groups)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_>>()?;
    let rules = if groups_only {
        vec![]
    } else {
        rules(conn)?
            .into_iter()
            .filter(|(_, q, f)| tags.iter().any(|t| mentions(q, f, t)))
            .collect()
    };
    Ok(TagSnapshot {
        tags: tags.to_vec(),
        groups_only,
        asset_tags: rows("asset_tags")?,
        ai_tags: rows("ai_tags")?,
        suggestions: rows("tag_suggestions")?,
        members,
        groups,
        rules,
    })
}

fn rules(conn: &Connection) -> Result<Vec<(i64, String, String)>> {
    conn.prepare("SELECT collection_id, query, filters FROM collection_rules")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect()
}

/// A `#tag` word of a saved search, also with the full-width ＃ that Japanese and Chinese input methods type.
fn is_tag_word(word: &str, tag: &str) -> bool {
    word.strip_prefix(['#', '＃']).is_some_and(|w| w.to_lowercase() == tag)
}

fn any_tags(filters: &serde_json::Value) -> impl Iterator<Item = &str> {
    filters
        .get("anyTags")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
}

/// Whether a smart collection's rule names `tag` exactly: a `#tag` word, or the tag in the Filters panel's tags.
fn mentions(query: &str, filters: &str, tag: &str) -> bool {
    let f: serde_json::Value = serde_json::from_str(filters).unwrap_or_default();
    query.split_whitespace().any(|w| is_tag_word(w, tag)) || any_tags(&f).any(|t| t == tag)
}

/// A rule with the `from` tags renamed to `to`, or None if it names none of them. Only exact `#from` words change, and
/// `#ui` matches by prefix: after renaming `ui` to `hud`, the rule's `#hud` no longer catches `ui-button` as `#ui` did.
fn renamed_rule(query: &str, filters: &str, from: &[String], to: &str) -> Option<(String, String)> {
    let named = |t: &str| from.iter().any(|f| f == t);
    let mut changed = false;
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| {
            if from.iter().any(|f| is_tag_word(w, f)) {
                changed = true;
                format!("#{to}")
            } else {
                w.to_string()
            }
        })
        .collect();
    let mut f: serde_json::Value = serde_json::from_str(filters).unwrap_or_else(|_| serde_json::json!({}));
    if any_tags(&f).any(named) {
        changed = true;
        let mut seen = HashSet::new();
        let list: Vec<serde_json::Value> = any_tags(&f)
            .map(|t| if named(t) { to } else { t })
            .filter(|t| seen.insert(t.to_string()))
            .map(Into::into)
            .collect();
        f["anyTags"] = list.into();
    }
    changed.then(|| (words.join(" "), f.to_string()))
}

/// Assets that have one of the tags (a JSON list), or a suggestion of one.
fn touched_by(conn: &Connection, list: &str) -> Result<Vec<i64>> {
    conn.prepare(
        "SELECT asset_id FROM asset_tags WHERE tag IN (SELECT value FROM json_each(?1))
         UNION SELECT asset_id FROM tag_suggestions WHERE tag IN (SELECT value FROM json_each(?1)) ORDER BY 1",
    )?
    .query_map([list], |r| r.get(0))?
    .collect()
}

/// Renames the `from` tags to `to` everywhere, in one transaction; when `to` exists already, that's a merge. Returns
/// the Undo snapshot and the assets whose tags or suggestions changed.
pub fn rename_tags(
    conn: &Connection,
    from: &[String],
    to: &str,
) -> std::result::Result<(TagSnapshot, Vec<i64>), String> {
    let to = clean_tag(to)?;
    let mut list = Vec::new();
    for f in from {
        let f = clean_tag(f)?;
        if f != to && !list.contains(&f) {
            list.push(f);
        }
    }
    let from = list;
    let run = || -> Result<(TagSnapshot, Vec<i64>)> {
        let all: Vec<String> = from.iter().cloned().chain([to.clone()]).collect();
        let snap = snapshot(conn, &all, false, &[])?;
        let list = json(&from);
        let tx = conn.unchecked_transaction()?;
        let touched = touched_by(&tx, &list)?;
        // `to` is Claude's on an asset that didn't have it and whose `from` tags were all Claude's.
        tx.execute(
            "INSERT OR IGNORE INTO ai_tags (asset_id, tag)
             SELECT t.asset_id, ?2 FROM asset_tags t
             WHERE t.tag IN (SELECT value FROM json_each(?1))
               AND t.asset_id NOT IN (SELECT asset_id FROM asset_tags WHERE tag = ?2)
             GROUP BY t.asset_id
             HAVING count(*) = (SELECT count(*) FROM ai_tags a
                                WHERE a.asset_id = t.asset_id AND a.tag IN (SELECT value FROM json_each(?1)))",
            params![list, to],
        )?;
        // A pending suggestion follows, unless the asset has `to`; one that gets `to` below drops it (suggestion_taken).
        tx.execute(
            "INSERT OR IGNORE INTO tag_suggestions (asset_id, tag)
             SELECT asset_id, ?2 FROM tag_suggestions
             WHERE tag IN (SELECT value FROM json_each(?1))
               AND asset_id NOT IN (SELECT asset_id FROM asset_tags WHERE tag = ?2)",
            params![list, to],
        )?;
        tx.execute(
            "DELETE FROM tag_suggestions WHERE tag IN (SELECT value FROM json_each(?1))",
            [&list],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO asset_tags (asset_id, tag)
             SELECT asset_id, ?2 FROM asset_tags WHERE tag IN (SELECT value FROM json_each(?1))",
            params![list, to],
        )?;
        // The ai_tag_removed trigger clears the `from` tags' AI marks.
        tx.execute(
            "DELETE FROM asset_tags WHERE tag IN (SELECT value FROM json_each(?1))",
            [&list],
        )?;
        // `to` keeps its own group, or takes the first grouped `from` tag's.
        tx.execute(
            "INSERT OR IGNORE INTO tag_group_members (tag, group_id)
             SELECT ?2, m.group_id FROM json_each(?1) j JOIN tag_group_members m ON m.tag = j.value
             ORDER BY j.key LIMIT 1",
            params![list, to],
        )?;
        tx.execute(
            "DELETE FROM tag_group_members WHERE tag IN (SELECT value FROM json_each(?1))",
            [&list],
        )?;
        for (id, q, f) in rules(&tx)? {
            if let Some((q, f)) = renamed_rule(&q, &f, &from, &to) {
                tx.execute(
                    "UPDATE collection_rules SET query = ?2, filters = ?3 WHERE collection_id = ?1",
                    params![id, q, f],
                )?;
            }
        }
        tx.commit()?;
        Ok((snap, touched))
    };
    run().map_err(|e| e.to_string())
}

/// Deletes tags from every asset, with their suggestions and groups, in one transaction. Smart collections' rules are
/// left as they are. Returns the Undo snapshot, how many rules name one of the tags, and the assets that changed.
pub fn delete_tags(conn: &Connection, tags: &[String]) -> std::result::Result<(TagSnapshot, usize, Vec<i64>), String> {
    let tags = tags
        .iter()
        .map(|t| clean_tag(t))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let run = || -> Result<(TagSnapshot, usize, Vec<i64>)> {
        let snap = snapshot(conn, &tags, false, &[])?;
        let list = json(&tags);
        let tx = conn.unchecked_transaction()?;
        let touched = touched_by(&tx, &list)?;
        // The ai_tag_removed trigger clears their AI marks.
        for table in ["asset_tags", "tag_suggestions", "tag_group_members"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE tag IN (SELECT value FROM json_each(?1))"),
                [&list],
            )?;
        }
        tx.commit()?;
        let rules = snap.rules.len();
        Ok((snap, rules, touched))
    };
    run().map_err(|e| e.to_string())
}

/// Puts a snapshot's rows back in one transaction, skipping assets, groups and collections deleted since. Returns the
/// assets whose tags or suggestions changed.
pub fn restore_tags(conn: &Connection, s: &TagSnapshot) -> Result<Vec<i64>> {
    let list = json(&s.tags);
    let ours = |t: &String| s.tags.contains(t);
    let tx = conn.unchecked_transaction()?;
    let mut touched = if s.groups_only { vec![] } else { touched_by(&tx, &list)? };
    for (id, name, position) in &s.groups {
        tx.execute(
            "INSERT OR IGNORE INTO tag_groups (id, name, position) VALUES (?1, ?2, ?3)",
            params![id, name, position],
        )?;
    }
    if !s.groups_only {
        // Deleting tags fires ai_tag_removed and inserting them suggestion_taken, so the AI marks and suggestions go last.
        for table in ["asset_tags", "ai_tags", "tag_suggestions"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE tag IN (SELECT value FROM json_each(?1))"),
                [&list],
            )?;
        }
        for (table, rows) in [
            ("asset_tags", &s.asset_tags),
            ("ai_tags", &s.ai_tags),
            ("tag_suggestions", &s.suggestions),
        ] {
            let mut stmt = tx.prepare(&format!(
                "INSERT OR IGNORE INTO {table} (asset_id, tag) SELECT ?1, ?2 WHERE ?1 IN (SELECT id FROM assets)"
            ))?;
            for (id, tag) in rows.iter().filter(|(_, t)| ours(t)) {
                stmt.execute(params![id, tag])?;
            }
        }
        touched.extend(s.asset_tags.iter().chain(&s.suggestions).map(|(id, _)| *id));
    }
    tx.execute(
        "DELETE FROM tag_group_members WHERE tag IN (SELECT value FROM json_each(?1))",
        [&list],
    )?;
    for (tag, group) in s.members.iter().filter(|(t, _)| ours(t)) {
        tx.execute(
            "INSERT INTO tag_group_members (tag, group_id) SELECT ?1, ?2 WHERE ?2 IN (SELECT id FROM tag_groups)",
            params![tag, group],
        )?;
    }
    for (id, query, filters) in &s.rules {
        tx.execute(
            "UPDATE collection_rules SET query = ?2, filters = ?3 WHERE collection_id = ?1",
            params![id, query, filters],
        )?;
    }
    tx.commit()?;
    touched.sort_unstable();
    touched.dedup();
    Ok(touched)
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
            ("a.dae", "dae"),
            ("b.dds", "dds"),
            ("c.aseprite", "aseprite"),
            ("d.blend", "blend"),
            ("e.aif", "aif"),
            ("f.xyz", "xyz"),
        ] {
            conn.execute(
                "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime) VALUES (1, ?1, ?1, ?2, 'other', 1, 0)",
                [name, ext],
            )
            .unwrap();
        }
        // A BC7 file 0.15.0 couldn't read gets its dimensions read again; a read one keeps them.
        conn.execute("UPDATE assets SET width = 0, height = 0 WHERE ext = 'dds'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO assets (root_id, rel_path, name, ext, kind, size, mtime, width, height)
             VALUES (1, 'g.dds', 'g.dds', 'dds', 'image', 1, 0, 4, 4)",
            [],
        )
        .unwrap();
        reclassify(&conn).unwrap();
        let kinds: Vec<String> = assets(&conn, None).unwrap().into_iter().map(|a| a.kind).collect();
        assert_eq!(
            kinds,
            ["image", "model", "image", "image", "model", "audio", "other", "image"]
        );
        let dims = |n: &str| {
            conn.query_row("SELECT width FROM assets WHERE name = ?1", [n], |r| r.get(0))
                .unwrap()
        };
        assert_eq!((dims("b.dds"), dims("g.dds")), (None::<i64>, Some(4)));
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

    fn tag(conn: &Connection, id: i64, t: &str) {
        add_tag(conn, &[id], t).unwrap();
    }
    /// A tag accepted from Claude's suggestions.
    fn ai(conn: &Connection, id: i64, t: &str) {
        tag(conn, id, t);
        conn.execute("INSERT INTO ai_tags (asset_id, tag) VALUES (?1, ?2)", params![id, t])
            .unwrap();
    }
    fn suggest(conn: &Connection, id: i64, t: &str) {
        conn.execute(
            "INSERT INTO tag_suggestions (asset_id, tag) VALUES (?1, ?2)",
            params![id, t],
        )
        .unwrap();
    }
    fn rows(conn: &Connection, table: &str) -> Vec<(i64, String)> {
        conn.prepare(&format!("SELECT asset_id, tag FROM {table} ORDER BY 1, 2"))
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
    fn pairs(v: &[(i64, &str)]) -> Vec<(i64, String)> {
        v.iter().map(|(i, t)| (*i, t.to_string())).collect()
    }
    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|t| t.to_string()).collect()
    }
    fn group_list(conn: &Connection) -> Vec<(String, Vec<String>)> {
        tag_groups(conn)
            .unwrap()
            .into_iter()
            .map(|g| (g.name, g.tags))
            .collect()
    }
    /// Every row a tag change can touch.
    fn dump(conn: &Connection) -> Vec<String> {
        let mut out = vec![];
        for sql in [
            "SELECT 'tag', asset_id, tag FROM asset_tags",
            "SELECT 'ai', asset_id, tag FROM ai_tags",
            "SELECT 'suggested', asset_id, tag FROM tag_suggestions",
            "SELECT 'member', tag, group_id FROM tag_group_members",
            "SELECT 'group', id, name || ' @' || position FROM tag_groups",
            "SELECT 'rule', collection_id, query || ' ' || filters FROM collection_rules",
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            let found = stmt.query_map([], |r| {
                Ok(format!(
                    "{} {:?} {:?}",
                    r.get::<_, String>(0)?,
                    r.get::<_, rusqlite::types::Value>(1)?,
                    r.get::<_, rusqlite::types::Value>(2)?
                ))
            });
            out.extend(found.unwrap().map(Result::unwrap));
        }
        out.sort();
        out
    }

    #[test]
    fn rename_and_merge_tags() {
        let conn = with_assets(3);
        tag(&conn, 1, "coin");
        tag(&conn, 2, "coin");
        tag(&conn, 2, "coins");
        tag(&conn, 3, "coins");
        let (_, touched) = rename_tags(&conn, &strings(&["coin"]), " Gold ").unwrap();
        assert_eq!(touched, [1, 2]);
        assert_eq!(
            rows(&conn, "asset_tags"),
            pairs(&[(1, "gold"), (2, "coins"), (2, "gold"), (3, "coins")])
        );
        // Asset 2 has both: it ends up with one.
        rename_tags(&conn, &strings(&["coins"]), "gold").unwrap();
        assert_eq!(
            rows(&conn, "asset_tags"),
            pairs(&[(1, "gold"), (2, "gold"), (3, "gold")])
        );
        assert!(rename_tags(&conn, &strings(&["gold"]), " ").is_err());
        assert!(rename_tags(&conn, &strings(&["gold"]), "GOLD").unwrap().1.is_empty());
    }

    #[test]
    fn renamed_tags_stay_claudes_or_the_users() {
        let conn = with_assets(4);
        ai(&conn, 1, "coin");
        tag(&conn, 1, "gold"); // the user's gold stays the user's
        ai(&conn, 2, "coin"); // Claude's alone stays Claude's
        tag(&conn, 3, "coin");
        ai(&conn, 4, "gold"); // Claude's gold stays Claude's
        tag(&conn, 4, "coin");
        rename_tags(&conn, &strings(&["coin"]), "gold").unwrap();
        assert_eq!(rows(&conn, "ai_tags"), pairs(&[(2, "gold"), (4, "gold")]));

        // Merging Claude's tag with the user's gives the user's.
        let conn = with_assets(1);
        ai(&conn, 1, "coin");
        tag(&conn, 1, "coins");
        rename_tags(&conn, &strings(&["coin", "coins"]), "loot").unwrap();
        assert_eq!(rows(&conn, "asset_tags"), pairs(&[(1, "loot")]));
        assert!(rows(&conn, "ai_tags").is_empty());
    }

    #[test]
    fn renamed_suggestions_follow() {
        let conn = with_assets(3);
        suggest(&conn, 1, "coin");
        suggest(&conn, 2, "coin");
        tag(&conn, 2, "gold"); // has gold already: dropped
        suggest(&conn, 3, "coins");
        tag(&conn, 3, "coin"); // gets gold from the merge: dropped
        rename_tags(&conn, &strings(&["coin", "coins"]), "gold").unwrap();
        assert_eq!(rows(&conn, "tag_suggestions"), pairs(&[(1, "gold")]));
        assert_eq!(rows(&conn, "asset_tags"), pairs(&[(2, "gold"), (3, "gold")]));
    }

    #[test]
    fn renamed_tags_keep_their_group() {
        let conn = with_assets(0);
        let loot = create_tag_group(&conn, "Loot").unwrap();
        let style = create_tag_group(&conn, "Style").unwrap();
        // A tag without assets keeps its group, and its new name takes it.
        set_tag_group(&conn, &strings(&["coin"]), Some(loot)).unwrap();
        rename_tags(&conn, &strings(&["coin"]), "gold").unwrap();
        assert_eq!(group_list(&conn)[0], ("Loot".into(), strings(&["gold"])));
        // A merge keeps the target's own group.
        set_tag_group(&conn, &strings(&["shiny"]), Some(style)).unwrap();
        rename_tags(&conn, &strings(&["gold"]), "shiny").unwrap();
        assert_eq!(
            group_list(&conn),
            [("Loot".into(), vec![]), ("Style".into(), strings(&["shiny"]))]
        );
    }

    #[test]
    fn renamed_tags_update_smart_collections() {
        let conn = with_assets(0);
        let rule = Rule {
            query: "type:image #Coin \u{ff03}coin #coinx #coin:".into(),
            filters: serde_json::json!({ "anyTags": ["coin", "gold", "coins"], "minRating": 3 }),
        };
        create_collection(&conn, "Loot", Some(&rule)).unwrap();
        let other = Rule {
            query: "#gem".into(),
            filters: serde_json::json!({}),
        };
        create_collection(&conn, "Gems", Some(&other)).unwrap();
        rename_tags(&conn, &strings(&["coin", "coins"]), "gold").unwrap();
        let rules: Vec<Option<Rule>> = collections(&conn).unwrap().into_iter().map(|c| c.rule).collect();
        assert_eq!(
            rules,
            [
                Some(other),
                Some(Rule {
                    query: "type:image #gold #gold #coinx #coin:".into(),
                    filters: serde_json::json!({ "anyTags": ["gold"], "minRating": 3 }),
                })
            ]
        );
    }

    #[test]
    fn deleting_a_tag_leaves_rules_alone() {
        let conn = with_assets(2);
        ai(&conn, 1, "coin");
        suggest(&conn, 2, "coin");
        tag(&conn, 2, "gold");
        let loot = create_tag_group(&conn, "Loot").unwrap();
        set_tag_group(&conn, &strings(&["coin"]), Some(loot)).unwrap();
        let rule = Rule {
            query: "#coin".into(),
            filters: serde_json::json!({}),
        };
        create_collection(&conn, "Loot", Some(&rule)).unwrap();
        let any = Rule {
            query: "#coins".into(),
            filters: serde_json::json!({ "anyTags": ["coin"] }),
        };
        create_collection(&conn, "Any", Some(&any)).unwrap();
        let (_, rules, touched) = delete_tags(&conn, &strings(&["coin"])).unwrap();
        assert_eq!((rules, touched), (2, vec![1, 2]));
        assert_eq!(rows(&conn, "asset_tags"), pairs(&[(2, "gold")]));
        assert!(rows(&conn, "ai_tags").is_empty() && rows(&conn, "tag_suggestions").is_empty());
        assert!(tag_groups(&conn).unwrap()[0].tags.is_empty());
        let kept: Vec<Option<Rule>> = collections(&conn).unwrap().into_iter().map(|c| c.rule).collect();
        assert_eq!(kept, [Some(any), Some(rule)]);
    }

    #[test]
    fn undo_puts_back_the_exact_rows() {
        let conn = with_assets(4);
        ai(&conn, 1, "coin");
        tag(&conn, 1, "gold");
        tag(&conn, 2, "coin");
        tag(&conn, 2, "coins");
        ai(&conn, 3, "coins");
        suggest(&conn, 3, "gold");
        suggest(&conn, 4, "coin");
        let loot = create_tag_group(&conn, "Loot").unwrap();
        let style = create_tag_group(&conn, "Style").unwrap();
        set_tag_group(&conn, &strings(&["coin", "gem"]), Some(loot)).unwrap();
        set_tag_group(&conn, &strings(&["gold"]), Some(style)).unwrap();
        let rule = Rule {
            query: "#coin #coins".into(),
            filters: serde_json::json!({ "anyTags": ["coins", "gold"] }),
        };
        create_collection(&conn, "Coins", Some(&rule)).unwrap();
        let start = dump(&conn);
        let undo = |snap: TagSnapshot| {
            assert_ne!(dump(&conn), start);
            restore_tags(&conn, &snap).unwrap();
            assert_eq!(dump(&conn), start);
        };
        undo(rename_tags(&conn, &strings(&["coin"]), "treasure").unwrap().0);
        undo(rename_tags(&conn, &strings(&["coin", "coins"]), "gold").unwrap().0);
        undo(delete_tags(&conn, &strings(&["coin"])).unwrap().0);
        undo(set_tag_group(&conn, &strings(&["coin", "gold"]), None).unwrap());
        undo(delete_tag_group(&conn, loot).unwrap());

        // Assets deleted since are skipped.
        let (snap, _, _) = delete_tags(&conn, &strings(&["coin"])).unwrap();
        conn.execute("DELETE FROM assets WHERE id = 2", []).unwrap();
        assert_eq!(restore_tags(&conn, &snap).unwrap(), [1, 2, 4]);
        assert_eq!(rows(&conn, "ai_tags"), pairs(&[(1, "coin"), (3, "coins")]));
        assert_eq!(rows(&conn, "tag_suggestions"), pairs(&[(3, "gold"), (4, "coin")]));
    }

    #[test]
    fn tag_group_names_and_order() {
        let conn = with_assets(0);
        let style = create_tag_group(&conn, " Style ").unwrap();
        let biome = create_tag_group(&conn, "Biome").unwrap();
        let ete = create_tag_group(&conn, "\u{c9}t\u{e9}").unwrap();
        let long = "x".repeat(65);
        for bad in [
            "style",
            "STYLE",
            "\u{e9}t\u{e9}",
            "",
            "  ",
            "a:b",
            "tab\there",
            long.as_str(),
        ] {
            assert!(create_tag_group(&conn, bad).is_err(), "{bad}");
        }
        assert!(rename_tag_group(&conn, biome, "style").is_err());
        assert_eq!(rename_tag_group(&conn, style, "STYLE").unwrap(), "STYLE");
        // Names that search the same, as `#sound-fx:`, clash.
        assert_eq!(group_word(" Sound\u{3000}FX ＝1 "), "sound-fx-=1");
        let sound = create_tag_group(&conn, "Sound FX").unwrap();
        for bad in ["sound-fx", "SOUND  FX", "Sound\u{3000}Fx"] {
            assert_eq!(
                create_tag_group(&conn, bad),
                Err("A tag group named \"Sound FX\" already exists.".into()),
                "{bad}"
            );
        }
        assert!(rename_tag_group(&conn, biome, "Sound-FX").is_err());
        assert_eq!(rename_tag_group(&conn, sound, "Sound-FX").unwrap(), "Sound-FX");
        delete_tag_group(&conn, sound).unwrap();
        assert!(rename_tag_group(&conn, 99, "Use").is_err());
        assert!(set_tag_group(&conn, &strings(&["x"]), Some(99)).is_err());
        move_tag_group(&conn, ete, 0).unwrap();
        move_tag_group(&conn, style, 9).unwrap();
        set_tag_group(&conn, &strings(&["pixel-art", "Low-Poly"]), Some(style)).unwrap();
        assert_eq!(
            group_list(&conn),
            [
                ("\u{c9}t\u{e9}".into(), vec![]),
                ("Biome".into(), vec![]),
                ("STYLE".into(), strings(&["low-poly", "pixel-art"]))
            ]
        );
        // Deleting a group ungroups its tags; a deleted group's id isn't reused.
        delete_tag_group(&conn, style).unwrap();
        let members: i64 = conn
            .query_row("SELECT count(*) FROM tag_group_members", [], |r| r.get(0))
            .unwrap();
        assert_eq!((members, group_list(&conn).len()), (0, 2));
        assert!(create_tag_group(&conn, "Use").unwrap() > style);
    }
}

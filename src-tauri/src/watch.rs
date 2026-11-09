//! Live folder watching: debounced file events are applied to the index and announced to the UI.

use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_full::notify::event::{EventKind, ModifyKind, RenameMode};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use crate::scan::{refresh_path, rename_path};

pub type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Applies one event and returns the ids of the rows it added, changed or removed. Renames move rows in place so
/// tags survive.
pub fn apply(conn: &Connection, root_id: i64, root: &std::path::Path, kind: &EventKind, paths: &[PathBuf]) -> Vec<i64> {
    let mut touched = Vec::new();
    let r = match (kind, paths) {
        (EventKind::Modify(ModifyKind::Name(RenameMode::Both)), [from, to]) => {
            rename_path(conn, root_id, root, from, to, &mut touched)
        }
        (EventKind::Access(_), _) => Ok(()),
        _ => paths
            .iter()
            .try_for_each(|p| refresh_path(conn, root_id, root, p, &mut touched)),
    };
    if let Err(e) = r {
        eprintln!("watch: {e}");
    }
    touched
}

pub fn start(app: AppHandle, root_id: i64, root: PathBuf) -> Result<Watcher, String> {
    let handler_root = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(400), None, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        // The OS dropped events (inotify queue overflow, FSEvents merged ones): only a full scan catches up.
        if events.iter().any(|e| e.need_rescan()) {
            let path = handler_root.display().to_string();
            crate::spawn_scan(
                app.clone(),
                crate::db::Root {
                    id: root_id,
                    path,
                    missing: false,
                },
            );
        }
        if events.iter().all(|e| matches!(e.kind, EventKind::Access(_))) {
            return;
        }
        let state = app.state::<AppState>();
        let touched = {
            let mut conn = state.db.lock().unwrap();
            // One commit (one fsync) for the whole batch, so copying in a big pack doesn't hold the lock for long.
            let tx = match conn.transaction() {
                Ok(tx) => tx,
                Err(e) => {
                    eprintln!("watch: {e}");
                    return;
                }
            };
            let touched: Vec<i64> = events
                .iter()
                .flat_map(|e| apply(&tx, root_id, &handler_root, &e.kind, &e.paths))
                .collect();
            if let Err(e) = tx.commit() {
                eprintln!("watch: {e}");
            }
            crate::emit_delta(&app, &conn, &touched);
            touched
        };
        let _ = app.emit("assets-changed", root_id);
        crate::analysis::changed(&app, &touched);
        crate::meaning::changed(&app, &touched);
        // Audio details are read without the lock: an MP3 is read to the end to count its frames.
        if !touched.is_empty()
            && let Err(e) =
                crate::audio::fill_audio(&state.db, root_id, &handler_root, &[], Some(&touched), |conn, ids| {
                    crate::emit_delta(&app, conn, ids)
                })
        {
            eprintln!("watch: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(debouncer)
}

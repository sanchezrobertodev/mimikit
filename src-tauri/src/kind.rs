use std::sync::RwLock;

/// What kind of asset a file is, decided by its extension alone.
pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tga" | "psd" | "tif" | "tiff" | "ico" | "svg" | "ase"
        | "aseprite" => "image",
        "wav" | "ogg" | "mp3" | "flac" | "m4a" | "aac" | "opus" | "aif" | "aiff" => "audio",
        "glb" | "gltf" | "obj" | "fbx" | "stl" | "blend" => "model",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        "mp4" | "webm" | "mov" | "m4v" => "video",
        "txt" | "md" | "json" | "csv" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "glsl" | "hlsl" | "frag"
        | "vert" | "shader" | "gdshader" | "wgsl" | "lua" | "cs" | "gd" | "tres" | "tscn" | "mtl" | "atlas" | "tmx"
        | "tsx" => "text",
        _ => "other",
    }
}

/// Image formats the backend decodes itself (for thumbnails, and for previews of formats the webview can't show).
pub const DECODABLE: [&str; 13] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tga", "psd", "tif", "tiff", "ico", "ase", "aseprite",
];

pub fn decodable(ext: &str) -> bool {
    DECODABLE.contains(&ext)
}

/// Files the backend draws a thumbnail and preview of: the images it decodes, and .blend files from the picture Blender
/// saves in them.
pub fn drawable(ext: &str) -> bool {
    decodable(ext) || ext == "blend"
}

/// Sounds the webview can't play: the backend converts them to WAV first (audio::to_wav).
pub fn needs_wav(ext: &str) -> bool {
    matches!(ext, "aif" | "aiff")
}

/// [`DECODABLE`] as an SQL list, for `ext IN (...)`.
pub fn decodable_sql() -> String {
    DECODABLE.iter().map(|e| format!("'{e}'")).collect::<Vec<_>>().join(",")
}

/// Folder names the user chose to skip (Settings > Library), lowercased. Process-wide so scans and watcher events
/// see the current list without passing it through every path check.
static EXTRA_IGNORED: RwLock<Vec<String>> = RwLock::new(Vec::new());

pub fn set_extra_ignored(names: &[String]) {
    *EXTRA_IGNORED.write().unwrap() = names.iter().map(|n| n.to_lowercase()).collect();
}

/// Engine sidecar files, OS junk, hidden files and dependency folders are never indexed.
pub fn ignored_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with('.')
        || n.ends_with(".meta")
        || n.ends_with(".import")
        || n.ends_with(".uid")
        || matches!(
            n.as_str(),
            "thumbs.db" | "desktop.ini" | "node_modules" | "$recycle.bin" | "system volume information"
        )
}

/// A folder is also skipped when its name is on the user's list; a file with that name is not.
pub fn ignored_dir(name: &str) -> bool {
    ignored_name(name) || EXTRA_IGNORED.read().unwrap().contains(&name.to_lowercase())
}

/// True when a `/`-separated relative path is ignored: any folder in it, or its last part. `last_is_dir` is only
/// asked when the last part is on the user's folder list, so most paths need no extra stat.
pub fn ignored_rel(rel: &str, last_is_dir: impl FnOnce() -> bool) -> bool {
    let mut parts = rel.rsplit('/');
    let last = parts.next().unwrap_or_default();
    parts.any(ignored_dir) || ignored_name(last) || (ignored_dir(last) && last_is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of("png"), "image");
        assert_eq!(kind_of("ogg"), "audio");
        assert_eq!(kind_of("fbx"), "model");
        assert_eq!(kind_of("woff2"), "font");
        assert_eq!(kind_of("webm"), "video");
        assert_eq!(kind_of("gdshader"), "text");
        assert_eq!(kind_of("blend"), "model");
        assert_eq!(kind_of("aseprite"), "image");
        assert_eq!(kind_of("aif"), "audio");
        assert!(decodable("tga") && decodable("psd") && decodable("ase") && !decodable("svg"));
        assert!(drawable("blend") && !decodable("blend") && !drawable("fbx"));
    }

    #[test]
    fn ignores_sidecars_and_hidden() {
        assert!(ignored_name("hero.png.meta"));
        assert!(ignored_name("icon.svg.import"));
        assert!(ignored_name(".git"));
        assert!(ignored_name("Thumbs.db"));
        assert!(!ignored_name("hero.png"));
        assert!(ignored_rel("art/.cache/a.png", || false));
        assert!(ignored_rel("art/x.png.meta", || false));
        assert!(!ignored_rel("art/sprites/a.png", || false));
        // A drive-root library: files deleted in Explorer move into the Recycle Bin.
        assert!(ignored_rel("$RECYCLE.BIN/S-1-5-21-1/$RAB12CD.png", || false));
        assert!(ignored_name("System Volume Information"));
    }
}

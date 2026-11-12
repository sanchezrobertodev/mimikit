//! Thumbnails and full-size previews, cached as PNGs in the app cache. Source files are only read.

use std::path::{Path, PathBuf};

use image::{DynamicImage, RgbaImage};

pub const THUMB_SIZE: u32 = 256;
const PREVIEW_MAX: u32 = 4096;

/// Cache file name for a given version of a file: changes when the file does.
pub fn cache_name(path: &str, size: i64, mtime: i64) -> String {
    // The frontend renders model thumbnails. A new version makes old ones render again: some were saved blank after a
    // lost WebGL context, and OBJs were grey before .mtl support.
    let ext = path
        .rsplit_once('.')
        .map_or(String::new(), |(_, e)| e.to_ascii_lowercase());
    let v = if crate::kind::kind_of(&ext) == "model" {
        "|v2"
    } else {
        ""
    };
    let h = blake3::hash(format!("{path}|{size}|{mtime}{v}").as_bytes());
    format!("{}.png", &h.to_hex()[..32])
}

/// Cache file name for a font's sample line, which the window draws for Suggest tags. Apart from thumbnails, so font cards
/// and drag icons stay as they are.
pub fn sample_name(path: &str, size: i64, mtime: i64) -> String {
    let h = blake3::hash(format!("{path}|{size}|{mtime}|sample").as_bytes());
    format!("{}.png", &h.to_hex()[..32])
}

/// Cache file name for a thumbnail the frontend rendered from version `rendered` (size, mtime) of the file. Errors when
/// the file has changed since, so a frame of the old contents is never stored under the new version's name.
pub fn rendered_name(path: &str, current: (i64, i64), rendered: (i64, i64)) -> Result<String, String> {
    if current != rendered {
        return Err("The file changed while its thumbnail was rendered".into());
    }
    Ok(cache_name(path, current.0, current.1))
}

/// Decodes the whole original image (PSD: its flattened composite; Aseprite: its first frame; .blend: the preview
/// Blender saved in it).
pub fn decode(path: &Path, ext: &str) -> Result<DynamicImage, String> {
    // Decoders can panic on a bad file (psd does on ZIP-compressed and truncated ones): that file then fails instead.
    std::panic::catch_unwind(|| {
        match ext {
            "ase" | "aseprite" => {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                return crate::aseprite::first_frame(&bytes).map(DynamicImage::ImageRgba8);
            }
            "blend" => return crate::blend::preview(path).map(DynamicImage::ImageRgba8),
            _ => {}
        }
        if ext == "psd" {
            // shortcut: uses the flattened composite only, so some layered/16-bit files fail and show an icon instead.
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let psd = psd::Psd::from_bytes(&bytes).map_err(|e| e.to_string())?;
            let img = RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or("PSD has an unexpected size")?;
            return Ok(DynamicImage::ImageRgba8(img));
        }
        image::open(path).map_err(|e| e.to_string())
    })
    .unwrap_or_else(|_| Err("Mimikit couldn't read this image.".into()))
}

/// Writes a PNG of at most `max` px on its long side to `out`, unless it's already cached.
fn render(src: &Path, ext: &str, out: &Path, max: u32) -> Result<PathBuf, String> {
    if out.exists() {
        return Ok(out.to_path_buf());
    }
    let img = decode(src, ext)?;
    let img = if img.width() > max || img.height() > max {
        img.thumbnail(max, max)
    } else {
        img
    };
    // Write to a temp name first so a half-written file is never served.
    let tmp = out.with_extension("tmp");
    img.save_with_format(&tmp, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(out.to_path_buf())
}

pub fn thumbnail(src: &Path, ext: &str, out: &Path) -> Result<PathBuf, String> {
    render(src, ext, out, THUMB_SIZE)
}

pub fn preview(src: &Path, ext: &str, out: &Path) -> Result<PathBuf, String> {
    render(src, ext, out, PREVIEW_MAX)
}

/// Stores a thumbnail rendered by the frontend (3D models), after checking it really is a small PNG.
pub fn save_png(bytes: &[u8], out: &Path) -> Result<(), String> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    if img.width() > THUMB_SIZE * 2 || img.height() > THUMB_SIZE * 2 {
        return Err("Thumbnail is too large".into());
    }
    std::fs::write(out, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnails_are_cached_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("big.tga");
        RgbaImage::new(1024, 512).save(&src).unwrap();
        let out = dir.path().join(cache_name("big.tga", 1, 2));
        thumbnail(&src, "tga", &out).unwrap();
        let t = image::open(&out).unwrap();
        assert_eq!((t.width(), t.height()), (256, 128));
        assert_ne!(cache_name("a", 1, 2), cache_name("a", 1, 3));
        // Model thumbnails carry a version, so a bump re-renders them.
        let unversioned = |p: &str| format!("{}.png", &blake3::hash(format!("{p}|1|2").as_bytes()).to_hex()[..32]);
        assert_eq!(cache_name("a.png", 1, 2), unversioned("a.png"));
        assert_ne!(cache_name("a.GLB", 1, 2), unversioned("a.GLB"));
        assert!(save_png(b"not a png", &dir.path().join("x.png")).is_err());
        assert_eq!(rendered_name("a", (1, 2), (1, 2)), Ok(cache_name("a", 1, 2)));
        assert!(rendered_name("a", (1, 3), (1, 2)).is_err());
        assert!(rendered_name("a", (5, 2), (1, 2)).is_err());
        assert_ne!(sample_name("a.ttf", 1, 2), cache_name("a.ttf", 1, 2));
    }

    #[test]
    fn a_psd_the_decoder_panics_on_is_an_error() {
        // 1×1 RGB with empty colour, resource and layer sections, then ZIP-compressed image data: psd 0.3 panics on it.
        let mut psd = b"8BPS\0\x01\0\0\0\0\0\0\0\x03".to_vec();
        psd.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 3]);
        psd.extend_from_slice(&[0; 12]);
        psd.extend_from_slice(&[0, 2]);
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("deep.psd");
        std::fs::write(&src, psd).unwrap();
        assert!(decode(&src, "psd").is_err());
        assert!(thumbnail(&src, "psd", &dir.path().join("t.png")).is_err());
    }
}

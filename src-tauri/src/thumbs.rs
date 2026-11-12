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

const UNREADABLE: &str = "Mimikit couldn't read this image.";

/// Decodes the whole original image (PSD: its flattened composite; EXR and HDR: tone mapped to 8 bits).
pub fn decode(path: &Path, ext: &str) -> Result<DynamicImage, String> {
    // Decoders can panic on a bad file (psd does on ZIP-compressed and truncated ones): that file then fails instead.
    std::panic::catch_unwind(|| {
        if ext == "psd" {
            // shortcut: uses the flattened composite only, so some layered/16-bit files fail and show an icon instead.
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let psd = psd::Psd::from_bytes(&bytes).map_err(|e| e.to_string())?;
            let img = RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or("PSD has an unexpected size")?;
            return Ok(DynamicImage::ImageRgba8(img));
        }
        image::open(path).map(tone_map).map_err(|e| match e {
            // A variant the decoder doesn't do, like a BC7 DDS: the card keeps its icon, the panel says so plainly.
            image::ImageError::Unsupported(_) => UNREADABLE.into(),
            e => e.to_string(),
        })
    })
    .unwrap_or_else(|_| Err(UNREADABLE.into()))
}

/// EXR and HDR hold linear light that goes past 1.0: Reinhard (c / (1 + c)) and a 2.2 gamma bring it into 8 bits
/// without blowing out the highlights. Other images pass through.
fn tone_map(img: DynamicImage) -> DynamicImage {
    if !matches!(img, DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_)) {
        return img;
    }
    let mut f = img.into_rgba32f();
    for p in f.pixels_mut() {
        for c in &mut p.0[..3] {
            let v = c.max(0.0);
            *c = (v / (1.0 + v)).powf(1.0 / 2.2);
        }
    }
    DynamicImage::ImageRgba32F(f).into_rgba8().into()
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

    /// A 4×4 DDS with one 8-byte block, and a DX10 header when `dxgi` is set.
    fn dds(fourcc: &[u8; 4], dxgi: Option<u32>, block: [u8; 8]) -> Vec<u8> {
        let mut b = b"DDS ".to_vec();
        // Size, flags (caps, height, width, pixel format), height, width, linear size, depth, mipmaps; reserved.
        for v in [124u32, 0x1007, 4, 4, 8, 0, 0] {
            b.extend(v.to_le_bytes());
        }
        b.extend([0; 44]);
        // Pixel format: its size, the "has a FourCC" flag, the FourCC, unused masks. Then caps (texture) and the rest.
        b.extend(32u32.to_le_bytes());
        b.extend(4u32.to_le_bytes());
        b.extend(fourcc);
        b.extend([0; 20]);
        b.extend(0x1000u32.to_le_bytes());
        b.extend([0; 16]);
        // DX10: format, 2D texture, no flags, one layer, no alpha mode.
        for v in dxgi.map_or(vec![], |f| vec![f, 3, 0, 1, 0]) {
            b.extend(v.to_le_bytes());
        }
        b.extend(block);
        b
    }

    #[test]
    fn exr_is_tone_mapped_and_dds_decodes_unless_bc7() {
        let dir = tempfile::tempdir().unwrap();
        let exr = dir.path().join("sky.exr");
        // Linear light: 4.0 is four times white and must not clip; 0.25 is a dim grey.
        image::Rgb32FImage::from_fn(2, 1, |x, _| image::Rgb([if x == 0 { 4.0 } else { 0.25 }; 3]))
            .save(&exr)
            .unwrap();
        let img = decode(&exr, "exr").unwrap();
        let px = img.as_rgba8().expect("8-bit after tone mapping");
        // (4 / 5)^(1 / 2.2) and (0.25 / 1.25)^(1 / 2.2), out of 255.
        assert_eq!(px.get_pixel(0, 0).0, [230, 230, 230, 255]);
        assert_eq!(px.get_pixel(1, 0).0, [123, 123, 123, 255]);
        assert!(thumbnail(&exr, "exr", &dir.path().join("exr.png")).is_ok());

        // DXT1, one block of colour 0 (pure red in RGB565).
        let dxt1 = dir.path().join("red.dds");
        std::fs::write(&dxt1, dds(b"DXT1", None, [0x00, 0xF8, 0x1F, 0x00, 0, 0, 0, 0])).unwrap();
        let img = decode(&dxt1, "dds").unwrap();
        assert_eq!((img.width(), img.height()), (4, 4));
        assert_eq!(img.to_rgba8().get_pixel(3, 3).0, [255, 0, 0, 255]);

        // BC7 (DXGI format 98) isn't decoded: a plain error, so the card keeps its icon.
        let bc7 = dir.path().join("bc7.dds");
        std::fs::write(&bc7, dds(b"DX10", Some(98), [0; 8])).unwrap();
        assert_eq!(decode(&bc7, "dds").unwrap_err(), UNREADABLE);
        assert!(thumbnail(&bc7, "dds", &dir.path().join("bc7.png")).is_err());
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

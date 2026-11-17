//! Thumbnails and full-size previews, cached as PNGs in the app cache. Source files are only read.

use std::path::{Path, PathBuf};

use image::{DynamicImage, RgbaImage};
use image_dds::ddsfile::{D3DFormat, Dds, DxgiFormat, PixelFormatFlags};
use image_dds::{ImageFormat as Dxf, Surface};

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

/// Decodes the whole original image (PSD: its flattened composite; DDS: its top mip level; EXR, HDR and float DDS: tone
/// mapped to 8 bits; Aseprite: its first frame; .blend: the preview Blender saved in it).
pub fn decode(path: &Path, ext: &str) -> Result<DynamicImage, String> {
    // Decoders can panic on a bad file (psd does on ZIP-compressed and truncated ones): that file then fails instead.
    std::panic::catch_unwind(|| {
        match ext {
            "ase" | "aseprite" => {
                let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
                return crate::aseprite::first_frame(&bytes).map(DynamicImage::ImageRgba8);
            }
            "blend" => return crate::blend::preview(path).map(DynamicImage::ImageRgba8),
            "dds" => return dds(path).map(tone_map),
            _ => {}
        }
        if ext == "psd" {
            // shortcut: uses the flattened composite only, so some layered/16-bit files fail and show an icon instead.
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let psd = psd::Psd::from_bytes(&bytes).map_err(|e| e.to_string())?;
            let img = RgbaImage::from_raw(psd.width(), psd.height(), psd.rgba()).ok_or("PSD has an unexpected size")?;
            return Ok(DynamicImage::ImageRgba8(img));
        }
        image::open(path).map(tone_map).map_err(|e| match e {
            // A variant the decoder doesn't do: the card keeps its icon, the panel says so plainly.
            image::ImageError::Unsupported(_) => UNREADABLE.into(),
            e => e.to_string(),
        })
    })
    .unwrap_or_else(|_| Err(UNREADABLE.into()))
}

/// The top mip level of a DDS texture's first layer and depth slice (a cube map's first face). BC6H and the float formats
/// come out as linear light for [`tone_map`]. BC5 is drawn as the normal map it usually is, with blue rebuilt.
fn dds(path: &Path) -> Result<DynamicImage, String> {
    let dds = Dds::read(std::fs::read(path).map_err(|e| e.to_string())?.as_slice()).map_err(|e| e.to_string())?;
    let (d3d, dxgi, pf) = (dds.get_d3d_format(), dds.get_dxgi_format(), &dds.header.spf);
    // BGRX and RGBX: the fourth byte is unused, not alpha.
    let x8 = matches!(d3d, Some(D3DFormat::X8R8G8B8 | D3DFormat::X8B8G8R8))
        || matches!(dxgi, Some(DxgiFormat::B8G8R8X8_UNorm | DxgiFormat::B8G8R8X8_UNorm_sRGB));
    // Legacy luminance headers by bit count and alpha mask: ddsfile reads no colour masks for them, so it misses them.
    let lum = pf
        .flags
        .contains(PixelFormatFlags::LUMINANCE)
        .then_some((pf.rgb_bit_count, pf.a_bit_mask));
    // Layouts image_dds doesn't name: L8 and A8L8 (the legacy headers for R8 and RG8), BGRX and RGBX, and the
    // typeless BC1–BC3 the image crate read.
    let format = match (image_dds::dds_image_format(&dds), dxgi) {
        (Ok(f), _) => f,
        _ if lum == Some((Some(8), None)) => Dxf::R8Unorm,
        _ if lum == Some((Some(16), Some(0xff00))) => Dxf::Rg8Unorm,
        _ if d3d == Some(D3DFormat::X8B8G8R8) => Dxf::Rgba8Unorm,
        _ if x8 => Dxf::Bgra8Unorm,
        (_, Some(DxgiFormat::BC1_Typeless)) => Dxf::BC1RgbaUnorm,
        (_, Some(DxgiFormat::BC2_Typeless)) => Dxf::BC2RgbaUnorm,
        (_, Some(DxgiFormat::BC3_Typeless)) => Dxf::BC3RgbaUnorm,
        _ => return Err(UNREADABLE.into()),
    };
    let float = matches!(
        format,
        Dxf::BC6hRgbUfloat
            | Dxf::BC6hRgbSfloat
            | Dxf::Rgba16Float
            | Dxf::Rgba32Float
            | Dxf::R16Float
            | Dxf::Rg16Float
            | Dxf::R32Float
            | Dxf::Rg32Float
            | Dxf::Rgb32Float
    );
    let (width, height) = (dds.get_width(), dds.get_height());
    // The 512 MiB image::open allows for decoded pixels, so a huge texture fails instead of exhausting memory.
    if u64::from(width) * u64::from(height) > (512 << 20) / if float { 16 } else { 4 } {
        return Err(UNREADABLE.into());
    }
    // Layer 0, depth slice 0 and mip 0 come first in the data whatever the counts, so a 1-layer, 1-mip view reads them.
    let surface = Surface {
        width,
        height,
        depth: 1,
        layers: 1,
        mipmaps: 1,
        image_format: format,
        data: &dds.data[..],
    };
    if float {
        let f = surface.decode_rgbaf32().map_err(|e| e.to_string())?;
        return Ok(DynamicImage::ImageRgba32F(f.into_image().map_err(|e| e.to_string())?));
    }
    let mut img = surface
        .decode_rgba8()
        .map_err(|e| e.to_string())?
        .into_image()
        .map_err(|e| e.to_string())?;
    let bc5 = matches!(format, Dxf::BC5RgUnorm | Dxf::BC5RgSnorm);
    if x8 || bc5 {
        for p in img.pixels_mut() {
            p[3] = 255;
            if bc5 {
                // z = √(1 − x² − y²), each channel mapped from 0..255 to −1..1 and back.
                let [x, y] = [p[0], p[1]].map(|c| f32::from(c) / 127.5 - 1.0);
                p[2] = ((1.0 - x * x - y * y).max(0.0).sqrt() * 127.5 + 127.5).round() as u8;
            }
        }
    }
    Ok(DynamicImage::ImageRgba8(img))
}

/// EXR, HDR and float DDS hold linear light that goes past 1.0: Reinhard (c / (1 + c)) and a 2.2 gamma bring it into 8 bits
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
    save(&img, out)
}

/// Writes `img` as a PNG to `out`, through a temp name so a half-written file is never served.
fn save(img: &DynamicImage, out: &Path) -> Result<PathBuf, String> {
    let tmp = out.with_extension("tmp");
    img.save_with_format(&tmp, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(out.to_path_buf())
}

/// Writes every frame of an Aseprite file (its bytes) side by side to `out`, unless it's already cached.
pub fn aseprite_strip(bytes: &[u8], out: &Path) -> Result<PathBuf, String> {
    if out.exists() {
        return Ok(out.to_path_buf());
    }
    save(&DynamicImage::ImageRgba8(crate::aseprite::strip(bytes)?), out)
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
    fn exr_is_tone_mapped() {
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
    }

    /// A `w`×`h` DDS: its header, a DX10 header when `dxgi` is set, then `data`. `pf` is the pixel format after its
    /// size: flags, FourCC, bit count, then the red, green, blue and alpha masks.
    fn dds(w: u32, h: u32, pf: [u32; 7], dxgi: Option<u32>, data: &[u8]) -> Vec<u8> {
        let mut b = b"DDS ".to_vec();
        // Size, flags (caps, height, width, pixel format), height, width, pitch, depth, mipmaps; reserved.
        for v in [124, 0x1007, h, w, 0, 0, 0] {
            b.extend(v.to_le_bytes());
        }
        b.extend([0; 44]);
        // The pixel format's size and `pf`, then caps (texture) and the rest. DX10: format, 2D texture, no flags, one
        // layer, no alpha mode.
        let dx10 = dxgi.map_or(vec![], |f| vec![f, 3, 0, 1, 0]);
        for v in [32].into_iter().chain(pf).chain([0x1000, 0, 0, 0, 0]).chain(dx10) {
            b.extend(v.to_le_bytes());
        }
        b.extend(data);
        b
    }

    /// A 16-byte BC6H or BC7 block of (value, bit width) fields, packed from the lowest bit up; the rest is 0.
    fn block(fields: &[(u128, u32)]) -> [u8; 16] {
        let (mut v, mut at) = (0u128, 0);
        for &(f, n) in fields {
            v |= f << at;
            at += n;
        }
        v.to_le_bytes()
    }

    #[test]
    fn dds_formats_decode_to_known_pixels() {
        let fourcc = |c: &[u8; 4]| [4, u32::from_le_bytes(*c), 0, 0, 0, 0, 0];
        let dx10 = fourcc(b"DX10");
        // Legacy uncompressed formats: flags (RGB 0x40, has alpha 0x1, luminance 0x20000), bit count, masks.
        let bgra = [0x41, 0, 32, 0xff_0000, 0xff00, 0xff, 0xff00_0000];
        let bgrx = [0x40, 0, 32, 0xff_0000, 0xff00, 0xff, 0];
        let l8 = [0x2_0000, 0, 8, 0xff, 0, 0, 0];
        let a8l8 = [0x2_0001, 0, 16, 0xff, 0, 0, 0xff00];
        // BC1: colour 0 is pure red in RGB565. BC4 and BC5: every pixel takes endpoint 0 of an 8-byte channel block.
        let bc1 = [0x00, 0xF8, 0x1F, 0x00, 0, 0, 0, 0];
        let bc5 = [204, 0, 0, 0, 0, 0, 0, 0, 153, 0, 0, 0, 0, 0, 0, 0];
        // BC6H mode 11 (one region, 10-bit endpoints), every pixel at endpoint 0: red 528 is about 2.0, green 0, blue
        // 1023 the largest half float. BC7 mode 6, every pixel at endpoint 0: 7-bit RGBA 100, 50, 25, 127 and a 1 bit.
        let bc6h = block(&[(3, 5), (528, 10), (0, 10), (1023, 10), (528, 10), (0, 10), (1023, 10)]);
        let mut bc7 = vec![(1 << 6, 7)];
        bc7.extend([100, 100, 50, 50, 25, 25, 127, 127].map(|c| (c, 7)));
        let bc7 = block(&[bc7, vec![(1, 1), (1, 1)]].concat());
        let cases: [(&str, Vec<u8>, [u8; 4]); 13] = [
            ("bc1", dds(4, 4, fourcc(b"DXT1"), None, &bc1), [255, 0, 0, 255]),
            (
                "bc4",
                dds(4, 4, dx10, Some(80), &[200, 100, 0, 0, 0, 0, 0, 0]),
                [200, 200, 200, 255],
            ),
            // Blue rebuilt for a normal map: x = 0.6, y = 0.2, so z = √0.6, out of 255 like x and y.
            ("bc5", dds(4, 4, fourcc(b"ATI2"), None, &bc5), [204, 153, 226, 255]),
            ("bc5-dx10", dds(4, 4, dx10, Some(83), &bc5), [204, 153, 226, 255]),
            // Tone mapped like EXR: (2 / 3)^(1 / 2.2) is 212 out of 255, and the brightest blue stays below clipping.
            ("bc6h", dds(4, 4, dx10, Some(95), &bc6h), [212, 0, 255, 255]),
            ("bc7", dds(4, 4, dx10, Some(98), &bc7), [201, 101, 51, 255]),
            ("rgba8", dds(1, 1, dx10, Some(28), &[10, 20, 30, 40]), [10, 20, 30, 40]),
            ("bgra8", dds(1, 1, bgra, None, &[30, 20, 10, 40]), [10, 20, 30, 40]),
            // The fourth byte of BGRX is unused, so the pixel is opaque.
            ("bgrx8", dds(1, 1, bgrx, None, &[30, 20, 10, 0]), [10, 20, 30, 255]),
            ("r8", dds(1, 1, dx10, Some(61), &[77]), [77, 77, 77, 255]),
            ("r8-legacy", dds(1, 1, l8, None, &[77]), [77, 77, 77, 255]),
            ("rg8", dds(1, 1, dx10, Some(49), &[10, 20]), [10, 20, 0, 255]),
            ("rg8-legacy", dds(1, 1, a8l8, None, &[10, 20]), [10, 20, 0, 255]),
        ];
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes, want) in cases {
            let src = dir.path().join(format!("{name}.dds"));
            std::fs::write(&src, &bytes).unwrap();
            let img = decode(&src, "dds").unwrap_or_else(|e| panic!("{name}: {e}"));
            let side = if name.starts_with("bc") { 4 } else { 1 };
            assert_eq!((img.width(), img.height()), (side, side), "{name}");
            assert_eq!(img.to_rgba8().get_pixel(side - 1, side - 1).0, want, "{name}");
            assert!(
                thumbnail(&src, "dds", &dir.path().join(format!("{name}.png"))).is_ok(),
                "{name}"
            );
        }

        // A format nothing here decodes (10-bit RGB, DXGI 24), and a header far too big: plain errors, so the card
        // keeps its icon.
        for (name, bytes) in [
            ("rgb10", dds(1, 1, dx10, Some(24), &[0; 4])),
            ("huge", dds(0xFFFF_FFFC, 0xFFFF_FFFC, fourcc(b"DXT1"), None, &bc1)),
        ] {
            let src = dir.path().join(format!("{name}.dds"));
            std::fs::write(&src, bytes).unwrap();
            assert_eq!(decode(&src, "dds").unwrap_err(), UNREADABLE, "{name}");
            assert!(thumbnail(&src, "dds", &dir.path().join(format!("{name}.png"))).is_err());
        }
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

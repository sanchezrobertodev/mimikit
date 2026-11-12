//! The preview picture Blender saves in each .blend file (its `TEST` block), for the thumbnail and the side panel.
//! Only the start of the file is read: the preview comes right after the header and the `REND` block.

use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use image::RgbaImage;

/// Largest preview read; Blender saves 128×128.
const MAX_SIDE: u32 = 1024;
const NO_PREVIEW: &str = "This .blend file has no saved preview.";

pub fn preview(path: &Path) -> Result<RgbaImage, String> {
    let mut f = BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    let head = f.fill_buf().map_err(|e| e.to_string())?;
    let src: Box<dyn Read> = if head.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) {
        // Blender 3.0+ compresses with zstd, in frames of about 1 MiB: the preview is in the first.
        // shortcut: reads the first frame only; read on through the next ones if a file's preview ever spans two.
        Box::new(ruzstd::decoding::StreamingDecoder::new(f).map_err(|e| e.to_string())?)
    } else if head.starts_with(&[0x1F, 0x8B]) {
        Box::new(flate2::bufread::GzDecoder::new(f)) // Blender 2.x compressed with gzip
    } else {
        Box::new(f)
    };
    read_preview(src).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::UnexpectedEof => NO_PREVIEW.into(),
        _ => e.to_string(),
    })
}

fn bad(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}

fn read_preview(mut r: impl Read) -> io::Result<RgbaImage> {
    let mut h = [0u8; 12];
    r.read_exact(&mut h)?;
    if &h[..7] != b"BLENDER" {
        return Err(bad("Not a .blend file"));
    }
    // Blender 5.0+ writes "BLENDER17-01v0500": the header's length, then 32-byte block headers with 64-bit lengths.
    // Before, "BLENDER-v402": 8-byte ('-') or 4-byte ('_') pointers, so 24- or 20-byte block headers.
    let (little, bhead) = if h[7].is_ascii_digit() && h[8].is_ascii_digit() {
        let len = usize::from(h[7] - b'0') * 10 + usize::from(h[8] - b'0');
        let mut rest = vec![
            0;
            len.checked_sub(12)
                .filter(|n| *n > 0)
                .ok_or_else(|| bad("Bad .blend header"))?
        ];
        r.read_exact(&mut rest)?;
        (rest[0] == b'v', 32)
    } else {
        (h[8] == b'v', if h[7] == b'-' { 24 } else { 20 })
    };
    let int = |b: &[u8]| {
        let b = b.try_into().unwrap();
        if little {
            i32::from_le_bytes(b)
        } else {
            i32::from_be_bytes(b)
        }
    };
    let mut head = vec![0u8; bhead];
    loop {
        r.read_exact(&mut head)?;
        let len = if bhead == 32 {
            let b = head[16..24].try_into().unwrap();
            if little {
                i64::from_le_bytes(b)
            } else {
                i64::from_be_bytes(b)
            }
        } else {
            i64::from(int(&head[4..8]))
        };
        let len = u64::try_from(len).map_err(|_| bad("Bad .blend block"))?;
        match &head[..4] {
            b"REND" => {
                if io::copy(&mut (&mut r).take(len), &mut io::sink())? != len {
                    return Err(io::ErrorKind::UnexpectedEof.into());
                }
            }
            b"TEST" => {
                let mut size = [0u8; 8];
                r.read_exact(&mut size)?;
                let (w, h) = (int(&size[..4]), int(&size[4..]));
                let (w, h) = (w.try_into().unwrap_or(0u32), h.try_into().unwrap_or(0u32));
                if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || len != 8 + u64::from(w * h * 4) {
                    return Err(bad("Bad .blend preview"));
                }
                let mut px = vec![0; (w * h * 4) as usize];
                r.read_exact(&mut px)?;
                let mut img = RgbaImage::from_raw(w, h, px).unwrap();
                image::imageops::flip_vertical_in_place(&mut img); // stored bottom row first
                return Ok(img);
            }
            // The preview would have come by now.
            _ => return Err(io::ErrorKind::NotFound.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A block: a 24-byte (Blender 2.5–4.x, 64-bit) or 32-byte (5.0+) header, then `data`.
    fn block(large: bool, code: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut b = code.to_vec();
        if large {
            b.extend_from_slice(&0u32.to_le_bytes()); // SDNA index
            b.extend_from_slice(&0u64.to_le_bytes()); // old pointer
            b.extend_from_slice(&(data.len() as u64).to_le_bytes());
            b.extend_from_slice(&1u64.to_le_bytes());
        } else {
            b.extend_from_slice(&(data.len() as u32).to_le_bytes());
            b.extend_from_slice(&0u64.to_le_bytes());
            b.extend_from_slice(&[0; 8]); // SDNA index, count
        }
        b.extend_from_slice(data);
        b
    }

    /// A .blend with a 2×2 preview whose bottom row (stored first) is red and top row blue, unless `preview` is false.
    fn blend(large: bool, preview: bool) -> Vec<u8> {
        let mut f = if large {
            b"BLENDER17-01v0502".to_vec()
        } else {
            b"BLENDER-v402".to_vec()
        };
        f.extend(block(large, b"REND", &[7; 72]));
        if preview {
            let mut t = [2u32.to_le_bytes(), 2u32.to_le_bytes()].concat();
            t.extend([255, 0, 0, 255].repeat(2));
            t.extend([0, 0, 255, 255].repeat(2));
            f.extend(block(large, b"TEST", &t));
        }
        f.extend(block(large, b"GLOB", &[0; 16]));
        f.extend(block(large, b"ENDB", &[]));
        f
    }

    fn check(path: &Path) {
        let img = preview(path).unwrap();
        assert_eq!(img.dimensions(), (2, 2));
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 255, 255], "top row first");
        assert_eq!(img.get_pixel(1, 1).0, [255, 0, 0, 255]);
    }

    #[test]
    fn reads_previews_of_each_header_and_compression() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.blend");
        for large in [false, true] {
            std::fs::write(&p, blend(large, true)).unwrap();
            check(&p);
            // Blender 2.x: gzip.
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(&blend(large, true)).unwrap();
            std::fs::write(&p, gz.finish().unwrap()).unwrap();
            check(&p);
        }
        // Blender 3.0+: zstd. A stored (uncompressed) zstd frame, written by hand: magic, a frame header of one segment
        // with a 4-byte content size, then one raw last block.
        let raw = blend(true, true);
        let mut z = vec![0x28, 0xB5, 0x2F, 0xFD, 0b1010_0000];
        z.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        z.extend_from_slice(&((raw.len() as u32) << 3 | 1).to_le_bytes()[..3]);
        z.extend_from_slice(&raw);
        std::fs::write(&p, z).unwrap();
        check(&p);
    }

    #[test]
    fn files_without_a_preview_have_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.blend");
        std::fs::write(&p, blend(true, false)).unwrap();
        assert_eq!(preview(&p).unwrap_err(), NO_PREVIEW);
        let mut cut = blend(false, true);
        cut.truncate(100);
        std::fs::write(&p, cut).unwrap();
        assert_eq!(preview(&p).unwrap_err(), NO_PREVIEW);
        std::fs::write(&p, b"not a blend file").unwrap();
        assert!(preview(&p).is_err());
    }
}

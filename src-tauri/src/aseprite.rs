//! The first frame of an Aseprite file (.ase, .aseprite) with its visible layers flattened, for thumbnails and
//! previews. Format: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
//!
//! shortcut: every layer is drawn in Normal mode, tilemap layers are skipped and only the new palette chunk (Aseprite
//! 1.2+) is read, so other blend modes, tilemaps and indexed files from older versions look wrong; upgrade if users
//! report it.

use std::io::Read;

use image::RgbaImage;

/// Largest canvas or cel decoded, in pixels (8192×8192).
const MAX_PIXELS: usize = 1 << 26;
const NOT_ASE: &str = "Not an Aseprite file";

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// Width and height from the start of the file's 128-byte header.
pub fn size(header: &[u8]) -> Option<(u32, u32)> {
    (u16_at(header, 4)? == 0xA5E0).then_some((u16_at(header, 8)?.into(), u16_at(header, 10)?.into()))
}

struct Layer {
    /// Opacity with its groups' applied; None when it or a group it's in is hidden.
    opacity: Option<u32>,
    background: bool,
}

struct Cel {
    layer: usize,
    x: i32,
    y: i32,
    opacity: u32,
    z: i32,
    w: usize,
    h: usize,
    pixels: Vec<u8>,
}

pub fn first_frame(b: &[u8]) -> Result<RgbaImage, String> {
    parse(b).unwrap_or_else(|| Err(NOT_ASE.into()))
}

/// None for a file that isn't Aseprite or is cut short; an error for one this can't draw.
fn parse(b: &[u8]) -> Option<Result<RgbaImage, String>> {
    let (w, h) = size(b)?;
    let bpp = match u16_at(b, 12)? {
        32 => 4,
        16 => 2,
        8 => 1,
        d => return Some(Err(format!("Unknown Aseprite colour depth {d}"))),
    };
    if w == 0 || h == 0 || w as usize * h as usize > MAX_PIXELS {
        return Some(Err(format!("A {w}×{h} Aseprite canvas is too large to draw")));
    }
    let flags = u32_at(b, 14)?;
    let transparent = *b.get(28)?;
    let frame = b.get(128..)?;
    if u16_at(frame, 4)? != 0xF1FA {
        return None;
    }
    let frame = frame.get(..(u32_at(frame, 0)? as usize).min(frame.len()))?;
    let chunks = match u32_at(frame, 12)? {
        0 => u32::from(u16_at(frame, 6)?),
        n => n,
    };

    let mut layers: Vec<Layer> = Vec::new();
    // The opacity each open group passes to its children, by child level.
    let mut groups: Vec<Option<u32>> = Vec::new();
    let mut palette = [[0u8; 4]; 256];
    let mut cels = Vec::new();
    let mut at = 16;
    for _ in 0..chunks {
        let len = u32_at(frame, at)? as usize;
        let kind = u16_at(frame, at + 4)?;
        let d = frame.get(at + 6..at + len.max(6))?;
        at += len.max(6);
        match kind {
            0x2004 => {
                let lflags = u16_at(d, 0)?;
                let level = usize::from(u16_at(d, 4)?);
                // Layer opacity is only valid when the header says so; group opacity only with its own flag.
                let own = if flags & 1 != 0 { u32::from(*d.get(12)?) } else { 255 };
                // Visible, and not a reference layer (those are never exported).
                let shown = lflags & 1 != 0 && lflags & 64 == 0;
                groups.truncate(level);
                let parent = groups.last().copied().unwrap_or(Some(255));
                let opacity = parent.filter(|_| shown).map(|p| p * own / 255);
                let is_group = u16_at(d, 2)? == 1;
                groups.push(if is_group && flags & 2 == 0 {
                    parent.filter(|_| shown)
                } else {
                    opacity
                });
                layers.push(Layer {
                    opacity,
                    background: lflags & 8 != 0,
                });
            }
            0x2005 => {
                let (cw, ch) = (usize::from(u16_at(d, 16)?), usize::from(u16_at(d, 18)?));
                if cw * ch > MAX_PIXELS {
                    return Some(Err("An Aseprite cel is too large to draw".into()));
                }
                let want = cw * ch * bpp;
                let pixels = match u16_at(d, 7)? {
                    0 => d.get(20..20 + want)?.to_vec(),
                    2 => {
                        let mut out = Vec::with_capacity(want);
                        flate2::read::ZlibDecoder::new(d.get(20..)?)
                            .take(want as u64)
                            .read_to_end(&mut out)
                            .ok()?;
                        out
                    }
                    // Linked cels point at earlier frames, and there are none; tilemaps aren't drawn.
                    _ => continue,
                };
                if pixels.len() != want {
                    return None;
                }
                cels.push(Cel {
                    layer: usize::from(u16_at(d, 0)?),
                    x: i32::from(u16_at(d, 2)? as i16),
                    y: i32::from(u16_at(d, 4)? as i16),
                    opacity: u32::from(*d.get(6)?),
                    z: i32::from(u16_at(d, 9)? as i16),
                    w: cw,
                    h: ch,
                    pixels,
                });
            }
            0x2019 => {
                let (first, last) = (u32_at(d, 4)? as usize, u32_at(d, 8)? as usize);
                let mut p = 20;
                for slot in palette.iter_mut().take(last.saturating_add(1)).skip(first) {
                    let e = d.get(p..p + 6)?;
                    *slot = [e[2], e[3], e[4], e[5]];
                    p += 6;
                    if u16_at(e, 0)? & 1 != 0 {
                        p += 2 + usize::from(u16_at(d, p)?); // the entry's name
                    }
                }
            }
            _ => {}
        }
    }

    // Cels draw in layer order, moved by their z-index; on a tie the lower z-index goes first.
    cels.sort_by_key(|c| (c.layer as i32 + c.z, c.z));
    let mut canvas = RgbaImage::new(w, h);
    for c in &cels {
        let Some(layer) = layers.get(c.layer) else { continue };
        let Some(opacity) = layer.opacity else { continue };
        let opacity = opacity * c.opacity / 255;
        for row in 0..c.h {
            let y = c.y + row as i32;
            if y < 0 || y >= h as i32 {
                continue;
            }
            for col in 0..c.w {
                let x = c.x + col as i32;
                if x < 0 || x >= w as i32 {
                    continue;
                }
                let i = (row * c.w + col) * bpp;
                let px = match bpp {
                    4 => [c.pixels[i], c.pixels[i + 1], c.pixels[i + 2], c.pixels[i + 3]],
                    2 => [c.pixels[i], c.pixels[i], c.pixels[i], c.pixels[i + 1]],
                    // The transparent index is see-through everywhere but on the background layer.
                    _ if c.pixels[i] == transparent && !layer.background => continue,
                    _ => palette[usize::from(c.pixels[i])],
                };
                over(
                    &mut canvas.get_pixel_mut(x as u32, y as u32).0,
                    px,
                    u32::from(px[3]) * opacity / 255,
                );
            }
        }
    }
    Some(Ok(canvas))
}

/// Draws `s` with alpha `a` over `d` (straight, not premultiplied, alpha).
fn over(d: &mut [u8; 4], s: [u8; 4], a: u32) {
    let da = u32::from(d[3]) * (255 - a) / 255;
    let out = a + da;
    if out == 0 {
        return;
    }
    for i in 0..3 {
        d[i] = ((u32::from(s[i]) * a + u32::from(d[i]) * da) / out) as u8;
    }
    d[3] = out as u8;
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    fn chunk(kind: u16, data: &[u8]) -> Vec<u8> {
        let mut c = ((data.len() + 6) as u32).to_le_bytes().to_vec();
        c.extend_from_slice(&kind.to_le_bytes());
        c.extend_from_slice(data);
        c
    }

    /// A layer chunk: flags (1 visible, 8 background, 64 reference), type (1 group), child level, opacity.
    pub fn layer(flags: u16, kind: u16, level: u16, opacity: u8) -> Vec<u8> {
        let mut d = Vec::new();
        for v in [flags, kind, level, 0, 0, 0] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&[opacity, 0, 0, 0]);
        d.extend_from_slice(&1u16.to_le_bytes());
        d.push(b'L');
        chunk(0x2004, &d)
    }

    /// An opaque cel chunk with `pixels` (w×h, in the file's colour depth), zlib-compressed when `zip`.
    pub fn cel(layer: u16, x: i16, y: i16, w: u16, h: u16, pixels: &[u8], zip: bool) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&layer.to_le_bytes());
        d.extend_from_slice(&x.to_le_bytes());
        d.extend_from_slice(&y.to_le_bytes());
        d.push(255);
        d.extend_from_slice(&(if zip { 2u16 } else { 0 }).to_le_bytes());
        d.extend_from_slice(&[0; 7]); // z-index and reserved
        d.extend_from_slice(&w.to_le_bytes());
        d.extend_from_slice(&h.to_le_bytes());
        if zip {
            let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            z.write_all(pixels).unwrap();
            d.extend_from_slice(&z.finish().unwrap());
        } else {
            d.extend_from_slice(pixels);
        }
        chunk(0x2005, &d)
    }

    /// A new-style palette chunk; the second colour has a name.
    pub fn palette(colors: &[[u8; 4]]) -> Vec<u8> {
        let mut d = (colors.len() as u32).to_le_bytes().to_vec();
        d.extend_from_slice(&0u32.to_le_bytes());
        d.extend_from_slice(&(colors.len() as u32 - 1).to_le_bytes());
        d.extend_from_slice(&[0; 8]);
        for (i, c) in colors.iter().enumerate() {
            d.extend_from_slice(&(u16::from(i == 1)).to_le_bytes());
            d.extend_from_slice(c);
            if i == 1 {
                d.extend_from_slice(&3u16.to_le_bytes());
                d.extend_from_slice(b"red");
            }
        }
        chunk(0x2019, &d)
    }

    /// A whole file: header, then one frame of `chunks` and a second, empty frame.
    pub fn file(w: u16, h: u16, depth: u16, transparent: u8, chunks: &[Vec<u8>]) -> Vec<u8> {
        let body: Vec<u8> = chunks.concat();
        let mut f = vec![0u8; 128];
        f[4..6].copy_from_slice(&0xA5E0u16.to_le_bytes());
        f[6..8].copy_from_slice(&2u16.to_le_bytes());
        f[8..10].copy_from_slice(&w.to_le_bytes());
        f[10..12].copy_from_slice(&h.to_le_bytes());
        f[12..14].copy_from_slice(&depth.to_le_bytes());
        f[14..18].copy_from_slice(&1u32.to_le_bytes()); // layer opacity is valid
        f[28] = transparent;
        for (n, body) in [(chunks.len(), &body[..]), (0, &[][..])] {
            f.extend_from_slice(&((16 + body.len()) as u32).to_le_bytes());
            f.extend_from_slice(&0xF1FAu16.to_le_bytes());
            f.extend_from_slice(&(n as u16).to_le_bytes());
            f.extend_from_slice(&100u16.to_le_bytes());
            f.extend_from_slice(&[0, 0]);
            f.extend_from_slice(&(n as u32).to_le_bytes());
            f.extend_from_slice(body);
        }
        let len = f.len() as u32;
        f[..4].copy_from_slice(&len.to_le_bytes());
        f
    }

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    #[test]
    fn flattens_visible_rgba_layers() {
        let px = |c: [u8; 4], n: usize| c.repeat(n);
        let f = file(
            4,
            2,
            32,
            0,
            &[
                layer(1, 0, 0, 255),
                layer(1, 0, 0, 128),      // half opacity
                layer(0, 0, 0, 255),      // hidden
                layer(1 | 64, 0, 0, 255), // reference layer
                cel(0, 0, 0, 4, 2, &px(RED, 8), true),
                cel(1, 2, 0, 4, 2, &px(BLUE, 8), false), // half off the canvas
                cel(2, 0, 0, 1, 1, &BLUE, false),
                cel(3, 0, 1, 1, 1, &BLUE, false),
            ],
        );
        assert_eq!(size(&f), Some((4, 2)));
        let img = first_frame(&f).unwrap();
        assert_eq!(img.dimensions(), (4, 2));
        assert_eq!(img.get_pixel(0, 0).0, RED);
        assert_eq!(img.get_pixel(0, 1).0, RED);
        let mixed = img.get_pixel(3, 1).0;
        assert!(
            mixed[0].abs_diff(127) <= 1 && mixed[2].abs_diff(128) <= 1 && mixed[3] == 255,
            "{mixed:?}"
        );
    }

    #[test]
    fn hides_children_of_hidden_groups() {
        let f = file(
            1,
            1,
            32,
            0,
            &[
                layer(0, 1, 0, 255), // hidden group
                layer(1, 0, 1, 255), // its visible child
                cel(1, 0, 0, 1, 1, &RED, false),
            ],
        );
        assert_eq!(first_frame(&f).unwrap().get_pixel(0, 0).0, [0, 0, 0, 0]);
    }

    #[test]
    fn reads_indexed_and_grayscale() {
        let indexed = file(
            3,
            1,
            8,
            0,
            &[
                palette(&[[0, 0, 0, 255], RED, BLUE]),
                layer(1, 0, 0, 255),
                cel(0, 0, 0, 3, 1, &[0, 1, 2], true),
            ],
        );
        let img = first_frame(&indexed).unwrap();
        assert_eq!(
            img.get_pixel(0, 0).0,
            [0, 0, 0, 0],
            "index 0 is transparent off the background layer"
        );
        assert_eq!((img.get_pixel(1, 0).0, img.get_pixel(2, 0).0), (RED, BLUE));

        let gray = file(
            1,
            1,
            16,
            0,
            &[layer(1, 0, 0, 255), cel(0, 0, 0, 1, 1, &[200, 255], false)],
        );
        assert_eq!(first_frame(&gray).unwrap().get_pixel(0, 0).0, [200, 200, 200, 255]);
    }

    #[test]
    fn rejects_other_and_broken_files() {
        assert!(first_frame(b"\x89PNG\r\n\x1a\n").is_err());
        assert_eq!(size(b"short"), None);
        let mut f = file(
            2,
            2,
            32,
            0,
            &[layer(1, 0, 0, 255), cel(0, 0, 0, 2, 2, &RED.repeat(4), true)],
        );
        assert!(first_frame(&f).is_ok());
        f.truncate(f.len() - 30); // inside the compressed cel
        assert!(first_frame(&f).is_err());
        let mut deep = file(2, 2, 32, 0, &[]);
        deep[12] = 24;
        assert!(first_frame(&deep).is_err());
    }
}

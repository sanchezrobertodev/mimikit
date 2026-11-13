//! Aseprite files (.ase, .aseprite) with their visible layers flattened: the first frame for thumbnails and previews,
//! every frame side by side for Animate. Format: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
//!
//! shortcut: every layer is drawn in Normal mode, tilemap layers are skipped and 6-bit palettes (chunk 0x0011, from
//! very old files) aren't read, so other blend modes and tilemaps look wrong; upgrade if users report it.

use std::io::Read;

use image::RgbaImage;

/// Largest canvas or cel decoded, in pixels (8192×8192); also caps the canvases groups are composited on and the strip
/// of frames Animate plays.
const MAX_PIXELS: usize = 1 << 26;
/// Deepest group nesting drawn, so drawing can't run out of stack.
const MAX_DEPTH: usize = 64;
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

/// Each frame's bytes and duration in ms, in order; stops at the first frame that is cut short.
fn frames_of(b: &[u8]) -> impl Iterator<Item = (&[u8], u16)> {
    let mut at = 128;
    (0..u16_at(b, 6).unwrap_or(0)).map_while(move |_| {
        let len = u32_at(b, at)? as usize;
        let f = b.get(at..at.checked_add(len)?).filter(|f| f.len() >= 16)?;
        at += len;
        (u16_at(f, 4)? == 0xF1FA).then_some((f, u16_at(f, 8)?))
    })
}

/// How long each frame shows, in ms. Empty for a file that isn't Aseprite.
pub fn durations(b: &[u8]) -> Vec<u16> {
    if size(b).is_none() {
        return Vec::new();
    }
    frames_of(b).map(|(_, d)| d).collect()
}

struct Layer {
    /// Visible and not a reference layer (those are never exported).
    shown: bool,
    group: bool,
    /// The group it's in.
    parent: Option<usize>,
    opacity: u32,
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

/// Where a cel's pixels are in the file. Linked cels decode them again from here, so earlier frames' pixels aren't
/// kept in memory.
#[derive(Clone, Copy)]
struct Source<'a> {
    layer: usize,
    w: usize,
    h: usize,
    zlib: bool,
    data: &'a [u8],
}

impl Source<'_> {
    /// None when the data is cut short.
    fn decode(&self, bpp: usize) -> Option<Vec<u8>> {
        let want = self.w * self.h * bpp;
        let pixels = if self.zlib {
            let mut out = Vec::with_capacity(want);
            flate2::read::ZlibDecoder::new(self.data)
                .take(want as u64)
                .read_to_end(&mut out)
                .ok()?;
            out
        } else {
            self.data.get(..want)?.to_vec()
        };
        (pixels.len() == want).then_some(pixels)
    }
}

/// The layers, the cels of the frame being drawn, and what drawing them needs.
struct Sprite {
    layers: Vec<Layer>,
    cels: Vec<Cel>,
    bpp: usize,
    palette: [[u8; 4]; 256],
    transparent: u8,
}

pub fn first_frame(b: &[u8]) -> Result<RgbaImage, String> {
    let mut first = None;
    parse(b, 1, |img| first = Some(img)).unwrap_or_else(|| Err(NOT_ASE.into()))?;
    first.ok_or_else(|| NOT_ASE.into())
}

/// The size each of `n` frames is drawn at in a strip: the canvas's own, scaled down when the strip would be over
/// MAX_PIXELS. None when even 1-pixel-high frames wouldn't fit.
fn strip_frame(w: u32, h: u32, n: u32) -> Option<(u32, u32)> {
    let fit = (MAX_PIXELS as f64 / (f64::from(w) * f64::from(h) * f64::from(n)))
        .sqrt()
        .min(1.0);
    let (fw, fh) = (
        ((f64::from(w) * fit) as u32).max(1),
        ((f64::from(h) * fit) as u32).max(1),
    );
    (fw as usize * fh as usize * n as usize <= MAX_PIXELS).then_some((fw, fh))
}

/// Every frame side by side, left to right, at the size `strip_frame` gives.
pub fn strip(b: &[u8]) -> Result<RgbaImage, String> {
    let (w, h) = size(b).ok_or(NOT_ASE)?;
    let n = durations(b).len().max(1) as u32;
    let (fw, fh) = strip_frame(w, h, n).ok_or_else(|| format!("{n} frames of {w}×{h} are too many to animate"))?;
    let mut out = RgbaImage::new(fw * n, fh);
    let mut x = 0;
    parse(b, n as usize, |img| {
        let img = if fw < w {
            image::imageops::thumbnail(&img, fw, fh)
        } else {
            img
        };
        image::imageops::replace(&mut out, &img, x, 0);
        x += i64::from(fw);
    })
    .unwrap_or_else(|| Err(NOT_ASE.into()))?;
    Ok(out)
}

/// Flattens each of the first `limit` frames, in order, and hands it to `each`. None for a file that isn't Aseprite or
/// is cut short; an error for one this can't draw.
fn parse(b: &[u8], limit: usize, mut each: impl FnMut(RgbaImage)) -> Option<Result<(), String>> {
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
    let mut s = Sprite {
        layers: Vec::new(),
        cels: Vec::new(),
        bpp,
        palette: [[0; 4]; 256],
        transparent: *b.get(28)?,
    };
    // The open groups, by child level.
    let mut open: Vec<usize> = Vec::new();
    let mut new_palette = false;
    // Where every earlier frame's cels are, for linked cels to point back at.
    let mut frames: Vec<Vec<Source>> = Vec::new();
    for (frame, _) in frames_of(b).take(limit) {
        let mut sources = Vec::new();
        let chunks = match u32_at(frame, 12)? {
            0 => u32::from(u16_at(frame, 6)?),
            n => n,
        };
        let mut at = 16;
        for _ in 0..chunks {
            let len = u32_at(frame, at)? as usize;
            let kind = u16_at(frame, at + 4)?;
            let d = frame.get(at + 6..at + len.max(6))?;
            at += len.max(6);
            match kind {
                0x2004 => {
                    let lflags = u16_at(d, 0)?;
                    let group = u16_at(d, 2)? == 1;
                    // Layer opacity is only valid when the header says so; group opacity only with its own flag too.
                    let valid = if group { 3 } else { 1 };
                    let opacity = if flags & valid == valid {
                        u32::from(*d.get(12)?)
                    } else {
                        255
                    };
                    open.truncate(usize::from(u16_at(d, 4)?));
                    s.layers.push(Layer {
                        shown: lflags & 1 != 0 && lflags & 64 == 0,
                        group,
                        parent: open.last().copied(),
                        opacity,
                        background: lflags & 8 != 0,
                    });
                    if group {
                        if open.len() == MAX_DEPTH {
                            return Some(Err("Aseprite groups are nested too deeply to draw".into()));
                        }
                        open.push(s.layers.len() - 1);
                    }
                }
                0x2005 => {
                    let layer = usize::from(u16_at(d, 0)?);
                    let src = match u16_at(d, 7)? {
                        kind @ (0 | 2) => {
                            let (cw, ch) = (usize::from(u16_at(d, 16)?), usize::from(u16_at(d, 18)?));
                            if cw * ch > MAX_PIXELS {
                                return Some(Err("An Aseprite cel is too large to draw".into()));
                            }
                            Source {
                                layer,
                                w: cw,
                                h: ch,
                                zlib: kind == 2,
                                data: d.get(20..)?,
                            }
                        }
                        // A linked cel shows the same layer's cel from an earlier frame, at its own place and opacity.
                        1 => {
                            let linked = frames
                                .get(usize::from(u16_at(d, 16)?))
                                .and_then(|f| f.iter().find(|c| c.layer == layer));
                            let Some(&c) = linked else { continue };
                            c
                        }
                        // Tilemaps aren't drawn.
                        _ => continue,
                    };
                    let pixels = src.decode(bpp)?;
                    sources.push(src);
                    s.cels.push(Cel {
                        layer,
                        x: i32::from(u16_at(d, 2)? as i16),
                        y: i32::from(u16_at(d, 4)? as i16),
                        opacity: u32::from(*d.get(6)?),
                        z: i32::from(u16_at(d, 9)? as i16),
                        w: src.w,
                        h: src.h,
                        pixels,
                    });
                }
                0x2019 => {
                    new_palette = true;
                    let (first, last) = (u32_at(d, 4)? as usize, u32_at(d, 8)? as usize);
                    let mut p = 20;
                    for slot in s.palette.iter_mut().take(last.saturating_add(1)).skip(first) {
                        let e = d.get(p..p + 6)?;
                        *slot = [e[2], e[3], e[4], e[5]];
                        p += 6;
                        if u16_at(e, 0)? & 1 != 0 {
                            p += 2 + usize::from(u16_at(d, p)?); // the entry's name
                        }
                    }
                }
                // The old palette chunk: Aseprite 1.3.5+ writes only this one for opaque palettes of up to 256 colours.
                0x0004 if !new_palette => {
                    let (mut p, mut slot) = (2, 0);
                    for _ in 0..u16_at(d, 0)? {
                        slot += usize::from(*d.get(p)?); // entries skipped since the last packet
                        let n = match *d.get(p + 1)? {
                            0 => 256,
                            n => usize::from(n),
                        };
                        p += 2;
                        for _ in 0..n {
                            let e = d.get(p..p + 3)?;
                            if let Some(c) = s.palette.get_mut(slot) {
                                *c = [e[0], e[1], e[2], 255];
                            }
                            (p, slot) = (p + 3, slot + 1);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut canvas = RgbaImage::new(w, h);
        s.draw(&mut canvas, None, 255, 1);
        each(canvas);
        s.cels.clear();
        frames.push(sources);
    }
    (!frames.is_empty()).then_some(Ok(()))
}

impl Sprite {
    /// Draws the shown layers in `group` (None for the top level) onto `canvas` at `opacity`, in layer order with
    /// cels moved by their z-index. A group that isn't opaque is composited on its own canvas first, as the format
    /// asks, while the `canvases` in use fit in MAX_PIXELS; past that its opacity goes to each child instead.
    fn draw(&self, canvas: &mut RgbaImage, group: Option<usize>, opacity: u32, canvases: usize) {
        let inside = |l: &Layer| l.shown && l.parent == group;
        let cels = self
            .cels
            .iter()
            .filter(|c| self.layers.get(c.layer).is_some_and(|l| inside(l) && !l.group));
        let groups = self.layers.iter().enumerate().filter(|(_, l)| inside(l) && l.group);
        let mut items: Vec<(i32, i32, usize, Option<&Cel>)> = cels
            .map(|c| (c.layer as i32 + c.z, c.z, c.layer, Some(c)))
            .chain(groups.map(|(i, _)| (i as i32, 0, i, None)))
            .collect();
        // On a tie the lower z-index goes first.
        items.sort_by_key(|&(order, z, ..)| (order, z));
        let pixels = canvas.width() as usize * canvas.height() as usize;
        for (_, _, i, cel) in items {
            let layer = &self.layers[i];
            let opacity = opacity * layer.opacity / 255;
            match cel {
                Some(c) => self.draw_cel(canvas, c, layer.background, opacity * c.opacity / 255),
                None if layer.opacity == 255 || (canvases + 1) * pixels > MAX_PIXELS => {
                    self.draw(canvas, Some(i), opacity, canvases)
                }
                None => {
                    let mut own = RgbaImage::new(canvas.width(), canvas.height());
                    self.draw(&mut own, Some(i), 255, canvases + 1);
                    for (d, s) in canvas.pixels_mut().zip(own.pixels()) {
                        over(&mut d.0, s.0, u32::from(s[3]) * opacity / 255);
                    }
                }
            }
        }
    }

    fn draw_cel(&self, canvas: &mut RgbaImage, c: &Cel, background: bool, opacity: u32) {
        let (w, h) = (canvas.width() as i32, canvas.height() as i32);
        for row in 0..c.h {
            let y = c.y + row as i32;
            if y < 0 || y >= h {
                continue;
            }
            for col in 0..c.w {
                let x = c.x + col as i32;
                if x < 0 || x >= w {
                    continue;
                }
                let i = (row * c.w + col) * self.bpp;
                let px = match self.bpp {
                    4 => [c.pixels[i], c.pixels[i + 1], c.pixels[i + 2], c.pixels[i + 3]],
                    2 => [c.pixels[i], c.pixels[i], c.pixels[i], c.pixels[i + 1]],
                    // The transparent index is see-through everywhere but on the background layer.
                    _ if c.pixels[i] == self.transparent && !background => continue,
                    _ => self.palette[usize::from(c.pixels[i])],
                };
                over(
                    &mut canvas.get_pixel_mut(x as u32, y as u32).0,
                    px,
                    u32::from(px[3]) * opacity / 255,
                );
            }
        }
    }
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

    /// The start of a cel chunk: layer, position, full opacity, cel type, then z-index 0 and reserved bytes.
    fn cel_head(layer: u16, x: i16, y: i16, kind: u16) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&layer.to_le_bytes());
        d.extend_from_slice(&x.to_le_bytes());
        d.extend_from_slice(&y.to_le_bytes());
        d.push(255);
        d.extend_from_slice(&kind.to_le_bytes());
        d.extend_from_slice(&[0; 7]);
        d
    }

    /// A cel chunk that shows `layer`'s cel from frame `frame` at (x, y).
    pub fn linked(layer: u16, x: i16, y: i16, frame: u16) -> Vec<u8> {
        let mut d = cel_head(layer, x, y, 1);
        d.extend_from_slice(&frame.to_le_bytes());
        chunk(0x2005, &d)
    }

    /// An opaque cel chunk with `pixels` (w×h, in the file's colour depth), zlib-compressed when `zip`.
    pub fn cel(layer: u16, x: i16, y: i16, w: u16, h: u16, pixels: &[u8], zip: bool) -> Vec<u8> {
        let mut d = cel_head(layer, x, y, if zip { 2 } else { 0 });
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

    /// A whole file: header, then each frame's chunks with its duration in ms.
    pub fn animation(w: u16, h: u16, depth: u16, transparent: u8, frames: &[(&[Vec<u8>], u16)]) -> Vec<u8> {
        let mut f = vec![0u8; 128];
        f[4..6].copy_from_slice(&0xA5E0u16.to_le_bytes());
        f[6..8].copy_from_slice(&(frames.len() as u16).to_le_bytes());
        f[8..10].copy_from_slice(&w.to_le_bytes());
        f[10..12].copy_from_slice(&h.to_le_bytes());
        f[12..14].copy_from_slice(&depth.to_le_bytes());
        f[14..18].copy_from_slice(&1u32.to_le_bytes()); // layer opacity is valid
        f[28] = transparent;
        for (chunks, duration) in frames {
            let body = chunks.concat();
            f.extend_from_slice(&((16 + body.len()) as u32).to_le_bytes());
            f.extend_from_slice(&0xF1FAu16.to_le_bytes());
            f.extend_from_slice(&(chunks.len() as u16).to_le_bytes());
            f.extend_from_slice(&duration.to_le_bytes());
            f.extend_from_slice(&[0, 0]);
            f.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
            f.extend_from_slice(&body);
        }
        let len = f.len() as u32;
        f[..4].copy_from_slice(&len.to_le_bytes());
        f
    }

    /// One frame of `chunks` and a second, empty frame.
    pub fn file(w: u16, h: u16, depth: u16, transparent: u8, chunks: &[Vec<u8>]) -> Vec<u8> {
        animation(w, h, depth, transparent, &[(chunks, 100), (&[], 100)])
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
    fn strips_every_frame_with_linked_cels() {
        let f = animation(
            2,
            1,
            32,
            0,
            &[
                (
                    &[layer(1, 0, 0, 255), layer(1, 0, 0, 255), cel(0, 0, 0, 1, 1, &RED, true)],
                    100,
                ),
                (&[linked(0, 1, 0, 0), cel(1, 0, 0, 1, 1, &BLUE, false)], 250),
                // A link to a link, and one to a frame that doesn't exist.
                (&[linked(0, 0, 0, 1), linked(1, 1, 0, 1), linked(1, 0, 0, 7)], 50),
            ],
        );
        assert_eq!(durations(&f), [100, 250, 50]);
        let s = strip(&f).unwrap();
        assert_eq!(s.dimensions(), (6, 1));
        let row: Vec<[u8; 4]> = (0..6).map(|x| s.get_pixel(x, 0).0).collect();
        let none = [0, 0, 0, 0];
        assert_eq!(row, [RED, none, BLUE, RED, RED, BLUE]);
        assert_eq!(first_frame(&f).unwrap().get_pixel(1, 0).0, none);
        assert!(durations(b"short").is_empty());
    }

    #[test]
    fn scales_frames_down_only_when_the_strip_is_too_large() {
        assert_eq!(strip_frame(64, 32, 100), Some((64, 32)));
        assert_eq!(strip_frame(4096, 4096, 16), Some((2048, 2048)));
        assert_eq!(strip_frame(65535, 1, 65535), None);
    }

    #[test]
    fn rejects_other_and_broken_files() {
        assert!(first_frame(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(strip(b"\x89PNG\r\n\x1a\n").is_err());
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
        let nested: Vec<Vec<u8>> = (0..=MAX_DEPTH as u16).map(|level| layer(1, 1, level, 255)).collect();
        assert!(first_frame(&file(1, 1, 32, 0, &nested)).is_err());
    }

    /// An old-style palette chunk of (entries skipped, colours) packets.
    fn old_palette(packets: &[(u8, &[[u8; 3]])]) -> Vec<u8> {
        let mut d = (packets.len() as u16).to_le_bytes().to_vec();
        for (skip, colors) in packets {
            d.extend_from_slice(&[*skip, colors.len() as u8]);
            d.extend(colors.concat());
        }
        chunk(0x0004, &d)
    }

    #[test]
    fn reads_the_old_palette_chunk() {
        let old = old_palette(&[(0, &[[0, 0, 0], [255, 0, 0]]), (1, &[[0, 0, 255]])]);
        let art = [layer(1, 0, 0, 255), cel(0, 0, 0, 3, 1, &[0, 1, 3], false)];
        let img = first_frame(&file(3, 1, 8, 0, &[&[old.clone()][..], &art].concat())).unwrap();
        assert_eq!((img.get_pixel(1, 0).0, img.get_pixel(2, 0).0), (RED, BLUE));

        // A new palette chunk wins, before or after it.
        let green = [0, 255, 0, 255];
        let new = palette(&[[0; 4], green, [0; 4], green]);
        for both in [[old.clone(), new.clone()], [new, old]] {
            let img = first_frame(&file(3, 1, 8, 0, &[&both[..], &art].concat())).unwrap();
            assert_eq!((img.get_pixel(1, 0).0, img.get_pixel(2, 0).0), (green, green));
        }
    }

    #[test]
    fn composites_translucent_groups_on_their_own() {
        let mut f = file(
            1,
            1,
            32,
            0,
            &[
                layer(1, 1, 0, 128), // half-opacity group of two opaque layers
                layer(1, 0, 1, 255),
                layer(1, 0, 1, 255),
                cel(1, 0, 0, 1, 1, &RED, false),
                cel(2, 0, 0, 1, 1, &BLUE, false),
            ],
        );
        f[14] = 3; // group opacity is valid
        assert_eq!(first_frame(&f).unwrap().get_pixel(0, 0).0, [0, 0, 255, 128]);
        f[14] = 1;
        assert_eq!(first_frame(&f).unwrap().get_pixel(0, 0).0, BLUE);
    }
}

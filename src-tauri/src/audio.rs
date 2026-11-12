//! Audio details (length, sample rate, channels, bit depth) read from file headers with Symphonia, and WAV copies of
//! sounds the webview can't play.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::{Connection, Result, params};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::db::abs_path;

/// What a file's header says; a field is None when the format doesn't tell (bit depth of MP3) or can't be read (Opus).
#[derive(Default, Debug, PartialEq)]
pub struct AudioInfo {
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub bits: Option<i64>,
}

/// Packets read to add up a length: about 20 minutes of MP3. Longer files keep the header's length, if any.
const MAX_PACKETS: usize = 50_000;

pub fn read_info(path: &Path, ext: &str) -> Option<AudioInfo> {
    // A demuxer panic on a malformed file mustn't take the app down: it runs on every launch (fill_audio).
    std::panic::catch_unwind(|| probe(path, ext)).ok().flatten()
}

fn probe(path: &Path, ext: &str) -> Option<AudioInfo> {
    let file = std::fs::File::open(path).ok()?;
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let mut reader = symphonia::default::get_probe()
        .probe(
            &hint,
            MediaSourceStream::new(Box::new(file), Default::default()),
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = reader.default_track(TrackType::Audio)?.clone();
    let Some(CodecParameters::Audio(p)) = &track.codec_params else {
        return None;
    };
    let mut ticks = track.duration.map(|d| d.get());
    // An MP3 without a Xing/VBRI header only gets a guess from the first frame's bitrate, wrong for VBR: count frames.
    // Demuxing reads the file but decodes nothing.
    if ticks.is_none() || ext == "mp3" {
        let mut total = 0;
        for _ in 0..MAX_PACKETS {
            match reader.next_packet() {
                Ok(Some(pkt)) if pkt.track_id == track.id => total += pkt.dur.get(),
                Ok(Some(_)) => {}
                Ok(None) => {
                    ticks = Some(total);
                    break;
                }
                Err(_) => break,
            }
        }
    }
    let duration_ms = ticks
        .zip(track.time_base)
        .map(|(t, tb)| (u128::from(t) * u128::from(tb.numer.get()) * 1000 / u128::from(tb.denom.get())) as i64);
    Some(AudioInfo {
        duration_ms: duration_ms.filter(|ms| *ms > 0),
        sample_rate: p.sample_rate.map(i64::from),
        channels: p.channels.as_ref().map(|c| c.count() as i64),
        bits: p.bits_per_sample.map(i64::from),
    })
}

/// Stores what was read from version `size`/`mtime` of the file; a row that doesn't match the asset anymore is stale.
/// Does nothing if the asset is gone or has changed since (its newer version may already be stored).
pub fn store(conn: &Connection, id: i64, size: i64, mtime: i64, i: &AudioInfo) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO audio_info (asset_id, size, mtime, duration_ms, sample_rate, channels, bits)
         SELECT id, ?2, ?3, ?4, ?5, ?6, ?7 FROM assets WHERE id = ?1 AND size = ?2 AND mtime = ?3",
        params![id, size, mtime, i.duration_ms, i.sample_rate, i.channels, i.bits],
    )
    .map(|_| ())
}

/// Longest WAV a converted sound may become, about 25 minutes of 16-bit 44.1 kHz stereo; longer sounds don't play.
const MAX_WAV: u64 = 256 << 20;
/// Bytes of converted sounds kept in their folder; the oldest go first.
const WAV_CACHE: u64 = 1 << 30;

/// The 44-byte header of a PCM WAV holding `data` bytes.
pub fn wav_header(rate: u32, channels: u16, bits: u16, data: u32) -> Vec<u8> {
    let block = channels * bits / 8;
    let mut b = Vec::with_capacity(44);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * u32::from(block)).to_le_bytes());
    b.extend_from_slice(&block.to_le_bytes());
    b.extend_from_slice(&bits.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    b
}

/// Decodes a sound the webview can't play (AIFF) to a 16-bit WAV at `out`, unless it's there already, then deletes the
/// oldest WAVs beside it past [`WAV_CACHE`]. The source is only read.
pub fn to_wav(src: &Path, ext: &str, out: &Path) -> std::result::Result<(), String> {
    if out.exists() {
        return Ok(());
    }
    // A temp name of its own: the side panel and play-on-hover can ask for the same sound at once.
    static N: AtomicU32 = AtomicU32::new(0);
    let tmp = out.with_extension(format!("{}.tmp", N.fetch_add(1, Ordering::Relaxed)));
    // Caught like in read_info: a demuxer or decoder panic fails this sound only.
    let made = std::panic::catch_unwind(|| write_wav(src, ext, &tmp))
        .unwrap_or_else(|_| Err("Mimikit couldn't read this sound.".into()))
        .and_then(|()| std::fs::rename(&tmp, out).map_err(|e| e.to_string()));
    if let Err(e) = made {
        let _ = std::fs::remove_file(&tmp);
        // Another request may have made it meanwhile (Windows won't replace a file that's playing).
        if !out.exists() {
            return Err(e);
        }
    }
    trim(out, WAV_CACHE);
    Ok(())
}

fn write_wav(src: &Path, ext: &str, out: &Path) -> std::result::Result<(), String> {
    let s = |e: symphonia::core::errors::Error| e.to_string();
    let io = |e: std::io::Error| e.to_string();
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let file = File::open(src).map_err(io)?;
    let mut reader = symphonia::default::get_probe()
        .probe(
            &hint,
            MediaSourceStream::new(Box::new(file), Default::default()),
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(s)?;
    let track = reader
        .default_track(TrackType::Audio)
        .ok_or("No sound in this file")?
        .clone();
    let Some(CodecParameters::Audio(p)) = &track.codec_params else {
        return Err("No sound in this file".into());
    };
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(p, &AudioDecoderOptions::default())
        .map_err(s)?;
    let mut w = BufWriter::new(File::create(out).map_err(io)?);
    w.write_all(&[0; 44]).map_err(io)?; // the header, once the length is known
    let (mut rate, mut channels, mut data) = (0, 0, 0u64);
    let mut samples: Vec<i16> = Vec::new();
    while let Some(packet) = reader.next_packet().map_err(s)? {
        if packet.track_id != track.id {
            continue;
        }
        let buf = decoder.decode(&packet).map_err(s)?;
        (rate, channels) = (buf.spec().rate(), buf.spec().channels().count() as u16);
        buf.copy_to_vec_interleaved(&mut samples);
        data += samples.len() as u64 * 2;
        if data > MAX_WAV {
            return Err("This sound is too long to play in Mimikit.".into());
        }
        for v in &samples {
            w.write_all(&v.to_le_bytes()).map_err(io)?;
        }
    }
    if channels == 0 {
        return Err("No sound in this file".into());
    }
    let mut f = w.into_inner().map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(0)).map_err(io)?;
    f.write_all(&wav_header(rate, channels, 16, data as u32)).map_err(io)
}

/// Deletes the oldest WAVs in `keep`'s folder, never `keep`, while they add up to more than `cap` bytes.
fn trim(keep: &Path, cap: u64) {
    let Some(Ok(dir)) = keep.parent().map(std::fs::read_dir) else {
        return;
    };
    let mut wavs: Vec<_> = dir
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "wav"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    wavs.sort();
    let mut total: u64 = wavs.iter().map(|w| w.1).sum();
    for (_, len, path) in wavs {
        if total <= cap {
            break;
        }
        if path != keep && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

const BATCH: usize = 500;

/// Reads audio details for a root's audio files that have none yet or changed since, [`BATCH`] files per transaction.
/// The to-do list is read under the lock, the files off it. Unreadable files get an empty row so they aren't retried
/// until they change; files under the scan's `unread` paths wait for the next one. With `only`, just those rows (the
/// watcher's). `report(conn, ids)` gets each batch's ids, lock held.
pub fn fill_audio(
    db: &Mutex<Connection>,
    root_id: i64,
    root: &Path,
    unread: &[String],
    only: Option<&[i64]>,
    mut report: impl FnMut(&Connection, &[i64]),
) -> Result<()> {
    let todo: Vec<(i64, String, String, i64, i64)> = {
        let conn = db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.id, a.rel_path, a.ext, a.size, a.mtime FROM assets a
             LEFT JOIN audio_info i ON i.asset_id = a.id
             WHERE a.root_id = ?1 AND a.kind = 'audio' AND (i.asset_id IS NULL OR i.size != a.size OR i.mtime != a.mtime)",
        )?;
        stmt.query_map([root_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<_>>()?
    };
    let todo: Vec<_> = todo
        .into_iter()
        .filter(|(id, rel, ..)| only.is_none_or(|o| o.contains(id)) && !crate::scan::unreadable(rel, unread))
        .collect();
    let root = root.to_string_lossy();
    for batch in todo.chunks(BATCH) {
        // On a thread of its own at low priority (see low_priority); this one stores, with the lock.
        let infos: Vec<_> = std::thread::scope(|s| {
            s.spawn(|| {
                crate::low_priority();
                batch
                    .iter()
                    .map(|(id, rel, ext, size, mtime)| {
                        let info = read_info(&abs_path(&root, rel), ext).unwrap_or_default();
                        (*id, *size, *mtime, info)
                    })
                    .collect()
            })
            .join()
            .unwrap()
        });
        let mut conn = db.lock().unwrap();
        let tx = conn.transaction()?;
        for (id, size, mtime, info) in &infos {
            store(&tx, *id, *size, *mtime, info)?;
        }
        tx.commit()?;
        report(&conn, &infos.iter().map(|i| i.0).collect::<Vec<_>>());
        drop(conn);
        std::thread::sleep(std::time::Duration::from_millis(1)); // let waiting UI commands in, see scan_root
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::{db, scan};
    use std::fs;

    /// A PCM WAV of `frames` silent frames, written by hand.
    pub fn wav(path: &Path, rate: u32, channels: u16, bits: u16, frames: u32) {
        let data = frames * u32::from(channels * bits / 8);
        let mut b = wav_header(rate, channels, bits, data);
        b.resize(b.len() + data as usize, 0);
        fs::write(path, b).unwrap();
    }

    /// A 16-bit AIFF of `frames` frames whose samples count up from 0 in steps of 7, written by hand.
    pub fn aiff(path: &Path, rate: u32, channels: u16, frames: u32) {
        let samples: Vec<u8> = (0..frames * u32::from(channels))
            .flat_map(|i| ((i * 7) as i16).to_be_bytes())
            .collect();
        // The rate as an 80-bit float: exponent, then the mantissa with its leading 1 at the top.
        let e = 31 - rate.leading_zeros();
        let mut b = b"FORM".to_vec();
        b.extend_from_slice(&(4 + 26 + 16 + samples.len() as u32).to_be_bytes());
        b.extend_from_slice(b"AIFFCOMM");
        b.extend_from_slice(&18u32.to_be_bytes());
        b.extend_from_slice(&channels.to_be_bytes());
        b.extend_from_slice(&frames.to_be_bytes());
        b.extend_from_slice(&16u16.to_be_bytes());
        b.extend_from_slice(&(16383 + e as u16).to_be_bytes());
        b.extend_from_slice(&(u64::from(rate) << (63 - e)).to_be_bytes());
        b.extend_from_slice(b"SSND");
        b.extend_from_slice(&(8 + samples.len() as u32).to_be_bytes());
        b.extend_from_slice(&[0; 8]); // offset, block size
        b.extend_from_slice(&samples);
        fs::write(path, b).unwrap();
    }

    #[test]
    fn converts_aiff_to_wav() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.aiff");
        aiff(&src, 8_000, 2, 4_000);
        let want = || AudioInfo {
            duration_ms: Some(500),
            sample_rate: Some(8_000),
            channels: Some(2),
            bits: Some(16),
        };
        assert_eq!(read_info(&src, "aiff"), Some(want()));
        let cache = dir.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let out = cache.join("a.wav");
        to_wav(&src, "aiff", &out).unwrap();
        assert_eq!(read_info(&out, "wav"), Some(want()));
        let wav = fs::read(&out).unwrap();
        assert_eq!(wav.len(), 44 + 4_000 * 2 * 2);
        // Samples come through unchanged, now little-endian.
        assert_eq!(&wav[44..50], &[0, 0, 7, 0, 14, 0]);
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1, "no temp file left");

        // Not a sound: an error, and nothing written.
        fs::write(&src, "garbage").unwrap();
        assert!(to_wav(&src, "aiff", &cache.join("b.wav")).is_err());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
    }

    #[test]
    fn trims_the_oldest_wavs() {
        let dir = tempfile::tempdir().unwrap();
        let at = |name: &str, secs: u64| {
            let p = dir.path().join(name);
            fs::write(&p, [0; 100]).unwrap();
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
            p
        };
        let (old, mid, new) = (at("old.wav", 1_000), at("mid.wav", 2_000), at("new.wav", 3_000));
        let png = at("thumb.png", 0);
        trim(&old, 250);
        // The oldest that isn't the one just asked for goes; other files stay.
        assert!(old.exists() && !mid.exists() && new.exists() && png.exists());
        trim(&new, 1_000);
        assert!(old.exists());
    }

    #[test]
    fn reads_wav_headers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.wav");
        wav(&p, 44_100, 2, 16, 44_100 * 3 + 8_820);
        let want = |ms, rate, ch, bits| AudioInfo {
            duration_ms: Some(ms),
            sample_rate: Some(rate),
            channels: Some(ch),
            bits: Some(bits),
        };
        assert_eq!(read_info(&p, "wav"), Some(want(3200, 44_100, 2, 16)));
        wav(&p, 22_050, 1, 8, 11_025);
        assert_eq!(read_info(&p, "wav"), Some(want(500, 22_050, 1, 8)));
        fs::write(&p, b"not audio").unwrap();
        assert_eq!(read_info(&p, "wav"), None);
    }

    #[test]
    fn fills_and_refreshes_stale_rows() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        wav(&r.join("a.wav"), 8_000, 1, 16, 8_000);
        fs::write(r.join("b.ogg"), "garbage").unwrap();
        fs::write(r.join("c.png"), "x").unwrap();
        let mut conn = db::open_memory();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [r.display().to_string()])
            .unwrap();
        scan::tests::scan(&mut conn, 1, r); // scan_root runs fill_audio at the end
        let by_name = |conn: &Connection, n: &str| {
            db::assets(conn, None)
                .unwrap()
                .into_iter()
                .find(|a| a.name == n)
                .unwrap()
        };
        let a = by_name(&conn, "a.wav");
        assert_eq!(
            (a.duration_ms, a.sample_rate, a.channels, a.bits),
            (Some(1000), Some(8_000), Some(1), Some(16))
        );
        assert_eq!(by_name(&conn, "b.ogg").duration_ms, None);
        assert_eq!(by_name(&conn, "c.png").sample_rate, None);

        // Nothing left to do: every audio file has a row, the unreadable one an empty one.
        let db = Mutex::new(conn);
        let mut reported = Vec::new();
        fill_audio(&db, 1, r, &[], None, |_, ids| reported.extend_from_slice(ids)).unwrap();
        assert!(reported.is_empty());
        let mut conn = db.into_inner().unwrap();

        // Details read from another version of the file don't apply.
        conn.execute("UPDATE assets SET size = size + 1 WHERE name = 'a.wav'", [])
            .unwrap();
        assert_eq!(by_name(&conn, "a.wav").duration_ms, None);
        // The file changes: the next scan reads it again.
        wav(&r.join("a.wav"), 8_000, 1, 16, 16_000);
        scan::tests::scan(&mut conn, 1, r);
        assert_eq!(by_name(&conn, "a.wav").duration_ms, Some(2000));
    }

    #[test]
    fn ignores_stale_reads_and_non_audio() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        wav(&r.join("a.wav"), 8_000, 1, 16, 8_000);
        let mut conn = db::open_memory();
        conn.execute("INSERT INTO roots (path) VALUES (?1)", [r.display().to_string()])
            .unwrap();
        scan::tests::scan(&mut conn, 1, r);
        let a = db::assets(&conn, None).unwrap().remove(0);
        assert_eq!(a.duration_ms, Some(1000));

        // A read of an older version that finishes after the current one was stored doesn't replace it.
        let old = AudioInfo {
            duration_ms: Some(5),
            ..Default::default()
        };
        store(&conn, a.id, a.size - 1, a.mtime, &old).unwrap();
        assert_eq!(db::asset(&conn, a.id).unwrap().duration_ms, Some(1000));

        // Renamed to a non-audio extension: same bytes, size and mtime, but no audio details, even after a rescan.
        fs::rename(r.join("a.wav"), r.join("a.txt")).unwrap();
        scan::rename_path(&conn, 1, r, &r.join("a.wav"), &r.join("a.txt"), &mut Vec::new()).unwrap();
        let a = db::asset(&conn, a.id).unwrap();
        assert_eq!((a.kind.as_str(), a.duration_ms, a.sample_rate), ("text", None, None));
        scan::tests::scan(&mut conn, 1, r);
        assert_eq!(db::asset(&conn, a.id).unwrap().duration_ms, None);
    }
}

//! LTC (SMPTE 12M linear timecode) reading, ported from prototypes/ltc/.
//!
//! ffmpeg decodes the file's first audio stream to 48 kHz PCM; every channel goes through its own
//! biphase-mark decoder, and the channel that yields valid frames is the LTC channel. Frames are then
//! grouped into TC blocks: runs where timecode advances in step with file time. In the example
//! content each block is one song, and the blocks are not in TC order.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

const SAMPLE_RATE: f64 = 48_000.0;
const SYNC_WORD: u128 = 0x3FFD; // bits 64–79: 0011 1111 1111 1101, oldest first
const MIN_BLOCK_SECONDS: f64 = 3.0; // shorter runs are garbled LTC (pre- and post-show)
const MIN_FRAMES: usize = 50; // fewer valid frames than this on every channel means "no LTC"

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub t: f64, // seconds into the file where the frame starts
    pub h: u8,
    pub m: u8,
    pub s: u8,
    pub f: u8,
    pub drop: bool,
}

/// A streaming biphase-mark decoder for one channel.
pub struct Decoder {
    sr: f64,
    dc: f64,
    amp: f64,
    high: bool,
    sample: u64,
    last_edge: u64,
    period: f64, // samples per bit, adapts to the signal
    half: Option<f64>,
    bits: u128,
    nbits: u32,
    pub frames: Vec<Frame>,
}

impl Decoder {
    pub fn new(sr: f64) -> Self {
        Decoder { sr, dc: 0.0, amp: 0.0, high: false, sample: 0, last_edge: 0, period: sr / 2000.0, half: None, bits: 0, nbits: 0, frames: Vec::new() }
    }

    pub fn push(&mut self, x: f64) {
        self.dc += (x - self.dc) * 0.001;
        let v = x - self.dc;
        self.amp = (self.amp * 0.9995).max(v.abs());
        let h = self.amp * 0.2;
        let edge = if self.high { v < -h } else { v > h };
        if edge && self.amp > 300.0 {
            self.high = !self.high;
            let interval = (self.sample - self.last_edge) as f64;
            self.last_edge = self.sample;
            self.interval(interval);
        }
        self.sample += 1;
    }

    fn interval(&mut self, iv: f64) {
        let p = self.period;
        if iv > p * 1.6 || iv < p * 0.25 {
            self.half = None; // dropout or glitch: resync
        } else if iv > p * 0.75 {
            self.half = None; // a long cell is a 0 (and also realigns a stray half)
            self.period = p * 0.95 + iv * 0.05;
            self.bit(0);
        } else if let Some(first) = self.half.take() {
            self.period = p * 0.95 + (first + iv) * 0.05; // two short cells are a 1
            self.bit(1);
        } else {
            self.half = Some(iv);
        }
        self.period = self.period.clamp(self.sr / 3000.0, self.sr / 1500.0);
    }

    fn bit(&mut self, b: u8) {
        self.bits = ((self.bits << 1) | b as u128) & ((1u128 << 80) - 1);
        self.nbits += 1;
        if self.nbits >= 80 && self.bits & 0xFFFF == SYNC_WORD {
            let data = (self.bits >> 16) as u64;
            let bit = |k: u32| ((data >> (63 - k)) & 1) as u8;
            let bcd = |start: u32, n: u32| (0..n).fold(0u8, |acc, i| acc | (bit(start + i) << i));
            let f = bcd(8, 2) * 10 + bcd(0, 4);
            let s = bcd(24, 3) * 10 + bcd(16, 4);
            let m = bcd(40, 3) * 10 + bcd(32, 4);
            let h = bcd(56, 2) * 10 + bcd(48, 4);
            if h < 24 && m < 60 && s < 60 && f < 30 {
                let t = (self.sample as f64 - 80.0 * self.period).max(0.0) / self.sr;
                self.frames.push(Frame { t, h, m, s, f, drop: bit(10) == 1 });
            }
        }
    }
}

/// 24, 25, 29.97 (drop-frame) or 30, from the highest frame number seen.
pub fn detect_fps(frames: &[Frame]) -> f64 {
    if frames.iter().any(|f| f.drop) {
        return 29.97;
    }
    match frames.iter().map(|f| f.f).max().unwrap_or(24) + 1 {
        24 => 24.0,
        30 => 30.0,
        _ => 25.0,
    }
}

fn tc_seconds(f: &Frame, fps: f64) -> f64 {
    f.h as f64 * 3600.0 + f.m as f64 * 60.0 + f.s as f64 + f.f as f64 / fps.round()
}

pub fn format_tc(f: &Frame) -> String {
    format!("{:02}:{:02}:{:02}{}{:02}", f.h, f.m, f.s, if f.drop { ';' } else { ':' }, f.f)
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TcBlock {
    pub file_start: f64,
    pub file_end: f64,
    pub tc_start: String,
    pub tc_end: String,
}

/// Group frames into runs where TC advances with file time. Isolated bad frames are dropped first.
pub fn to_blocks(frames: &[Frame], fps: f64) -> Vec<TcBlock> {
    let follows = |a: &Frame, b: &Frame| {
        let dt = b.t - a.t;
        dt > 0.0 && dt < 1.0 && ((tc_seconds(b, fps) - tc_seconds(a, fps)) - dt).abs() < 0.25
    };
    let good: Vec<&Frame> = frames
        .iter()
        .enumerate()
        .filter(|(i, f)| (*i > 0 && follows(&frames[i - 1], f)) || frames.get(i + 1).is_some_and(|n| follows(f, n)))
        .map(|(_, f)| f)
        .collect();
    let mut blocks = Vec::new();
    let mut start = 0;
    for i in 1..=good.len() {
        if i == good.len() || !follows(good[i - 1], good[i]) {
            let (a, b) = (good[start], good[i - 1]);
            if b.t - a.t >= MIN_BLOCK_SECONDS {
                blocks.push(TcBlock { file_start: a.t, file_end: b.t + 1.0 / fps, tc_start: format_tc(a), tc_end: format_tc(b) });
            }
            start = i;
        }
    }
    blocks
}

#[derive(Serialize, Debug)]
pub struct LtcResult {
    pub channel: Option<usize>,
    pub fps: Option<f64>,
    pub blocks: Vec<TcBlock>,
    pub duration: f64,
}

/// Decode every channel of `path` and report the TC blocks on whichever channel carries LTC.
/// `progress` gets the fraction done (0–1) every few seconds of audio.
/// `progress` gets the fraction read so far, every 10 seconds of audio; returning false stops the scan (an error).
pub const CANCELLED: &str = "Timecode scan skipped";

pub fn scan_file(ffmpeg: &Path, path: &str, channels: usize, duration: f64, max_seconds: Option<f64>, mut progress: impl FnMut(f64) -> bool) -> Result<LtcResult, String> {
    let channels = channels.clamp(1, 16);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error", "-nostdin"]);
    if let Some(t) = max_seconds {
        cmd.args(["-t", &t.to_string()]);
    }
    cmd.args(["-i", path, "-vn", "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "s16le", "-ar", "48000", "pipe:1"]);
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("run ffmpeg: {e}"))?;
    let mut out = child.stdout.take().ok_or("read ffmpeg output")?;
    let mut decoders: Vec<Decoder> = (0..channels).map(|_| Decoder::new(SAMPLE_RATE)).collect();
    let mut buf = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::new();
    let mut index: usize = 0; // interleaved sample index
    let report_every = (SAMPLE_RATE * 10.0) as usize * channels;
    let total = (duration.max(1.0) * SAMPLE_RATE) as usize * channels;
    loop {
        let n = out.read(&mut buf).map_err(|e| format!("read ffmpeg output: {e}"))?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 2 * 2;
        for pair in carry[..whole].chunks_exact(2) {
            decoders[index % channels].push(i16::from_le_bytes([pair[0], pair[1]]) as f64);
            index += 1;
            if index % report_every == 0 && !progress((index as f64 / total as f64).min(0.99)) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CANCELLED.into());
            }
        }
        carry.drain(..whole);
    }
    let status = child.wait().map_err(|e| format!("wait for ffmpeg: {e}"))?;
    if !status.success() && index == 0 {
        return Err("ffmpeg couldn't read the audio in this file".into());
    }
    let decoded = index as f64 / channels as f64 / SAMPLE_RATE;
    let best = decoders.iter().enumerate().max_by_key(|(_, d)| d.frames.len()).filter(|(_, d)| d.frames.len() >= MIN_FRAMES);
    let Some((channel, decoder)) = best else {
        return Ok(LtcResult { channel: None, fps: None, blocks: vec![], duration: decoded });
    };
    let fps = detect_fps(&decoder.frames);
    Ok(LtcResult { channel: Some(channel), fps: Some(fps), blocks: to_blocks(&decoder.frames, fps), duration: decoded })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Biphase-mark encode TC frames from `start` (h, m, s, f) at `fps`, `seconds` long.
    fn encode(start: (u8, u8, u8, u8), fps: u8, seconds: u32, sr: f64, level: &mut f64, out: &mut Vec<f64>) {
        let (mut h, mut m, mut s, mut f) = start;
        let bit_len = sr / (fps as f64 * 80.0);
        let mut pos = out.len() as f64;
        for _ in 0..(seconds * fps as u32) {
            let mut bits = [0u8; 80];
            let mut put = |start: usize, n: usize, v: u8| (0..n).for_each(|i| bits[start + i] = (v >> i) & 1);
            put(0, 4, f % 10); put(8, 2, f / 10);
            put(16, 4, s % 10); put(24, 3, s / 10);
            put(32, 4, m % 10); put(40, 3, m / 10);
            put(48, 4, h % 10); put(56, 2, h / 10);
            for (i, b) in [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1].iter().enumerate() {
                bits[64 + i] = *b;
            }
            for b in bits {
                *level = -*level;
                let mid = pos + bit_len / 2.0;
                let end = pos + bit_len;
                while (out.len() as f64) < mid { out.push(*level * 12000.0); }
                if b == 1 { *level = -*level; }
                while (out.len() as f64) < end { out.push(*level * 12000.0); }
                pos = end;
            }
            f += 1;
            if f == fps { f = 0; s += 1; }
            if s == 60 { s = 0; m += 1; }
            if m == 60 { m = 0; h += 1; }
        }
    }

    #[test]
    fn decodes_blocks_and_jumps() {
        let mut level = 1.0;
        let mut samples = vec![0.0; 4800]; // a little silence first
        encode((2, 0, 0, 0), 25, 8, SAMPLE_RATE, &mut level, &mut samples);
        encode((1, 30, 0, 0), 25, 6, SAMPLE_RATE, &mut level, &mut samples);
        let mut d = Decoder::new(SAMPLE_RATE);
        for x in &samples { d.push(*x); }
        assert!(d.frames.len() > 300, "decoded {} frames", d.frames.len());
        assert_eq!(detect_fps(&d.frames), 25.0);
        let blocks = to_blocks(&d.frames, 25.0);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        assert!(blocks[0].tc_start.starts_with("02:00:00:0"), "{}", blocks[0].tc_start);
        assert!(blocks[1].tc_start.starts_with("01:30:00:0"), "{}", blocks[1].tc_start);
        assert!((blocks[0].file_start - 0.1).abs() < 0.1, "{}", blocks[0].file_start);
        assert!((blocks[1].file_start - 8.1).abs() < 0.1, "{}", blocks[1].file_start);
    }

    #[test]
    fn decodes_30fps() {
        let mut level = 1.0;
        let mut samples = Vec::new();
        encode((10, 59, 58, 0), 30, 5, SAMPLE_RATE, &mut level, &mut samples);
        let mut d = Decoder::new(SAMPLE_RATE);
        for x in &samples { d.push(*x); }
        assert_eq!(detect_fps(&d.frames), 30.0);
        let blocks = to_blocks(&d.frames, 30.0);
        assert_eq!(blocks.len(), 1, "crosses 11:00:00:00 without breaking: {blocks:?}");
        assert!(blocks[0].tc_end.starts_with("11:00:0"));
    }

    #[test]
    fn noise_is_not_ltc() {
        let mut d = Decoder::new(SAMPLE_RATE);
        let mut x: u32 = 12345;
        for _ in 0..(SAMPLE_RATE as usize * 5) {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            d.push(((x >> 16) as f64 - 32768.0) / 2.0);
        }
        assert!(to_blocks(&d.frames, 25.0).is_empty());
    }

    #[test]
    fn reads_example_playback_if_present() {
        let file = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../Exmaple Content/AUDIO FILES/LTC + AUDIO - AUTUMN 2026 90' V4.1_48_24.wav");
        let Some(ffmpeg) = crate::tool_path("ffmpeg").filter(|_| file.exists()) else { return };
        let r = scan_file(&ffmpeg, &file.to_string_lossy(), 2, 30.0, Some(30.0), |_| true).unwrap();
        assert_eq!(r.channel, Some(1), "LTC is on channel 2");
        assert_eq!(r.fps, Some(25.0));
        assert!(r.blocks[0].tc_start.starts_with("02:00:"), "{:?}", r.blocks);
    }

    /// Slow (decodes 89 minutes of audio): cargo test --release scan_full_record -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scan_full_record() {
        let file = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Exmaple Content/SHOW RECORDS/OVERMONO - NYC T5 - FULL SHOW & TC.mp4");
        let Some(ffmpeg) = crate::tool_path("ffmpeg").filter(|_| file.exists()) else { return };
        let started = std::time::Instant::now();
        let r = scan_file(&ffmpeg, &file.to_string_lossy(), 2, 5400.0, None, |_| true).unwrap();
        println!("channel {:?} fps {:?} in {:?}", r.channel, r.fps, started.elapsed());
        for b in &r.blocks {
            println!("{:>8.1}s – {:>8.1}s  {} → {}", b.file_start, b.file_end, b.tc_start, b.tc_end);
        }
        assert_eq!(r.channel, Some(1));
        assert_eq!(r.blocks.len(), 19);
    }
}

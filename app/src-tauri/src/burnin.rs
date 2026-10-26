//! Burned-in timecode for clips: a card in the bottom-right corner with the song ("03  GOOD LIES") over the
//! record's TC and rate ("● 09:01:42:19   25 fps"). The green dot is lit while the clip has TC; outside
//! the record's TC blocks (pre-show, gaps between songs) the TC shows as dashes rather than made up.
//!
//! Homebrew's ffmpeg is built without freetype, so it has no drawtext. Instead every frame of the card is
//! drawn here, at the TC rate, and piped into ffmpeg as raw RGBA to overlay on the clip.

use crate::ltc::TcBlock;
use fontdue::{Font, FontSettings, Metrics};
use serde::Deserialize;
use std::collections::HashMap;

/// What the frontend sends to burn TC into a clip: the record's LTC rate and blocks, and the song.
#[derive(Deserialize)]
pub struct BurnIn {
    pub fps: f64,
    pub blocks: Vec<TcBlock>,
    /// The song's name and its place in the running order ("03"), for the card's top line.
    #[serde(default)]
    pub song: Option<String>,
    #[serde(default)]
    pub number: Option<String>,
}

impl BurnIn {
    /// The TC rate. Scans from before ltc::detect_fps ignored stray drop-frame flags may have called 25 fps
    /// LTC 29.97; when no block's TC is drop-frame, the rate whose TC spans best fit the blocks' lengths is used.
    fn rate(&self) -> f64 {
        let drop_tc = self.blocks.iter().any(|b| b.tc_start.contains(';') || b.tc_end.contains(';'));
        if !is_drop(self.fps) || drop_tc || self.blocks.is_empty() {
            return self.fps;
        }
        let misfit = |fps: f64| -> f64 {
            self.blocks.iter().map(|b| match (tc_frames(&b.tc_start, fps), tc_frames(&b.tc_end, fps)) {
                (Some(a), Some(z)) => ((z - a + 1) as f64 / fps - (b.file_end - b.file_start)).abs(),
                _ => f64::INFINITY,
            }).sum()
        };
        [24.0, 25.0, 30.0].into_iter().min_by(|a, b| misfit(*a).total_cmp(&misfit(*b))).unwrap_or(self.fps)
    }
}

// The card, in pixels of a 720p clip (scaled for other heights).
const MARGIN: (f32, f32) = (40.0, 32.0); // from the clip's right and bottom edges
const PAD: (f32, f32, f32) = (18.0, 12.0, 13.0); // sides, top, bottom
const RADIUS: f32 = 12.0;
const LABEL_SIZE: f32 = 13.0;
const LABEL_TRACKING: f32 = 0.09; // of the label size
const LABEL_LINE: f32 = 17.0;
const BADGE: (f32, f32, f32) = (5.0, 4.0, 8.0); // the number's badge: side padding, corner radius, gap after
const LINE_GAP: f32 = 4.0;
const TC_SIZE: f32 = 32.0;
const TC_LINE: f32 = 35.0;
const DOT: f32 = 10.0;
const GAP: f32 = 12.0;
const MAX_LABEL: f32 = 420.0; // longer song names are cut short with "…"

const CARD: [f32; 3] = [0.055, 0.055, 0.063];
const CARD_ALPHA: f32 = 0.78;
const WHITE: [f32; 3] = [1.0, 1.0, 1.0];
const GREEN: [f32; 3] = [0.18, 0.88, 0.29];

const SANS: &str = "/System/Library/Fonts/HelveticaNeue.ttc";
const SANS_REGULAR: u32 = 0; // faces in HelveticaNeue.ttc
const SANS_MEDIUM: u32 = 10;
const MONO: &str = "/System/Library/Fonts/Menlo.ttc";
const NO_TC: &str = "--:--:--:--";

/// A font at one size.
struct Face {
    font: Font,
    px: f32,
}

impl Face {
    fn load(path: &str, index: u32, px: f32) -> Result<Face, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read the font for the timecode ({path}): {e}"))?;
        let font = Font::from_bytes(bytes, FontSettings { collection_index: index, scale: px, ..FontSettings::default() })?;
        Ok(Face { font, px })
    }

    /// Where each character of `text` starts, with `tracking` pixels between characters, and the text's width.
    fn layout(&self, text: &str, tracking: f32) -> (Vec<(char, f32)>, f32) {
        let mut x = 0.0;
        let mut out = Vec::new();
        let mut prev = None;
        for c in text.chars() {
            if let Some(p) = prev {
                x += self.font.horizontal_kern(p, c, self.px).unwrap_or(0.0) + tracking;
            }
            out.push((c, x));
            x += self.font.metrics(c, self.px).advance_width;
            prev = Some(c);
        }
        (out, x)
    }

    fn width(&self, text: &str, tracking: f32) -> f32 {
        self.layout(text, tracking).1
    }

    /// How far a capital stands above the baseline.
    fn cap(&self) -> f32 {
        let m = self.font.metrics('H', self.px);
        m.height as f32 + m.ymin as f32
    }

    /// `text` cut short with "…" to fit in `max` pixels.
    fn fit(&self, text: &str, tracking: f32, max: f32) -> String {
        let mut chars: Vec<char> = text.chars().collect();
        if self.width(text, tracking) <= max {
            return text.to_string();
        }
        while !chars.is_empty() {
            chars.pop();
            let cut = format!("{}…", chars.iter().collect::<String>().trim_end());
            if self.width(&cut, tracking) <= max {
                return cut;
            }
        }
        "…".into()
    }
}

/// An RGBA image with straight alpha, as ffmpeg's overlay expects.
#[derive(Clone)]
struct Canvas {
    w: usize,
    h: usize,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: usize, h: usize) -> Canvas {
        Canvas { w, h, px: vec![0; w * h * 4] }
    }

    /// Lay `colour` at `alpha` over pixel (x, y).
    fn blend(&mut self, x: usize, y: usize, colour: [f32; 3], alpha: f32) {
        if alpha <= 0.0 || x >= self.w || y >= self.h {
            return;
        }
        let i = (y * self.w + x) * 4;
        let below = self.px[i + 3] as f32 / 255.0;
        let out = alpha + below * (1.0 - alpha);
        for (k, c) in colour.iter().enumerate() {
            let under = self.px[i + k] as f32 / 255.0;
            self.px[i + k] = ((c * alpha + under * below * (1.0 - alpha)) / out * 255.0).round() as u8;
        }
        self.px[i + 3] = (out * 255.0).round() as u8;
    }

    /// Fill a rectangle with rounded corners, smoothing its edges.
    #[allow(clippy::too_many_arguments)]
    fn round_rect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, colour: [f32; 3], alpha: f32) {
        let (cx, cy, hw, hh) = (x + w / 2.0, y + h / 2.0, w / 2.0 - r, h / 2.0 - r);
        for py in y.floor().max(0.0) as usize..((y + h).ceil() as usize).min(self.h) {
            for px in x.floor().max(0.0) as usize..((x + w).ceil() as usize).min(self.w) {
                let qx = (px as f32 + 0.5 - cx).abs() - hw;
                let qy = (py as f32 + 0.5 - cy).abs() - hh;
                let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
                self.blend(px, py, colour, (0.5 - d).clamp(0.0, 1.0) * alpha);
            }
        }
    }

    fn circle(&mut self, cx: f32, cy: f32, r: f32, colour: [f32; 3], alpha: f32) {
        self.round_rect(cx - r, cy - r, r * 2.0, r * 2.0, r, colour, alpha);
    }

    /// Draw a rasterised glyph with its pen position at `x` on `baseline`.
    fn glyph(&mut self, m: &Metrics, bitmap: &[u8], x: f32, baseline: f32, colour: [f32; 3], alpha: f32) {
        let left = (x + m.xmin as f32).round() as i64;
        let top = (baseline - (m.ymin as f32 + m.height as f32)).round() as i64;
        for gy in 0..m.height {
            for gx in 0..m.width {
                let (px, py) = (left + gx as i64, top + gy as i64);
                if px >= 0 && py >= 0 {
                    self.blend(px as usize, py as usize, colour, bitmap[gy * m.width + gx] as f32 / 255.0 * alpha);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, face: &Face, text: &str, x: f32, baseline: f32, tracking: f32, colour: [f32; 3], alpha: f32) {
        for (c, dx) in face.layout(text, tracking).0 {
            let (m, bitmap) = face.font.rasterize(c, face.px);
            self.glyph(&m, &bitmap, x + dx, baseline, colour, alpha);
        }
    }
}

pub struct Clock {
    blocks: Vec<TcBlock>,
    fps: f64,
    start: f64,
    frames: usize,
    /// The card with everything but the dot and the TC, which change from frame to frame.
    base: Canvas,
    digits: HashMap<char, (Metrics, Vec<u8>)>,
    tc_at: Vec<f32>, // where each character of the TC starts
    tc_x: f32,
    tc_baseline: f32,
    dot: (f32, f32, f32), // centre x, y and radius
    pub width: usize,
    pub height: usize,
    /// Pixels from the clip's right and bottom edges to the card.
    pub margin: (usize, usize),
}

impl Clock {
    /// The card for a clip `length` seconds long, cut from `start` seconds into the record, `clip_height` pixels tall.
    pub fn new(burn: BurnIn, start: f64, length: f64, clip_height: u32) -> Result<Clock, String> {
        let s = clip_height as f32 / 720.0;
        let fps = burn.rate();
        let label = Face::load(SANS, SANS_MEDIUM, LABEL_SIZE * s)?;
        let small = Face::load(SANS, SANS_REGULAR, LABEL_SIZE * s)?;
        let mono = Face::load(MONO, 0, TC_SIZE * s)?;
        let tracking = LABEL_TRACKING * LABEL_SIZE * s;
        let nonempty = |t: Option<String>| t.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let number = nonempty(burn.number);
        let song = nonempty(burn.song).map(|t| label.fit(&t.to_uppercase(), tracking, MAX_LABEL * s));

        // Widths of the two lines: [03] GOOD LIES over ● 09:01:42:19   25 fps.
        let badge_w = number.as_ref().map(|n| label.width(n, 0.0) + BADGE.0 * 2.0 * s);
        let song_w = song.as_ref().map(|t| label.width(t, tracking));
        let top_w = badge_w.map_or(0.0, |w| w + if song_w.is_some() { BADGE.2 * s } else { 0.0 }) + song_w.unwrap_or(0.0);
        let rate = format!("{} fps", if is_drop(fps) { format!("{fps:.2}") } else { format!("{fps}") });
        let rate_w = small.width(&rate, 0.0);
        let (tc_layout, tc_w) = mono.layout(NO_TC, 0.0);
        let bottom_w = (DOT + GAP * 2.0) * s + tc_w + rate_w;
        let top_h = if top_w > 0.0 { (LABEL_LINE + LINE_GAP) * s } else { 0.0 };
        let width = (top_w.max(bottom_w) + PAD.0 * 2.0 * s).ceil() as usize;
        let height = ((PAD.1 + TC_LINE + PAD.2) * s + top_h).ceil() as usize;

        let mut base = Canvas::new(width, height);
        base.round_rect(0.0, 0.0, width as f32, height as f32, RADIUS * s, CARD, CARD_ALPHA);
        let left = PAD.0 * s;
        if top_w > 0.0 {
            let mid = (PAD.1 + LABEL_LINE / 2.0) * s;
            let baseline = (mid + label.cap() / 2.0).round();
            let mut x = left;
            if let (Some(n), Some(w)) = (&number, badge_w) {
                base.round_rect(x, mid - (LABEL_LINE - 1.0) * s / 2.0, w, (LABEL_LINE - 1.0) * s, BADGE.1 * s, WHITE, 1.0);
                base.text(&label, n, x + BADGE.0 * s, baseline, 0.0, CARD, 1.0);
                x += w + BADGE.2 * s;
            }
            if let Some(t) = &song {
                base.text(&label, t, x, baseline, tracking, WHITE, 0.72);
            }
        }
        let row = PAD.1 * s + top_h + TC_LINE * s / 2.0;
        base.text(&small, &rate, width as f32 - left - rate_w, (row + small.cap() / 2.0).round(), 0.0, WHITE, 0.55);
        Ok(Clock {
            blocks: burn.blocks,
            fps,
            start,
            frames: (length * real_rate(fps)).ceil() as usize + 1,
            base,
            digits: "0123456789:;-".chars().map(|c| (c, mono.font.rasterize(c, mono.px))).collect(),
            tc_at: tc_layout.iter().map(|(_, x)| *x).collect(),
            tc_x: left + (DOT + GAP) * s,
            tc_baseline: (row + mono.cap() / 2.0).round(),
            dot: (left + DOT * s / 2.0, row, DOT * s / 2.0),
            width,
            height,
            margin: ((MARGIN.0 * s).round() as usize, (MARGIN.1 * s).round() as usize),
        })
    }

    /// ffmpeg arguments for the card as an input read from stdin.
    pub fn input_args(&self) -> Vec<String> {
        let rate = if is_drop(self.fps) { "30000/1001".to_string() } else { format!("{}", self.fps) };
        ["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", &format!("{}x{}", self.width, self.height), "-framerate", &rate, "-i", "pipe:0"]
            .map(String::from)
            .to_vec()
    }

    /// The overlay filter, putting input `clock` over `video` in the bottom-right corner.
    pub fn overlay(&self, video: &str, clock: &str) -> String {
        let (right, bottom) = self.margin;
        format!("{video}{clock}overlay=x=main_w-overlay_w-{right}:y=main_h-overlay_h-{bottom}:eof_action=pass:format=auto")
    }

    /// How many frames of the card cover the clip.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Frame `i` of the card, as RGBA.
    pub fn frame(&self, i: usize) -> Vec<u8> {
        let mut card = self.base.clone();
        let tc = tc_at(&self.blocks, self.fps, self.start + i as f64 / real_rate(self.fps));
        let (text, alpha, dot, dot_alpha) = match &tc {
            Some(tc) => (tc.as_str(), 1.0, GREEN, 1.0),
            None => (NO_TC, 0.35, WHITE, 0.3),
        };
        let (cx, cy, r) = self.dot;
        card.circle(cx, cy, r, dot, dot_alpha);
        for (c, x) in text.chars().zip(&self.tc_at) {
            if let Some((m, bitmap)) = self.digits.get(&c) {
                card.glyph(m, bitmap, self.tc_x + x, self.tc_baseline, WHITE, alpha);
            }
        }
        card.px
    }
}

/// 29.97 is only ever drop-frame here (see ltc::detect_fps).
fn is_drop(fps: f64) -> bool {
    fps.fract() != 0.0
}

/// Frames a second of real time.
fn real_rate(fps: f64) -> f64 {
    if is_drop(fps) { 30000.0 / 1001.0 } else { fps }
}

/// The TC at `t` seconds into the record, where TC runs on from the start of the block `t` is in; None
/// outside every block.
pub fn tc_at(blocks: &[TcBlock], fps: f64, t: f64) -> Option<String> {
    let block = blocks.iter().find(|b| t >= b.file_start && t < b.file_end)?;
    let start = tc_frames(&block.tc_start, fps)?;
    Some(format_frames(start + ((t - block.file_start) * real_rate(fps) + 1e-6).floor() as i64, fps))
}

/// A TC ("HH:MM:SS:FF", or "HH:MM:SS;FF" drop-frame) as a count of frames since midnight.
fn tc_frames(tc: &str, fps: f64) -> Option<i64> {
    let parts: Vec<i64> = tc.split([':', ';']).map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [h, m, s, f] = parts[..] else { return None };
    let nominal = fps.round() as i64;
    let frames = ((h * 60 + m) * 60 + s) * nominal + f;
    // Drop-frame skips frame numbers 0 and 1 at the start of every minute but each tenth.
    Some(if is_drop(fps) { frames - 2 * ((h * 60 + m) - (h * 60 + m) / 10) } else { frames })
}

fn format_frames(frames: i64, fps: f64) -> String {
    let nominal = fps.round() as i64;
    let (frames, sep) = if is_drop(fps) {
        let (tens, rest) = (frames / 17982, frames % 17982); // 17982 frames in ten drop-frame minutes
        (frames + 18 * tens + if rest < 2 { 0 } else { 2 * ((rest - 2) / 1798) }, ';')
    } else {
        (frames, ':')
    };
    let secs = frames / nominal;
    format!("{:02}:{:02}:{:02}{sep}{:02}", secs / 3600 % 24, secs / 60 % 60, secs % 60, frames % nominal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(file_start: f64, file_end: f64, tc_start: &str) -> TcBlock {
        TcBlock { file_start, file_end, tc_start: tc_start.into(), tc_end: String::new() }
    }

    #[test]
    fn tc_runs_on_from_the_block_start() {
        let blocks = [block(100.0, 200.0, "09:01:00:10"), block(300.0, 400.0, "10:00:00:00")];
        assert_eq!(tc_at(&blocks, 25.0, 100.0).as_deref(), Some("09:01:00:10"));
        assert_eq!(tc_at(&blocks, 25.0, 100.6).as_deref(), Some("09:01:01:00"));
        assert_eq!(tc_at(&blocks, 25.0, 159.6).as_deref(), Some("09:02:00:00"));
        assert_eq!(tc_at(&blocks, 25.0, 250.0), None);
        assert_eq!(tc_at(&blocks, 25.0, 300.04).as_deref(), Some("10:00:00:01"));
        assert_eq!(tc_at(&blocks, 24.0, 101.0).as_deref(), Some("09:01:01:10"));
    }

    #[test]
    fn drop_frame_skips_the_first_two_frames_of_most_minutes() {
        assert_eq!(format_frames(tc_frames("00:00:59;29", 29.97).unwrap() + 1, 29.97), "00:01:00;02");
        assert_eq!(format_frames(tc_frames("00:09:59;29", 29.97).unwrap() + 1, 29.97), "00:10:00;00");
        assert_eq!(format_frames(tc_frames("01:23:45;12", 29.97).unwrap(), 29.97), "01:23:45;12");
    }

    #[test]
    fn a_misread_drop_frame_rate_is_worked_out_from_the_blocks() {
        let burn = |tc_end: &str| BurnIn { fps: 29.97, blocks: vec![TcBlock { file_start: 10.0, file_end: 70.04, tc_start: "09:00:00:00".into(), tc_end: tc_end.into() }], song: None, number: None };
        assert_eq!(burn("09:01:00:00").rate(), 25.0);
        assert_eq!(burn("09:00:59;29").rate(), 29.97);
    }

    #[test]
    fn draws_the_card_with_tc_only_inside_a_block() {
        let burn = BurnIn { fps: 25.0, blocks: vec![block(10.0, 20.0, "01:00:00:00")], song: Some("Good Lies".into()), number: Some("03".into()) };
        let Ok(clock) = Clock::new(burn, 5.0, 10.0, 720) else { return };
        assert_eq!(clock.frames(), 251);
        let green = |px: &[u8]| px.chunks(4).filter(|p| p[3] > 200 && p[1] > 180 && p[0] < 120).count();
        let before = clock.frame(0);
        assert_eq!(before.len(), clock.width * clock.height * 4);
        assert!(before.chunks(4).filter(|p| p[3] > 150).count() > clock.width * clock.height / 2, "no card");
        assert_eq!(green(&before), 0, "a lit dot before the TC block");
        let during = clock.frame(5 * 25);
        assert!(green(&during) > 30, "no green dot");
        assert_ne!(before, during);
    }

    #[test]
    fn long_song_names_are_cut_short() {
        let Ok(face) = Face::load(SANS, SANS_MEDIUM, 13.0) else { return };
        assert_eq!(face.fit("GOOD LIES", 1.0, 400.0), "GOOD LIES");
        let cut = face.fit(&"VERY LONG SONG NAME ".repeat(10), 1.0, 200.0);
        assert!(cut.ends_with('…') && face.width(&cut, 1.0) <= 200.0, "{cut}");
    }
}


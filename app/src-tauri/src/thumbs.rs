//! Thumbnail suggestions: sample frames across a stretch of video, score each for brightness, sharpness
//! and colour, and return the best few (spread out, so they're not all the same moment) as preview JPEGs.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

const SAMPLES: usize = 24;
const W: usize = 160;
const H: usize = 90;
/// Luma below this, across a whole row or column, is a black bar.
const BAR: f64 = 16.0;

#[derive(Serialize, Debug, Clone)]
pub struct Candidate {
    time: f64,
    path: String,
    score: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Measures {
    luma: f64,      // mean, 0–255
    contrast: f64,  // luma standard deviation
    sharpness: f64, // variance of the Laplacian
    colour: f64,    // Hasler–Süsstrunk colourfulness
}

/// Rows and columns of black bars (letterbox, pillarbox) around the picture: `(x0, x1, y0, y1)`, end-exclusive.
fn active_area(luma: &[f64]) -> (usize, usize, usize, usize) {
    let dark_row = |y: usize| luma[y * W..(y + 1) * W].iter().all(|v| *v < BAR);
    let dark_col = |x: usize, y0: usize, y1: usize| (y0..y1).all(|y| luma[y * W + x] < BAR);
    let y0 = (0..H).find(|&y| !dark_row(y)).unwrap_or(0);
    let y1 = (0..H).rev().find(|&y| !dark_row(y)).map_or(H, |y| y + 1).max(y0 + 1);
    let x0 = (0..W).find(|&x| !dark_col(x, y0, y1)).unwrap_or(0);
    let x1 = (0..W).rev().find(|&x| !dark_col(x, y0, y1)).map_or(W, |x| x + 1).max(x0 + 1);
    (x0, x1, y0, y1)
}

/// Measure a W×H RGB24 frame, inside any black bars (they'd make every letterboxed frame look underexposed).
fn measure(rgb: &[u8]) -> Measures {
    if rgb.len() < W * H * 3 {
        return Measures::default();
    }
    let full: Vec<f64> = rgb.chunks_exact(3).take(W * H).map(|p| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64).collect();
    let (x0, x1, y0, y1) = active_area(&full);
    let (w, h) = (x1 - x0, y1 - y0);
    if w < 8 || h < 8 {
        return Measures::default(); // all black, or nearly
    }
    let px = |x: usize, y: usize| &rgb[((y0 + y) * W + x0 + x) * 3..][..3];
    let luma: Vec<f64> = (0..h).flat_map(|y| (0..w).map(move |x| (y0 + y) * W + x0 + x)).map(|i| full[i]).collect();
    let n = w * h;
    let mean = luma.iter().sum::<f64>() / n as f64;
    let contrast = (luma.iter().map(|y| (y - mean).powi(2)).sum::<f64>() / n as f64).sqrt();

    let mut lap = Vec::with_capacity((w - 2) * (h - 2));
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            lap.push(luma[i - w] + luma[i + w] + luma[i - 1] + luma[i + 1] - 4.0 * luma[i]);
        }
    }
    let lm = lap.iter().sum::<f64>() / lap.len() as f64;
    let sharpness = lap.iter().map(|v| (v - lm).powi(2)).sum::<f64>() / lap.len() as f64;

    let (mut rg, mut yb) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = (px(x, y)[0] as f64, px(x, y)[1] as f64, px(x, y)[2] as f64);
            rg.push(r - g);
            yb.push(0.5 * (r + g) - b);
        }
    }
    let stats = |v: &[f64]| {
        let m = v.iter().sum::<f64>() / v.len() as f64;
        (m, (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt())
    };
    let ((mrg, srg), (myb, syb)) = (stats(&rg), stats(&yb));
    let colour = (srg * srg + syb * syb).sqrt() + 0.3 * (mrg * mrg + myb * myb).sqrt();
    Measures { luma: mean, contrast, sharpness, colour }
}

/// 0–1: best around mid-grey, fading out for very dark or blown-out frames and nothing for black or white ones.
fn exposure(luma: f64) -> f64 {
    let fade = ((luma - 8.0) / 22.0).min((250.0 - luma) / 15.0).clamp(0.0, 1.0);
    fade * (1.0 - (luma - 125.0).abs() / 125.0).max(0.0).sqrt()
}

/// Score each frame against the others: sharp, colourful, contrasty and well exposed wins.
fn scores(m: &[Measures]) -> Vec<f64> {
    let max = |f: fn(&Measures) -> f64| m.iter().map(f).fold(1e-9, f64::max);
    let (ms, mc, mk) = (max(|x| x.sharpness), max(|x| x.colour), max(|x| x.contrast));
    m.iter()
        .map(|x| exposure(x.luma) * (0.45 * (x.sharpness / ms).sqrt() + 0.35 * x.colour / mc + 0.2 * x.contrast / mk))
        .collect()
}

/// The best `count` indices, at least `gap` samples apart. When too few frames score (a dark song), frames that
/// don't fill in, then frames closer together, so there's always something to pick from. Unread frames score < 0.
fn pick(scores: &[f64], count: usize, gap: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    let mut chosen: Vec<usize> = Vec::new();
    for (min, gap) in [(f64::MIN_POSITIVE, gap), (0.0, gap), (0.0, 1)] {
        for &i in &order {
            if chosen.len() == count {
                break;
            }
            if scores[i] >= min && chosen.iter().all(|c| c.abs_diff(i) >= gap) {
                chosen.push(i);
            }
        }
    }
    chosen.sort();
    chosen
}

fn frame(ffmpeg: &Path, source: &str, t: f64) -> Option<Vec<u8>> {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-nostdin", "-ss", &format!("{t:.3}"), "-i", source, "-frames:v", "1"])
        .args(["-vf", &format!("scale={W}:{H}"), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])
        .output()
        .ok()?;
    (out.status.success() && out.stdout.len() >= W * H * 3).then_some(out.stdout)
}

#[tauri::command]
pub async fn thumb_candidates(app: AppHandle, source: String, start: f64, end: f64, count: usize) -> Result<Vec<Candidate>, String> {
    let ffmpeg = crate::ffmpeg_path()?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (lo, hi) = (start + 0.5, (end - 0.5).max(start + 0.6));
        let times: Vec<f64> = (0..SAMPLES).map(|i| lo + (hi - lo) * (i as f64 + 0.5) / SAMPLES as f64).collect();
        // Four ffmpegs at a time.
        let mut measures = vec![Measures::default(); SAMPLES];
        let mut read = [false; SAMPLES];
        for chunk in (0..SAMPLES).collect::<Vec<_>>().chunks(4) {
            std::thread::scope(|s| {
                let (ffmpeg, source, times) = (&ffmpeg, &source, &times);
                let handles: Vec<_> = chunk.iter().map(|&i| (i, s.spawn(move || frame(ffmpeg, source, times[i])))).collect();
                for (i, h) in handles {
                    if let Ok(Some(rgb)) = h.join() {
                        measures[i] = measure(&rgb);
                        read[i] = true;
                    }
                }
            });
        }
        let sc: Vec<f64> = scores(&measures).into_iter().zip(read).map(|(s, ok)| if ok { s } else { -1.0 }).collect();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let mut out = Vec::new();
        for i in pick(&sc, count, (SAMPLES / (count * 2).max(1)).max(1)) {
            let path: PathBuf = cache.join(format!("{stamp}-{i}.jpg"));
            let ok = Command::new(&ffmpeg)
                .args(["-v", "error", "-nostdin", "-y", "-ss", &format!("{:.3}", times[i]), "-i", &source, "-frames:v", "1", "-vf", "scale=-2:360", "-q:v", "4"])
                .arg(&path)
                .status()
                .is_ok_and(|s| s.success());
            if ok {
                out.push(Candidate { time: times[i], path: path.to_string_lossy().into(), score: sc[i] });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(r: u8, g: u8, b: u8) -> Vec<u8> {
        [r, g, b].repeat(W * H)
    }

    #[test]
    fn black_and_flat_frames_lose_to_a_detailed_colourful_one() {
        let mut busy = Vec::with_capacity(W * H * 3);
        for y in 0..H {
            for x in 0..W {
                let on = (x / 4 + y / 4) % 2 == 0;
                busy.extend_from_slice(if on { &[220, 60, 40] } else { &[40, 90, 200] });
            }
        }
        let m = [measure(&flat(0, 0, 0)), measure(&flat(128, 128, 128)), measure(&busy), measure(&flat(255, 255, 255))];
        let s = scores(&m);
        assert_eq!(s[0], 0.0, "black");
        assert_eq!(s[3], 0.0, "blown out");
        assert!(s[2] > s[1], "detail and colour beat flat grey");
    }

    #[test]
    fn picks_are_spread_out() {
        let s = [0.1, 0.9, 0.95, 0.2, 0.3, 0.8, 0.1, 0.7];
        assert_eq!(pick(&s, 3, 2), vec![2, 5, 7]);
    }

    #[test]
    fn dark_songs_still_offer_a_full_set() {
        assert_eq!(pick(&[0.0, 0.0, 0.4, 0.0, 0.0, 0.0], 3, 2).len(), 3, "one good frame, the rest black");
        assert_eq!(pick(&[0.0; 6], 3, 2).len(), 3, "all black");
        assert_eq!(pick(&[-1.0, -1.0, 0.0, -1.0], 3, 2), vec![2], "unread frames never");
    }

    #[test]
    fn letterbox_bars_dont_count_against_a_frame() {
        let mut boxed = Vec::with_capacity(W * H * 3);
        for y in 0..H {
            for _ in 0..W {
                boxed.extend_from_slice(if (20..70).contains(&y) { &[150, 60, 20] } else { &[0, 0, 0] });
            }
        }
        let m = measure(&boxed);
        assert!(m.luma > 70.0, "measured the picture, not the bars: {}", m.luma);
        assert!(exposure(m.luma) > 0.5);
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// PM_THUMB_SOURCE=<video> [PM_THUMB_FROM=<s> PM_THUMB_TO=<s>] cargo test thumbs::real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn scores_a_real_video() {
        let Ok(source) = std::env::var("PM_THUMB_SOURCE") else { return };
        let env = |k: &str, d: f64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (from, to) = (env("PM_THUMB_FROM", 2.0), env("PM_THUMB_TO", 2.0 + SAMPLES as f64 * 6.0));
        let ffmpeg = crate::ffmpeg_path().unwrap();
        let at = |i: usize| from + (to - from) * (i as f64 + 0.5) / SAMPLES as f64;
        let m: Vec<Measures> = (0..SAMPLES).map(|i| frame(&ffmpeg, &source, at(i)).map(|f| measure(&f)).unwrap_or_default()).collect();
        let s = scores(&m);
        for (i, (x, sc)) in m.iter().zip(&s).enumerate() {
            println!("{:>7.1}s luma {:>5.1} sharp {:>8.1} colour {:>5.1} score {:.3}", at(i), x.luma, x.sharpness, x.colour, sc);
        }
        println!("picked {:?}", pick(&s, 3, 4));
    }
}

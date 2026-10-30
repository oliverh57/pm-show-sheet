//! File access for show bundles. The bundle layout is described in DESIGN.md §6:
//!
//! ```text
//! MyShow.showsheet/
//!   project.json        show data (same shape the Google prototype publishes)
//!   project.json.bak    previous save
//!   media/{renders,grabs,crops,clips,layout,inspo}/
//!   thumbs/  proxies/
//! ```
//! The frontend owns the schema; Rust only moves JSON and files around.

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

mod burnin;
mod drive;
mod google;
mod ltc;
mod shows;
mod stream;
mod thumbs;
mod tools;

const PROJECT: &str = "project.json";
const CLIP_HEIGHT: u32 = 720;
const MEDIA_KINDS: [&str; 5] = ["renders", "grabs", "clips", "layout", "inspo"];

fn err<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

/// Write via a temp file and rename, so a crash mid-save never leaves a half-written project.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(err("write temp file"))?;
    fs::rename(&tmp, path).map_err(err("replace project file"))
}

#[tauri::command]
fn bundle_create(path: String, project: Value) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if root.exists() && fs::read_dir(&root).map_err(err("read folder"))?.next().is_some() {
        return Err(format!("{path} already exists and isn't empty"));
    }
    for kind in MEDIA_KINDS {
        fs::create_dir_all(root.join("media").join(kind)).map_err(err("create media folders"))?;
    }
    fs::create_dir_all(root.join("thumbs")).map_err(err("create thumbs folder"))?;
    fs::create_dir_all(root.join("proxies")).map_err(err("create proxies folder"))?;
    let bytes = serde_json::to_vec_pretty(&project).map_err(err("encode project"))?;
    write_atomic(&root.join(PROJECT), &bytes)
}

#[tauri::command]
fn bundle_open(path: String) -> Result<Value, String> {
    let file = PathBuf::from(&path).join(PROJECT);
    let text = fs::read_to_string(&file).map_err(err("open project.json"))?;
    serde_json::from_str(&text).map_err(err("parse project.json"))
}

#[tauri::command]
fn bundle_save(path: String, project: Value) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let file = root.join(PROJECT);
    if file.exists() {
        fs::copy(&file, root.join("project.json.bak")).map_err(err("back up previous save"))?;
    }
    let bytes = serde_json::to_vec_pretty(&project).map_err(err("encode project"))?;
    write_atomic(&file, &bytes)
}

/// Copy a file into `media/<kind>/` and return its path relative to the bundle.
/// An existing file with the same name is never overwritten: a numeric suffix is added.
#[tauri::command]
fn media_import(bundle: String, source: String, kind: String) -> Result<String, String> {
    if !MEDIA_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown media kind '{kind}'"));
    }
    let src = PathBuf::from(&source);
    let dir = PathBuf::from(&bundle).join("media").join(&kind);
    fs::create_dir_all(&dir).map_err(err("create media folder"))?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file").to_string();
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let name = unique_name(Path::new(&bundle), &kind, &stem, &ext);
    fs::copy(&src, dir.join(&name)).map_err(err("copy media"))?;
    Ok(format!("media/{kind}/{name}"))
}

/// `stem.ext`, or `stem_2.ext`, `stem_3.ext`… if that name is taken in `media/<kind>/`: a file on this Mac, or one the
/// show knows of that isn't here (in its Google Drive folder, or named in project.json: cleared to save space, or made on
/// another Mac and not downloaded yet). Taking one of those would overwrite another picture everywhere it's used.
fn unique_name(bundle: &Path, kind: &str, stem: &str, ext: &str) -> String {
    let dir = bundle.join("media").join(kind);
    let known = known_media(bundle);
    let taken = |name: &str| dir.join(name).exists() || known.contains(&format!("media/{kind}/{name}"));
    let dot = if ext.is_empty() { String::new() } else { format!(".{ext}") };
    let mut name = format!("{stem}{dot}");
    let mut n = 2;
    while taken(&name) {
        name = format!("{stem}_{n}{dot}");
        n += 1;
    }
    name
}

/// The bundle-relative media paths a show knows of: its Drive manifest's files and every "media/…" in project.json.
fn known_media(bundle: &Path) -> std::collections::HashSet<String> {
    fn walk(v: &Value, out: &mut std::collections::HashSet<String>) {
        match v {
            Value::String(s) if s.starts_with("media/") => { out.insert(s.clone()); }
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let read = |name: &str| fs::read_to_string(bundle.join(name)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let mut out = std::collections::HashSet::new();
    if let Some(project) = read(PROJECT) { walk(&project, &mut out); }
    if let Some(files) = read(drive::MANIFEST).as_ref().and_then(|m| m["files"].as_object()) {
        out.extend(files.keys().filter(|k| k.starts_with("media/")).cloned());
    }
    out
}

/// A name safe to use as a file name: "03 Be Quiet / Drive" → "03 Be Quiet - Drive".
fn safe_stem(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() { "clip".into() } else { trimmed }
}

/// Per-machine files kept beside project.json: render-cull decisions (they hold local paths, so they aren't show data),
/// and for a show's copy of Google Drive its manifest, the version last agreed with Drive and a just-downloaded copy.
const SIDE_FILES: [&str; 4] = ["inbox.json", ".drive.json", "base.json", ".remote.json"];

#[tauri::command]
fn side_read(bundle: String, name: String) -> Result<Option<Value>, String> {
    if !SIDE_FILES.contains(&name.as_str()) {
        return Err(format!("unknown side file '{name}'"));
    }
    let file = PathBuf::from(&bundle).join(&name);
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file).map_err(err("read side file"))?;
    serde_json::from_str(&text).map(Some).map_err(err("parse side file"))
}

#[tauri::command]
fn side_write(bundle: String, name: String, value: Value) -> Result<(), String> {
    if !SIDE_FILES.contains(&name.as_str()) {
        return Err(format!("unknown side file '{name}'"));
    }
    let bytes = serde_json::to_vec_pretty(&value).map_err(err("encode side file"))?;
    fs::create_dir_all(&bundle).map_err(err("create show folder"))?;
    write_atomic(&PathBuf::from(&bundle).join(&name), &bytes)
}

#[derive(serde::Serialize)]
struct FolderFile {
    path: String,
    name: String,
    size: u64,
    modified_ms: u64,
}

/// Files directly inside `folder` with one of `extensions` (case-insensitive), oldest first.
#[tauri::command]
fn list_folder(folder: String, extensions: Vec<String>) -> Result<Vec<FolderFile>, String> {
    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let mut out = Vec::new();
    for entry in fs::read_dir(&folder).map_err(err("read folder"))? {
        let entry = entry.map_err(err("read folder entry"))?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !exts.contains(&ext) {
            continue;
        }
        let meta = entry.metadata().map_err(err("read file info"))?;
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(FolderFile { path: path.to_string_lossy().to_string(), name, size: meta.len(), modified_ms });
    }
    out.sort_by_key(|f| (f.modified_ms, f.name.clone()));
    Ok(out)
}

/// The copy the setup guide installed (see tools.rs), else Homebrew's. Apps opened from Finder don't
/// inherit the shell PATH, so look in the usual Homebrew places too.
pub(crate) fn tool_path(name: &str) -> Option<PathBuf> {
    tools::tools_dir()
        .into_iter()
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .map(|d| d.join(name))
        .find(|p| p.exists())
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.exists()))
        })
}

fn ffprobe_path() -> Option<PathBuf> {
    tool_path("ffprobe")
}

fn ffmpeg_path() -> Result<PathBuf, String> {
    tool_path("ffmpeg").ok_or_else(|| "ffmpeg isn't installed. Quit and reopen the app to install it.".to_string())
}

/// Duration, picture and sound details of a media file, via ffprobe. `available: false` if ffprobe isn't installed.
#[tauri::command]
fn probe_media(path: String) -> Result<Value, String> {
    let Some(ffprobe) = ffprobe_path() else {
        return Ok(serde_json::json!({ "available": false }));
    };
    let output = std::process::Command::new(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &path])
        .output()
        .map_err(err("run ffprobe"))?;
    if !output.status.success() {
        return Err(format!("ffprobe couldn't read {path}"));
    }
    let raw: Value = serde_json::from_slice(&output.stdout).map_err(err("parse ffprobe output"))?;
    let streams = raw["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let timecode = streams.iter().find_map(|s| s["tags"]["timecode"].as_str().map(String::from));
    let fps = video.and_then(|v| v["r_frame_rate"].as_str()).and_then(|r| {
        let (n, d) = r.split_once('/')?;
        let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
        (d > 0.0).then(|| (n / d * 1000.0).round() / 1000.0)
    });
    Ok(serde_json::json!({
        "available": true,
        "duration": raw["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()),
        "width": video.and_then(|v| v["width"].as_u64()),
        "height": video.and_then(|v| v["height"].as_u64()),
        "fps": fps,
        "video_codec": video.and_then(|v| v["codec_name"].as_str()),
        "audio_channels": audio.and_then(|a| a["channels"].as_u64()),
        "sample_rate": audio.and_then(|a| a["sample_rate"].as_str()).and_then(|r| r.parse::<u64>().ok()),
        "timecode_track": timecode,
    }))
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    id: String,
    fraction: f64,
}

/// Scan a file's audio for LTC (see ltc.rs). Emits `ltc-progress` events while it reads.
#[tauri::command]
async fn ltc_scan(app: AppHandle, path: String) -> Result<ltc::LtcResult, String> {
    let ffmpeg = ffmpeg_path()?;
    let info = probe_media(path.clone())?;
    let channels = info["audio_channels"].as_u64().ok_or("This file has no audio to read timecode from")? as usize;
    let duration = info["duration"].as_f64().unwrap_or(0.0);
    tauri::async_runtime::spawn_blocking(move || {
        ltc::scan_file(&ffmpeg, &path, channels, duration, None, |fraction| {
            let _ = app.emit("ltc-progress", Progress { id: path.clone(), fraction });
            true
        })
    })
    .await
    .map_err(err("scan for timecode"))?
}

/// Cut `start`–`end` (seconds) of a record into a 720p H.264 clip in media/clips/, for Drive and the
/// slides. Emits `clip-progress` events with `job` as the id. Returns the bundle-relative path.
/// When the record carries LTC on `ltc_channel` the clip keeps it, on one side of a stereo track, and
/// its name ends `_LTC-L` or `_LTC-R` to say which (that's how the app knows a file has timecode).
/// With `burn_in` the record's TC is also drawn in the clip's bottom-right corner (see burnin.rs).
/// `cuts` are pauses (seconds into the record) left out: the clip jumps over each, with GAP CUT drawn on it.
/// A clip with the same name is replaced, so cutting a song again doesn't leave copies behind; the
/// clip is written to a .part file first, so a cut that's cut short never looks like a finished clip.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn clip_cut(app: AppHandle, job: String, bundle: String, source: String, start: f64, end: f64, cuts: Option<Vec<(f64, f64)>>, name: String, ltc_channel: Option<usize>, burn_in: Option<burnin::BurnIn>) -> Result<String, String> {
    let ffmpeg = ffmpeg_path()?;
    if end <= start {
        return Err("The clip's end is before its start".into());
    }
    let parts = clip_parts(start, end, &cuts.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&bundle).join("media").join("clips");
        fs::create_dir_all(&dir).map_err(err("create clips folder"))?;
        let audio = probe_media(source.clone()).map(|i| i["audio_channels"].as_u64()).unwrap_or(Some(2));
        let channels = audio.unwrap_or(2) as usize;
        let (pan, suffix) = match ltc_channel.map(|ltc| clip_pan(ltc, channels)) {
            Some((pan, side)) => (Some(pan), format!("_LTC-{side}")),
            None => (None, String::new()),
        };
        let file = format!("{}{suffix}.mp4", safe_stem(&name));
        let part = dir.join(format!(".{file}.part"));
        let burn_in = burn_in.filter(|b| b.tc || parts.len() > 1);
        let clock = burn_in.map(|b| burnin::Clock::new(b, parts.clone(), CLIP_HEIGHT)).transpose()?;
        cut_with_ffmpeg(&ffmpeg, &source, &parts, audio.is_some(), pan.as_deref(), clock, &part, |fraction| {
            let _ = app.emit("clip-progress", Progress { id: job.clone(), fraction });
        })?;
        fs::rename(&part, dir.join(&file)).map_err(err("save clip"))?;
        Ok(format!("media/clips/{file}"))
    })
    .await
    .map_err(err("cut clip"))?
}

/// The stretches (start, length) of `start`–`end` that are left once the `cuts` (pauses, in seconds) are taken out.
fn clip_parts(start: f64, end: f64, cuts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut parts = Vec::new();
    let mut from = start;
    for &(a, b) in cuts {
        if a > from && b < end {
            parts.push((from, a - from));
            from = b;
        }
    }
    parts.push((from, end - from));
    parts
}

/// Cut `parts` of `source` (start and length in seconds) into one 720p H.264 clip at `part`, with the audio
/// filter `pan` and `clock` drawn over the picture. `progress` gets the fraction done.
#[allow(clippy::too_many_arguments)]
fn cut_with_ffmpeg(ffmpeg: &Path, source: &str, parts: &[(f64, f64)], audio: bool, pan: Option<&str>, clock: Option<burnin::Clock>, part: &Path, mut progress: impl FnMut(f64)) -> Result<(), String> {
    let scale = format!("scale=-2:{CLIP_HEIGHT}");
    let length: f64 = parts.iter().map(|(_, len)| len).sum();
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y"]);
    if let [(start, _)] = parts {
        cmd.args(["-ss", &format!("{start:.3}"), "-i", source]);
        match &clock {
            Some(clock) => cmd
                .args(clock.input_args())
                .args(["-filter_complex", &format!("[0:v:0]{scale}[s];{}[v]", clock.overlay("[s]", "[1:v]")), "-map", "[v]"])
                .stdin(Stdio::piped()),
            None => cmd.args(["-map", "0:v:0", "-vf", &scale]),
        };
        cmd.args(["-map", "0:a:0?"]).args(pan.iter().flat_map(|p| ["-af", p]));
    } else {
        // Each stretch is its own input, joined end to end.
        for (start, len) in parts {
            cmd.args(["-ss", &format!("{start:.3}"), "-t", &format!("{len:.3}"), "-i", source]);
        }
        let n = parts.len();
        let mut graph: String = (0..n).map(|i| format!("[{i}:v:0]{scale},setsar=1[v{i}];")).collect();
        graph += &(0..n).map(|i| if audio { format!("[v{i}][{i}:a:0]") } else { format!("[v{i}]") }).collect::<String>();
        graph += &format!("concat=n={n}:v=1:a={}[cv]{}", audio as u8, if audio { "[ca]" } else { "" });
        let video = match &clock {
            Some(clock) => {
                cmd.args(clock.input_args()).stdin(Stdio::piped());
                graph += &format!(";{}[v]", clock.overlay("[cv]", &format!("[{n}:v]")));
                "[v]"
            }
            None => "[cv]",
        };
        let sound = match pan.filter(|_| audio) {
            Some(pan) => {
                graph += &format!(";[ca]{pan}[a]");
                Some("[a]")
            }
            None => audio.then_some("[ca]"),
        };
        cmd.args(["-filter_complex", &graph, "-map", video]).args(sound.iter().flat_map(|s| ["-map", s]));
    }
    let mut child = cmd
        .args(["-t", &format!("{length:.3}"), "-c:v", "libx264", "-preset", "veryfast"])
        .args(["-b:v", "2500k", "-maxrate", "3000k", "-bufsize", "6000k", "-pix_fmt", "yuv420p"])
        .args(["-c:a", "aac", "-b:a", "256k", "-ac", "2", "-movflags", "+faststart", "-progress", "pipe:1", "-f", "mp4"])
        .arg(part)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err("run ffmpeg"))?;
    // The clock's frames go in on stdin while the progress comes out on stdout. ffmpeg stops reading once
    // the clip is long enough, so a failed write just ends the clock.
    let drawing = clock.zip(child.stdin.take()).map(|(clock, mut stdin)| {
        std::thread::spawn(move || {
            for i in 0..clock.frames() {
                if stdin.write_all(&clock.frame(i)).is_err() {
                    break;
                }
            }
        })
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
                progress((us / 1e6 / length).clamp(0.0, 0.99));
            }
        }
    }
    let output = child.wait_with_output().map_err(err("wait for ffmpeg"))?;
    if let Some(drawing) = drawing {
        let _ = drawing.join();
    }
    if !output.status.success() {
        let _ = fs::remove_file(part);
        let msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg couldn't cut the clip: {}", msg.lines().last().unwrap_or("unknown error")));
    }
    Ok(())
}

/// The ffmpeg audio filter for a clip of a record with LTC on channel `ltc` of `channels`: the LTC on
/// one side (left if it's the record's first channel, otherwise right) and the rest of the record,
/// mixed to mono, on the other. Returns the filter and the LTC side, 'L' or 'R'.
fn clip_pan(ltc: usize, channels: usize) -> (String, char) {
    let programme: Vec<usize> = (0..channels.max(ltc + 1)).filter(|c| *c != ltc).collect();
    let mix = match programme.len() {
        0 => format!("0*c{ltc}"),
        1 => format!("c{}", programme[0]),
        n => programme.iter().map(|c| format!("{:.4}*c{c}", 1.0 / n as f64)).collect::<Vec<_>>().join("+"),
    };
    if ltc == 0 {
        (format!("pan=stereo|c0=c{ltc}|c1={mix}"), 'L')
    } else {
        (format!("pan=stereo|c0={mix}|c1=c{ltc}"), 'R')
    }
}

/// The ffmpeg audio filter for a saved copy: every channel in `keep`, in order (mono for one, stereo for two).
fn keep_filter(keep: &[usize]) -> Option<String> {
    let layout = match keep.len() {
        0 => return None,
        1 => "mono".to_string(),
        2 => "stereo".to_string(),
        n => format!("{n}c"),
    };
    let map: Vec<String> = keep.iter().enumerate().map(|(i, c)| format!("c{i}=c{c}")).collect();
    Some(format!("pan={layout}|{}", map.join("|")))
}

/// Copy `from` to `to` a megabyte at a time, so a big record (or one still coming down from Drive) shows progress.
fn copy_with_progress(from: &Path, to: &Path, mut progress: impl FnMut(f64)) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut src = fs::File::open(from).map_err(err("open the file"))?;
    let total = src.metadata().map(|m| m.len()).unwrap_or(0).max(1) as f64;
    let mut dst = fs::File::create(to).map_err(err("create the copy"))?;
    let mut buf = vec![0u8; 1 << 20];
    let (mut done, mut reported) = (0u64, 0.0);
    loop {
        let n = src.read(&mut buf).map_err(err("read the file"))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(err("write the copy"))?;
        done += n as u64;
        let fraction = done as f64 / total;
        if fraction - reported >= 0.01 {
            progress(fraction.min(0.99));
            reported = fraction;
        }
    }
    dst.sync_all().map_err(err("write the copy"))
}

/// How to save a copy: which audio channel (the LTC) to leave out, and whether to keep just the audio.
#[derive(Clone, Copy, Default)]
struct SaveOpts {
    drop: Option<usize>,
    audio_only: bool,
}

/// Write a copy of `source` to `part` with ffmpeg, without the `drop` channel: with `audio_only` just
/// the audio as 24-bit WAV, otherwise the picture copied untouched and the audio re-encoded.
fn save_with_ffmpeg(ffmpeg: &Path, source: &str, part: &Path, ext: &str, opts: SaveOpts, mut progress: impl FnMut(f64)) -> Result<(), String> {
    let info = probe_media(source.to_string())?;
    let channels = info["audio_channels"].as_u64().ok_or("This file has no audio")? as usize;
    let keep: Vec<usize> = (0..channels).filter(|c| Some(*c) != opts.drop).collect();
    let filter = keep_filter(&keep).ok_or("There's no audio left once the timecode channel is taken out")?;
    let filter = opts.drop.map(|_| ["-af".to_string(), filter]);
    let duration = info["duration"].as_f64().unwrap_or(0.0).max(1.0);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-y", "-i", source]);
    if opts.audio_only {
        cmd.args(["-vn", "-map", "0:a:0"]).args(filter.iter().flatten()).args(["-c:a", "pcm_s24le", "-f", "wav"]);
    } else {
        let mp4 = matches!(ext, "mp4" | "m4v");
        let format = match ext {
            "mp4" | "m4v" => "mp4",
            "mkv" => "matroska",
            "avi" => "avi",
            "mxf" => "mxf",
            _ => "mov",
        };
        cmd.args(["-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy"]).args(filter.iter().flatten());
        cmd.args(if mp4 { ["-c:a", "aac", "-b:a", "320k"].as_slice() } else { ["-c:a", "pcm_s24le"].as_slice() });
        cmd.args(["-f", format]);
    }
    let mut child = cmd.args(["-progress", "pipe:1"]).arg(part).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err("run ffmpeg"))?;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
                progress((us / 1e6 / duration).clamp(0.0, 0.99));
            }
        }
    }
    let output = child.wait_with_output().map_err(err("wait for ffmpeg"))?;
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg couldn't save the copy: {}", msg.lines().last().unwrap_or("unknown error")));
    }
    Ok(())
}

/// Save a copy of `source` at `dest`: copied as it is, or through ffmpeg (see save_with_ffmpeg) to
/// leave out the LTC channel or keep just the audio. The copy is written beside `dest` as a hidden
/// .part file first, so a save that fails never leaves half a file.
fn save_copy(source: &str, dest: &str, opts: SaveOpts, progress: impl FnMut(f64)) -> Result<(), String> {
    let (from, to) = (Path::new(source), PathBuf::from(dest));
    let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if !from.is_file() {
        return Err(format!("{} isn't on this Mac", name(from)));
    }
    if from.canonicalize().ok() == to.canonicalize().ok() {
        return Err("Choose somewhere else to save the copy".into());
    }
    let ext = to.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
    let part = to.with_file_name(format!(".{}.part", name(&to)));
    let result = if opts.drop.is_none() && !opts.audio_only {
        copy_with_progress(from, &part, progress)
    } else {
        ffmpeg_path().and_then(|ffmpeg| save_with_ffmpeg(&ffmpeg, source, &part, &ext, opts, progress))
    };
    match result.and_then(|_| fs::rename(&part, &to).map_err(err("save the copy"))) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Save a copy of a media file where the user chose (see save_copy). Emits `save-progress` events with `job` as the id.
#[tauri::command]
async fn media_save(app: AppHandle, job: String, source: String, dest: String, drop_channel: Option<usize>, audio_only: bool) -> Result<(), String> {
    let opts = SaveOpts { drop: drop_channel, audio_only };
    tauri::async_runtime::spawn_blocking(move || {
        save_copy(&source, &dest, opts, |fraction| {
            let _ = app.emit("save-progress", Progress { id: job.clone(), fraction });
        })
    })
    .await
    .map_err(err("save copy"))?
}

/// Save the frame at `time` seconds of a video into media/grabs/ as a JPEG. Returns the bundle-relative path.
#[tauri::command]
async fn frame_grab(bundle: String, source: String, time: f64, name: String) -> Result<String, String> {
    let ffmpeg = ffmpeg_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&bundle).join("media").join("grabs");
        fs::create_dir_all(&dir).map_err(err("create grabs folder"))?;
        let file = unique_name(Path::new(&bundle), "grabs", &safe_stem(&name), "jpg");
        let output = Command::new(ffmpeg)
            .args(["-v", "error", "-nostdin", "-y", "-ss", &format!("{time:.3}"), "-i", &source, "-frames:v", "1", "-q:v", "3"])
            .arg(dir.join(&file))
            .output()
            .map_err(err("run ffmpeg"))?;
        if !output.status.success() || !dir.join(&file).exists() {
            // Say why: ffmpeg's last line, or (no picture written) that the time is past the end of the video.
            let why = String::from_utf8_lossy(&output.stderr).lines().last().unwrap_or("").trim().to_string();
            let why = if why.is_empty() { format!("nothing at {time:.2}s") } else { why };
            return Err(format!("ffmpeg couldn't grab that frame ({why})"));
        }
        Ok(format!("media/grabs/{file}"))
    })
    .await
    .map_err(err("grab frame"))?
}

/// Crop an image into media/crops/ as a JPEG. `x`, `y`, `w`, `h` are fractions of the picture as
/// shown (ffmpeg applies the EXIF rotation first). Images ffmpeg can't crop directly (iPhone HEICs
/// are tiled, which ffmpeg won't filter simply) go through a JPEG copy made by sips, which keeps the
/// rotation flag. Returns the bundle-relative path.
#[tauri::command]
async fn image_crop(bundle: String, source: String, x: f64, y: f64, w: f64, h: f64, name: String) -> Result<String, String> {
    let ffmpeg = ffmpeg_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&bundle).join("media").join("crops");
        fs::create_dir_all(&dir).map_err(err("create crops folder"))?;
        let file = unique_name(Path::new(&bundle), "crops", &safe_stem(&name), "jpg");
        let crop = format!("crop=iw*{w:.5}:ih*{h:.5}:iw*{x:.5}:ih*{y:.5}");
        let run = |input: &Path| {
            Command::new(&ffmpeg)
                .args(["-v", "error", "-nostdin", "-y", "-i"])
                .arg(input)
                .args(["-vf", &crop, "-frames:v", "1", "-q:v", "2"])
                .arg(dir.join(&file))
                .output()
                .map(|o| o.status.success() && dir.join(&file).exists())
                .unwrap_or(false)
        };
        if run(Path::new(&source)) {
            return Ok(format!("media/crops/{file}"));
        }
        let tmp = std::env::temp_dir().join(format!("pmss-crop-{}.jpg", std::process::id()));
        let converted = Command::new("sips")
            .args(["-s", "format", "jpeg", "-s", "formatOptions", "95"])
            .arg(&source).arg("--out").arg(&tmp)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let ok = converted && run(&tmp);
        let _ = fs::remove_file(&tmp);
        if !ok {
            let _ = fs::remove_file(dir.join(&file));
            return Err("Couldn't crop that image".into());
        }
        Ok(format!("media/crops/{file}"))
    })
    .await
    .map_err(err("crop image"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(google::TokenCache::default())
        .setup(|app| {
            drive::init(app.handle());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // The pop-out player (src/popout.ts) closes with the main window, so the app quits as before.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                if let Some(player) = window.app_handle().get_webview_window("player") {
                    let _ = player.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bundle_create, bundle_open, bundle_save, media_import, side_read, side_write, list_folder, probe_media,
            ltc_scan, clip_cut, frame_grab, image_crop, media_save,
            tools::tools_status, tools::tools_install, tools::tools_install_cancel, shows::bundle_trash_files,
            thumbs::thumb_candidates, stream::media_server,
            google::google_client_configured, google::google_set_client, google::google_sign_in,
            google::google_current_user, google::google_sign_out, google::google_api, google::google_upload,
            drive::drive_cache_root, drive::drive_download, drive::drive_upload, drive::drive_fetch, drive::paths_exist, drive::drive_evict, drive::drive_forget,
            drive::drive_cached_shows, drive::drive_cache_size, drive::drive_open_cache, drive::drive_storage, drive::drive_set_cache_limit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("pmss-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn create_save_open_roundtrip() {
        let root = temp_dir("roundtrip").join("Show.showsheet");
        let path = root.to_string_lossy().to_string();
        bundle_create(path.clone(), json!({"name": "A"})).unwrap();
        assert!(root.join("media/renders").is_dir());
        bundle_save(path.clone(), json!({"name": "B"})).unwrap();
        assert_eq!(bundle_open(path.clone()).unwrap()["name"], "B");
        let bak: Value = serde_json::from_str(&fs::read_to_string(root.join("project.json.bak")).unwrap()).unwrap();
        assert_eq!(bak["name"], "A");
        assert!(bundle_create(path, json!({})).is_err(), "refuses a non-empty folder");
    }

    #[test]
    fn media_import_never_overwrites() {
        let base = temp_dir("media");
        let root = base.join("Show.showsheet");
        bundle_create(root.to_string_lossy().to_string(), json!({})).unwrap();
        let src = base.join("render.jpg");
        fs::write(&src, b"x").unwrap();
        let b = root.to_string_lossy().to_string();
        let s = src.to_string_lossy().to_string();
        assert_eq!(media_import(b.clone(), s.clone(), "renders".into()).unwrap(), "media/renders/render.jpg");
        assert_eq!(media_import(b.clone(), s.clone(), "renders".into()).unwrap(), "media/renders/render_2.jpg");
        assert!(media_import(b, s, "../etc".into()).is_err());
    }

    #[test]
    fn list_folder_filters_and_sorts() {
        let dir = temp_dir("list");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.JPG"), b"x").unwrap();
        fs::write(dir.join("a.png"), b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join(".hidden.jpg"), b"x").unwrap();
        let files = list_folder(dir.to_string_lossy().to_string(), vec!["jpg".into(), "png".into()]).unwrap();
        let mut names: Vec<_> = files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.png", "b.JPG"]);
    }

    #[test]
    fn side_files_are_whitelisted() {
        let root = temp_dir("side").join("S.showsheet");
        let b = root.to_string_lossy().to_string();
        bundle_create(b.clone(), json!({})).unwrap();
        assert_eq!(side_read(b.clone(), "inbox.json".into()).unwrap(), None);
        side_write(b.clone(), "inbox.json".into(), json!({"x": 1})).unwrap();
        assert_eq!(side_read(b.clone(), "inbox.json".into()).unwrap().unwrap()["x"], 1);
        assert!(side_write(b, "project.json".into(), json!({})).is_err());
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_stem("03 Be Quiet / Drive: Far"), "03 Be Quiet - Drive- Far");
        assert_eq!(safe_stem("..."), "clip");
        let bundle = temp_dir("names");
        fs::create_dir_all(bundle.join("media/clips")).unwrap();
        fs::write(bundle.join("media/clips/a.mp4"), b"x").unwrap();
        assert_eq!(unique_name(&bundle, "clips", "a", "mp4"), "a_2.mp4");
        assert_eq!(unique_name(&bundle, "clips", "b", "mp4"), "b.mp4");
        // Stills the show uses that aren't on this Mac (in Drive, or named in the show) are taken too.
        fs::write(bundle.join(PROJECT), r#"{"songs":{"s":{"gallery":["media/grabs/16 Song.jpg"]}}}"#).unwrap();
        fs::write(bundle.join(drive::MANIFEST), r#"{"files":{"media/grabs/16 Song_2.jpg":{"id":"x"}}}"#).unwrap();
        assert_eq!(unique_name(&bundle, "grabs", "16 Song", "jpg"), "16 Song_3.jpg");
        assert_eq!(unique_name(&bundle, "grabs", "17 Other", "jpg"), "17 Other.jpg");
    }

    #[test]
    fn clips_keep_the_ltc_on_one_side() {
        assert_eq!(clip_pan(1, 2), ("pan=stereo|c0=c0|c1=c1".to_string(), 'R'));
        assert_eq!(clip_pan(0, 2), ("pan=stereo|c0=c0|c1=c1".to_string(), 'L'));
        assert_eq!(clip_pan(2, 3), ("pan=stereo|c0=0.5000*c0+0.5000*c1|c1=c2".to_string(), 'R'));
        assert_eq!(clip_pan(0, 1), ("pan=stereo|c0=c0|c1=0*c0".to_string(), 'L'));
    }

    #[test]
    fn saved_copies_keep_every_channel_but_the_ltc() {
        assert_eq!(keep_filter(&[0]).as_deref(), Some("pan=mono|c0=c0"));
        assert_eq!(keep_filter(&[0, 1]).as_deref(), Some("pan=stereo|c0=c0|c1=c1"));
        assert_eq!(keep_filter(&[0, 1, 3]).as_deref(), Some("pan=3c|c0=c0|c1=c1|c2=c3"));
        assert_eq!(keep_filter(&[]), None);
    }

    #[test]
    fn saves_copies_with_and_without_ltc() {
        let base = temp_dir("save");
        fs::create_dir_all(&base).unwrap();
        let plain = base.join("still.jpg");
        fs::write(&plain, b"jpeg").unwrap();
        let copy = base.join("copy.jpg");
        save_copy(&plain.to_string_lossy(), &copy.to_string_lossy(), SaveOpts::default(), |_| {}).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"jpeg");
        assert!(save_copy(&plain.to_string_lossy(), &plain.to_string_lossy(), SaveOpts::default(), |_| {}).is_err(), "never onto itself");
        assert!(save_copy(&base.join("nope.wav").to_string_lossy(), &copy.to_string_lossy(), SaveOpts::default(), |_| {}).is_err());

        let Some(ffmpeg) = tool_path("ffmpeg").filter(|_| ffprobe_path().is_some()) else { return };
        let (wav, mov) = (base.join("ltc.wav"), base.join("ltc.mov"));
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "sine=frequency=2000:duration=2"])
            .args(["-filter_complex", "[0][1]amerge=inputs=2", "-c:a", "pcm_s24le"])
            .arg(&wav)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-i"])
            .arg(&wav)
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le"])
            .arg(&mov)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let channels = |p: &Path| probe_media(p.to_string_lossy().to_string()).unwrap()["audio_channels"].as_u64();

        let no_ltc_audio = SaveOpts { drop: Some(1), audio_only: true };
        let audio = base.join("audio only.wav");
        save_copy(&wav.to_string_lossy(), &audio.to_string_lossy(), no_ltc_audio, |_| {}).unwrap();
        assert_eq!(channels(&audio), Some(1), "the LTC channel is gone");

        let video = base.join("no ltc.mov");
        save_copy(&mov.to_string_lossy(), &video.to_string_lossy(), SaveOpts { drop: Some(1), ..Default::default() }, |_| {}).unwrap();
        let info = probe_media(video.to_string_lossy().to_string()).unwrap();
        assert_eq!((info["audio_channels"].as_u64(), info["width"].as_u64()), (Some(1), Some(320)));

        let from_video = base.join("from video.wav");
        save_copy(&mov.to_string_lossy(), &from_video.to_string_lossy(), no_ltc_audio, |_| {}).unwrap();
        assert_eq!(probe_media(from_video.to_string_lossy().to_string()).unwrap()["width"], Value::Null);

        assert!(fs::read_dir(&base).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }

    /// A clip's LTC goes through AAC, so check it still reads, using the same filter and encoder as clip_cut.
    #[test]
    fn clip_ltc_survives_the_encode_if_example_present() {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Exmaple Content/AUDIO FILES/LTC + AUDIO - AUTUMN 2026 90' V4.1_48_24.wav");
        let Some(ffmpeg) = tool_path("ffmpeg").filter(|_| file.exists()) else { return };
        let out = temp_dir("clip-ltc").with_extension("m4a");
        let (pan, side) = clip_pan(1, 2);
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-ss", "60", "-i"])
            .arg(&file)
            .args(["-t", "20", "-af", &pan, "-c:a", "aac", "-b:a", "256k", "-ac", "2"])
            .arg(&out)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let r = ltc::scan_file(&ffmpeg, &out.to_string_lossy(), 2, 20.0, None, |_| true).unwrap();
        assert_eq!((r.channel, side), (Some(1), 'R'));
        assert!(!r.blocks.is_empty(), "{r:?}");
    }

    #[test]
    fn cuts_a_clip_and_grabs_a_frame() {
        let Some(ffmpeg) = tool_path("ffmpeg") else { return };
        let base = temp_dir("clip");
        let bundle = base.join("S.showsheet");
        bundle_create(bundle.to_string_lossy().to_string(), json!({})).unwrap();
        let src = base.join("src.mp4");
        let ok = Command::new(ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440"])
            .args(["-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&src)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let b = bundle.to_string_lossy().to_string();
        let s = src.to_string_lossy().to_string();
        let rel = tauri::async_runtime::block_on(frame_grab(b.clone(), s.clone(), 1.5, "01 Song".into())).unwrap();
        assert_eq!(rel, "media/grabs/01 Song.jpg");
        assert!(bundle.join(&rel).metadata().unwrap().len() > 0);
    }

    #[test]
    fn leaves_the_cuts_out_of_a_clip() {
        assert_eq!(clip_parts(10.0, 100.0, &[(30.0, 50.0), (70.0, 80.0)]), vec![(10.0, 20.0), (50.0, 20.0), (80.0, 20.0)]);
        assert_eq!(clip_parts(10.0, 100.0, &[(0.0, 5.0), (95.0, 120.0)]), vec![(10.0, 90.0)]);
    }

    /// A clip with a pause cut out: as long as what's left, with GAP CUT drawn just after the jump, even with no TC card.
    #[test]
    fn cuts_a_pause_out_of_a_clip() {
        let Some(ffmpeg) = tool_path("ffmpeg") else { return };
        let base = temp_dir("gap");
        fs::create_dir_all(&base).unwrap();
        let src = base.join("src.mp4");
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440"])
            .args(["-t", "10", "-ac", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&src)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let blocks = vec![ltc::TcBlock { file_start: 0.0, file_end: 3.0, tc_start: "01:00:00:00".into(), tc_end: String::new() },
            ltc::TcBlock { file_start: 6.0, file_end: 10.0, tc_start: "01:00:03:00".into(), tc_end: String::new() }];
        let parts = clip_parts(1.0, 8.0, &[(3.0, 6.0)]);
        let Ok(clock) = burnin::Clock::new(burnin::BurnIn { fps: 25.0, blocks, song: None, number: None, tc: false }, parts.clone(), CLIP_HEIGHT) else { return };
        let clip = base.join("clip.mp4");
        let (pan, _) = clip_pan(1, 2);
        cut_with_ffmpeg(&ffmpeg, &src.to_string_lossy(), &parts, true, Some(&pan), Some(clock), &clip, |_| {}).unwrap();
        let info = probe_media(clip.to_string_lossy().to_string()).unwrap();
        assert!((info["duration"].as_f64().unwrap() - 4.0).abs() < 0.15, "{info}");
        assert_eq!(info["audio_channels"], 2);
        let corner = |t: &str| {
            let out = Command::new(&ffmpeg)
                .args(["-v", "error", "-ss", t, "-i"])
                .arg(&clip)
                .args(["-frames:v", "1", "-vf", "crop=480:150:iw-480:ih-150", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        let amber = |px: &[u8]| px.chunks(3).filter(|p| p[0] > 220 && p[1] > 150 && p[2] < 100).count();
        assert_eq!(amber(&corner("1.0")), 0, "GAP CUT before the jump");
        assert!(amber(&corner("2.5")) > 200, "no GAP CUT after the jump");
    }

    /// A clip with burned-in TC: the card sits in the bottom-right corner, its dot lit green once the TC block starts.
    #[test]
    fn burns_the_timecode_into_a_clip() {
        let Some(ffmpeg) = tool_path("ffmpeg") else { return };
        let base = temp_dir("burn");
        fs::create_dir_all(&base).unwrap();
        let src = base.join("src.mp4");
        let ok = Command::new(&ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "color=c=black:size=1920x1080:rate=24000/1001", "-f", "lavfi", "-i", "sine=frequency=440"])
            .args(["-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&src)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let block = ltc::TcBlock { file_start: 3.0, file_end: 6.0, tc_start: "09:01:42:19".into(), tc_end: "09:01:45:19".into() };
        let Ok(clock) = burnin::Clock::new(burnin::BurnIn { fps: 25.0, blocks: vec![block], song: Some("Good Lies".into()), number: Some("03".into()), tc: true }, vec![(1.0, 4.0)], CLIP_HEIGHT) else { return };
        let clip = base.join("clip.mp4");
        cut_with_ffmpeg(&ffmpeg, &src.to_string_lossy(), &[(1.0, 4.0)], true, None, Some(clock), &clip, |_| {}).unwrap();
        let corner = |t: &str| {
            let out = Command::new(&ffmpeg)
                .args(["-v", "error", "-ss", t, "-i"])
                .arg(&clip)
                .args(["-frames:v", "1", "-vf", "crop=480:150:iw-480:ih-150", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        let green = |px: &[u8]| px.chunks(3).filter(|p| p[1] > 150 && p[0] < 100 && p[2] < 100).count();
        let white = |px: &[u8]| px.chunks(3).filter(|p| p.iter().all(|&c| c > 200)).count();
        let before = corner("1.0");
        assert!(white(&before) > 50, "no card before the TC block");
        assert_eq!(green(&before), 0, "a lit dot before the TC block");
        let during = corner("3.0");
        assert!(green(&during) > 20 && white(&during) > white(&before) + 200, "no TC: {} green, {} white", green(&during), white(&during));
    }

    #[test]
    fn crops_a_tiled_heic() {
        let (Some(ffmpeg), Some(ffprobe)) = (tool_path("ffmpeg"), ffprobe_path()) else { return };
        let base = temp_dir("crop");
        let bundle = base.join("S.showsheet");
        bundle_create(bundle.to_string_lossy().to_string(), json!({})).unwrap();
        // Big enough that sips writes a tiled HEIC, like an iPhone's, which ffmpeg can't filter directly.
        let jpg = base.join("photo.jpg");
        let heic = base.join("photo.heic");
        assert!(Command::new(ffmpeg).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=4032x3024", "-frames:v", "1"]).arg(&jpg).status().unwrap().success());
        if !Command::new("sips").args(["-s", "format", "heic"]).arg(&jpg).arg("--out").arg(&heic).output().is_ok_and(|o| o.status.success()) {
            return; // no HEIC encoder here
        }
        let rel = tauri::async_runtime::block_on(image_crop(
            bundle.to_string_lossy().to_string(), heic.to_string_lossy().to_string(), 0.25, 0.1, 0.5, 0.375, "01 Song".into(),
        ))
        .unwrap();
        assert_eq!(rel, "media/crops/01 Song.jpg");
        let out = Command::new(ffprobe).args(["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0"]).arg(bundle.join(&rel)).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "2016,1134");
    }

    #[test]
    fn probe_reads_example_record_if_present() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Exmaple Content/SHOW RECORDS");
        let rec = fs::read_dir(&dir).ok().and_then(|mut d| {
            d.find_map(|e| e.ok().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "mp4")))
        });
        let Some(rec) = rec.filter(|_| ffprobe_path().is_some()) else {
            return; // example content isn't in the repo; this test only runs where it's present
        };
        let info = probe_media(rec.to_string_lossy().to_string()).unwrap();
        assert!(info["width"].as_u64().unwrap() > 0);
        assert!(info["duration"].as_f64().unwrap() > 0.0);
        assert!(info["audio_channels"].as_u64().is_some());
    }
}


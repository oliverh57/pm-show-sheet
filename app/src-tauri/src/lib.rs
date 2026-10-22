//! File access for show bundles. The bundle layout is described in DESIGN.md §6:
//!
//! ```text
//! MyShow.showsheet/
//!   project.json        show data (same shape the Google prototype publishes)
//!   project.json.bak    previous save
//!   media/{renders,grabs,clips,layout,inspo}/
//!   thumbs/  proxies/
//! ```
//! The frontend owns the schema; Rust only moves JSON and files around.

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const PROJECT: &str = "project.json";
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
    let ext = src.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut name = format!("{stem}{ext}");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{stem}_{n}{ext}");
        n += 1;
    }
    fs::copy(&src, dir.join(&name)).map_err(err("copy media"))?;
    Ok(format!("media/{kind}/{name}"))
}

/// Per-machine files kept beside project.json (render-cull decisions hold local paths, so they aren't show data).
const SIDE_FILES: [&str; 1] = ["inbox.json"];

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

/// Apps opened from Finder don't inherit the shell PATH, so look in the usual Homebrew places too.
fn ffprobe_path() -> Option<PathBuf> {
    ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths).map(|d| d.join("ffprobe")).find(|p| p.exists())
            })
        })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            bundle_create, bundle_open, bundle_save, media_import, side_read, side_write, list_folder, probe_media
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

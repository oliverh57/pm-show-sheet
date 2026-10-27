//! ffmpeg and ffprobe, which the app needs for file details, LTC, clips and saved copies. The setup guide
//! downloads static builds (signed and notarised, by Martin Riedl) into the app's own folder in Application
//! Support: no Homebrew, Terminal or password. The builds are pinned, and checked against their SHA-256.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

struct Build {
    name: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

const BASE: &str = "https://ffmpeg.martin-riedl.de/download/macos";

#[cfg(target_arch = "aarch64")]
const BUILDS: [Build; 2] = [
    Build { name: "ffmpeg", url: "arm64/1789931890_9.0.2/ffmpeg.zip", sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", size: 28_395_699 },
    Build { name: "ffprobe", url: "arm64/1789931890_9.0.2/ffprobe.zip", sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", size: 28_317_701 },
];

#[cfg(not(target_arch = "aarch64"))]
const BUILDS: [Build; 2] = [
    Build { name: "ffmpeg", url: "amd64/1789931006_9.0.2/ffmpeg.zip", sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4", size: 33_816_391 },
    Build { name: "ffprobe", url: "amd64/1789931006_9.0.2/ffprobe.zip", sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd", size: 33_719_233 },
];

/// Where the downloaded tools live. `tool_path` looks here first.
pub(crate) fn tools_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/com.pixelmappers.showsheet/bin"))
}

#[derive(Serialize)]
pub struct ToolsStatus {
    ffmpeg: bool,
    ffprobe: bool,
}

#[tauri::command]
pub fn tools_status() -> ToolsStatus {
    ToolsStatus { ffmpeg: crate::tool_path("ffmpeg").is_some(), ffprobe: crate::tool_path("ffprobe").is_some() }
}

/// Emitted as `tools-install-progress` while installing.
#[derive(Clone, Serialize)]
struct Progress {
    /// "download", then "install" (unpacking and checking that they run).
    phase: &'static str,
    received: u64,
    total: u64,
}

static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn tools_install_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Download, check and install ffmpeg and ffprobe, emitting `tools-install-progress` as it goes.
#[tauri::command]
pub async fn tools_install(app: AppHandle) -> Result<(), String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("ffmpeg is already being installed".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = install(&app).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let dir = tools_dir().ok_or("Couldn't find your home folder")?;
    let work = dir.join(".download");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| format!("Couldn't make the tools folder: {e}"))?;
    let result = fetch_all(app, &dir, &work).await;
    let _ = std::fs::remove_dir_all(&work);
    result
}

async fn fetch_all(app: &AppHandle, dir: &Path, work: &Path) -> Result<(), String> {
    let total: u64 = BUILDS.iter().map(|b| b.size).sum();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut last_emit = Instant::now();
    let emit = |phase, received| {
        let _ = app.emit("tools-install-progress", Progress { phase, received, total });
    };
    emit("download", 0);

    let mut zips = Vec::new();
    for build in &BUILDS {
        let mut resp = client
            .get(format!("{BASE}/{}", build.url))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Couldn't download {}. Check the internet connection and try again. ({e})", build.name))?;
        let mut hash = Sha256::new();
        let mut bytes = Vec::with_capacity(build.size as usize);
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The download of {} stopped. Check the internet connection and try again. ({e})", build.name))? {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            hash.update(&chunk);
            bytes.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = Instant::now();
                emit("download", received);
            }
        }
        if hex(&hash.finalize()) != build.sha256 {
            return Err(format!("The download of {} was damaged. Try again.", build.name));
        }
        let zip = work.join(format!("{}.zip", build.name));
        std::fs::write(&zip, bytes).map_err(|e| format!("Couldn't save {}: {e}", build.name))?;
        zips.push((build.name, zip));
    }
    emit("install", total);

    let dir = dir.to_path_buf();
    let work = work.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || unpack(&dir, &work, &zips)).await.map_err(|e| e.to_string())?
}

/// Unzip each tool, check it runs, then move it into `dir`.
fn unpack(dir: &Path, work: &Path, zips: &[(&str, PathBuf)]) -> Result<(), String> {
    for (name, zip) in zips {
        let out = work.join(name).with_extension("d");
        let ok = Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(zip).arg(&out).status().map(|s| s.success()).unwrap_or(false);
        let bin = out.join(name);
        if !ok || !bin.is_file() {
            return Err(format!("Couldn't unpack {name}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("Couldn't install {name}: {e}"))?;
        }
        let runs = Command::new(&bin).arg("-version").output().map(|o| o.status.success()).unwrap_or(false);
        if !runs {
            return Err(format!("{name} was downloaded but won't run on this Mac"));
        }
        std::fs::rename(&bin, dir.join(name)).map_err(|e| format!("Couldn't install {name}: {e}"))?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_are_pinned() {
        for b in &BUILDS {
            assert_eq!(b.sha256.len(), 64, "{}", b.name);
            assert!(b.url.ends_with(&format!("/{}.zip", b.name)));
        }
    }

    #[test]
    fn hex_is_lowercase_sha256() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}

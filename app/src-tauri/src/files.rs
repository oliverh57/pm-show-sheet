//! Cloud files on this Mac: whether a file in Google Drive (or Dropbox) is downloaded, and making it
//! online only (macOS "Remove Download") or downloading it again. These folders are macOS File
//! Provider folders under ~/Library/CloudStorage; an online-only file is "dataless" until it's opened.

use serde::Serialize;
use std::path::Path;

const CLOUD: &str = "/Library/CloudStorage/";
const DRIVE_ID_XATTR: &str = "com.google.drivefs.item-id#S";
const SF_DATALESS: u32 = 0x4000_0000;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileState {
    path: String,
    /// "local" (downloaded), "online" (online only), "uploading" (not in Drive yet, so it has to stay),
    /// "missing", or "na" (not in a cloud folder, so it's always on this Mac).
    state: &'static str,
}

fn has_xattr(path: &Path, name: &str) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(p), Ok(n)) = (CString::new(path.as_os_str().as_bytes()), CString::new(name)) else { return false };
    // SAFETY: both strings are NUL-terminated; a null buffer with size 0 only asks for the value's length.
    unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), std::ptr::null_mut(), 0, 0, 0) >= 0 }
}

fn state_of(path: &str) -> &'static str {
    use std::os::macos::fs::MetadataExt;
    let p = Path::new(path);
    let Ok(meta) = std::fs::symlink_metadata(p) else { return "missing" };
    if !path.contains(CLOUD) {
        return "na";
    }
    if meta.st_flags() & SF_DATALESS != 0 {
        return "online";
    }
    if path.contains("/GoogleDrive-") && !has_xattr(p, DRIVE_ID_XATTR) {
        return "uploading";
    }
    "local"
}

#[tauri::command]
pub fn file_states(paths: Vec<String>) -> Vec<FileState> {
    paths.into_iter().map(|path| FileState { state: state_of(&path), path }).collect()
}

#[cfg(target_os = "macos")]
fn evict(path: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager().evictUbiquitousItemAtURL_error(&url).map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(target_os = "macos"))]
fn evict(_path: &str) -> Result<(), String> {
    Err("Only on macOS".into())
}

/// Make files online only. Returns a note for each one that couldn't be (still uploading, or not in the cloud).
#[tauri::command]
pub async fn make_online_only(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .filter_map(|p| {
                let name = Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                match state_of(p) {
                    "online" => None,
                    "na" => Some(format!("{name} isn't in Google Drive")),
                    "missing" => Some(format!("{name} isn't there any more")),
                    "uploading" => Some(format!("{name} is still uploading")),
                    _ => evict(p).err().map(|e| format!("{name}: {e}")),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Make files online only if they haven't been opened or changed on this Mac for `days` days. Files that
/// can't be (still uploading, not in the cloud, already online only) are skipped quietly. Returns how many it did.
#[tauri::command]
pub async fn make_unused_online_only(paths: Vec<String>, days: u64) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 24 * 60 * 60);
        let unused = |p: &str| {
            let Ok(meta) = std::fs::metadata(p) else { return false };
            let last = [meta.accessed(), meta.modified()].into_iter().flatten().max();
            last.is_some_and(|t| t < cutoff)
        };
        paths.iter().filter(|p| state_of(p) == "local" && unused(p) && evict(p).is_ok()).count()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Download online-only files again by reading them through.
#[tauri::command]
pub async fn make_available(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for p in &paths {
            let mut f = std::fs::File::open(p).map_err(|e| format!("{p}: {e}"))?;
            std::io::copy(&mut f, &mut std::io::sink()).map_err(|e| format!("{p}: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_outside_the_cloud() {
        let dir = std::env::temp_dir().join("pm_file_states");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let s = file_states(vec![f.to_string_lossy().into(), dir.join("nope").to_string_lossy().into()]);
        assert_eq!(s.iter().map(|x| x.state).collect::<Vec<_>>(), vec!["na", "missing"]);
    }
}

//! Where shows live: a "Pixelmappers Show Sheets" folder in the user's Google Drive, synced by
//! Google Drive for desktop. Each show is a .showsheet bundle in that folder, so it's backed up to
//! Drive and opens on any Mac signed in to the same account.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const SHOWS_FOLDER: &str = "Pixelmappers Show Sheets";

/// "My Drive" inside a Google Drive for desktop mount. Its name is localised, so fall back to the
/// first folder that isn't one of Drive's special folders.
fn my_drive(mount: &Path) -> Option<PathBuf> {
    let direct = mount.join("My Drive");
    if direct.is_dir() {
        return Some(direct);
    }
    let skip = ["Shared drives", "Other computers", ".shortcut-targets-by-id", ".Trash", ".file-revisions-by-id"];
    fs::read_dir(mount).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
        p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| !n.starts_with('.') && !skip.contains(&n))
    })
}

/// The Google Drive for desktop folder for `email` (or the only/first account), if Drive is installed.
pub fn find_drive(cloud_storage: &Path, email: Option<&str>) -> Option<PathBuf> {
    let mut mounts: Vec<PathBuf> = fs::read_dir(cloud_storage)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("GoogleDrive-")))
        .collect();
    mounts.sort();
    let preferred = email.and_then(|e| {
        mounts.iter().find(|m| m.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(&format!("GoogleDrive-{e}"))))
    });
    preferred.or(mounts.first()).and_then(|m| my_drive(m))
}

/// The shows folder in Google Drive (it may not exist yet), or None if Drive for desktop isn't set up.
#[tauri::command]
pub fn drive_shows_folder(email: Option<String>) -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let drive = find_drive(&home.join("Library/CloudStorage"), email.as_deref())
        .or_else(|| Some(PathBuf::from("/Volumes/GoogleDrive/My Drive")).filter(|p| p.is_dir()))?;
    Some(drive.join(SHOWS_FOLDER).to_string_lossy().to_string())
}

#[derive(Serialize)]
pub struct DriveStatus {
    /// The Google Drive app is in Applications.
    installed: bool,
    /// Accounts Drive for desktop is signed in to (from its GoogleDrive-<email> folders). The old
    /// /Volumes/GoogleDrive mount counts as an account with no email.
    accounts: Vec<String>,
}

/// Whether Google Drive for desktop is installed and signed in, for the setup guide shown at launch.
#[tauri::command]
pub fn drive_status() -> DriveStatus {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let installed = [PathBuf::from("/Applications/Google Drive.app"), home.join("Applications/Google Drive.app")].iter().any(|p| p.is_dir());
    let mut accounts = drive_accounts(&home.join("Library/CloudStorage"));
    if Path::new("/Volumes/GoogleDrive").is_dir() {
        accounts.push(String::new());
    }
    DriveStatus { installed, accounts }
}

fn drive_accounts(cloud_storage: &Path) -> Vec<String> {
    let mut accounts: Vec<String> = fs::read_dir(cloud_storage)
        .map(|dir| dir.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_prefix("GoogleDrive-")).map(String::from)).collect())
        .unwrap_or_default();
    accounts.sort();
    accounts
}

/// Open the Google Drive app (it signs in and mounts Drive from its own window).
#[tauri::command]
pub fn drive_open_app() -> Result<(), String> {
    let ok = std::process::Command::new("open").args(["-a", "Google Drive"]).status().map_err(|e| format!("Couldn't open Google Drive: {e}"))?.success();
    if ok { Ok(()) } else { Err("Couldn't open Google Drive. Is it installed?".into()) }
}

#[tauri::command]
pub fn ensure_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("create folder: {e}"))
}

#[derive(Serialize, Debug, Clone)]
pub struct ShowSummary {
    path: String,
    name: String,
    venue: Option<String>,
    date: Option<String>,
    songs: usize,
    cover: Option<String>, // absolute path to the show's main image, else the first song's hero render
    modified_ms: u64,
}

fn summary(bundle: &Path) -> Option<ShowSummary> {
    let file = bundle.join("project.json");
    let project: Value = serde_json::from_str(&fs::read_to_string(&file).ok()?).ok()?;
    let order: Vec<&str> = project["set_order"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    // The picked main image while its file is still there (deleting it from its song bins it), else the first hero
    let picked = project["cover"].as_str().filter(|rel| bundle.join(rel).is_file());
    let cover = picked
        .or_else(|| order.iter().find_map(|id| project["songs"][*id]["hero"].as_str()))
        .map(|rel| bundle.join(rel).to_string_lossy().to_string());
    let modified_ms = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let text = |k: &str| project[k].as_str().filter(|s| !s.is_empty()).map(String::from);
    Some(ShowSummary {
        path: bundle.to_string_lossy().to_string(),
        name: text("name").unwrap_or_else(|| bundle.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()),
        venue: text("venue"),
        date: text("date"),
        songs: order.len(),
        cover,
        modified_ms,
    })
}

/// Every show bundle in `folder`, most recently saved first. An empty list if the folder doesn't exist.
#[tauri::command]
pub fn shows_list(folder: String) -> Result<Vec<ShowSummary>, String> {
    let Ok(entries) = fs::read_dir(&folder) else { return Ok(vec![]) };
    let mut out: Vec<ShowSummary> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.extension().is_some_and(|x| x == "showsheet"))
        .filter_map(|p| summary(&p))
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// The deck's images folder in a show bundle (IMAGES_FOLDER in google/sync.ts).
const SLIDES_IMAGES: &str = "Slides images";

/// What Drive keeps rather than the bundle: Google Sheets, Slides and Docs (on disk, pointer files whose copies are new
/// documents) and the deck's images folder. A show moved by copying leaves them for the Google sync, which moves them
/// into the show's new folder in Drive and bins the old one.
fn drive_owned(path: &Path, top: bool) -> bool {
    let google = ["gsheet", "gslides", "gdoc", "gform", "gdraw", "gmap", "gsite", "gjam", "gtable", "gscript"];
    (top && path.file_name().is_some_and(|n| n == SLIDES_IMAGES)) || path.extension().and_then(|e| e.to_str()).is_some_and(|e| google.contains(&e))
}

fn copy_dir(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let (entry, path) = { let e = entry?; let p = e.path(); (e, p) };
        if drive_owned(&path, top) || entry.file_name() == ".DS_Store" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() { copy_dir(&path, &target, false)?; } else { fs::copy(&path, target)?; }
    }
    Ok(())
}

/// Remove what `copy_dir` copied, leaving what Drive keeps (and the folders they're in).
fn remove_copied(dir: &Path, top: bool) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let (entry, path) = { let e = entry?; let p = e.path(); (e, p) };
        if drive_owned(&path, top) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            remove_copied(&path, false)?;
            let _ = fs::remove_dir(&path); // not empty if it holds a Google file
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Move a bundle by copying (across drives, say My Drive to a shared drive), leaving its Google files behind.
fn copy_move(from: &Path, to: &Path) -> Result<(), String> {
    copy_dir(from, to, true).map_err(|e| { let _ = fs::remove_dir_all(to); format!("copy show: {e}") })?;
    if !to.join("project.json").exists() {
        let _ = fs::remove_dir_all(to);
        return Err("The copy didn't finish; the show was left where it was".into());
    }
    remove_copied(from, true).map_err(|e| format!("Copied, but couldn't remove the original: {e}"))?;
    let _ = fs::remove_dir(from); // still there if it has a Sheet or deck: the Google sync moves them, then bins it
    Ok(())
}

/// Which Google Drive a path is in: an account's My Drive, or one shared drive. None outside Google Drive.
fn drive_of(path: &Path) -> Option<PathBuf> {
    let parts: Vec<_> = path.components().collect();
    let mount = parts.iter().position(|c| c.as_os_str().to_str().is_some_and(|n| n.starts_with("GoogleDrive-")))?;
    let end = if parts.get(mount + 1)?.as_os_str() == "Shared drives" { mount + 3 } else { mount + 2 };
    (parts.len() >= end).then(|| parts[..end].iter().collect())
}

/// Move a show bundle into `folder` (e.g. another Drive folder or a shared drive). Returns its new path.
/// Renames within a drive. Between drives it copies, checks, then removes the original (see `copy_move`): Drive for
/// desktop takes the rename, but undoes it a moment later if Drive won't move the folder (into a shared drive, say).
#[tauri::command]
pub fn bundle_move(path: String, folder: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let name = from.file_name().ok_or("That isn't a show bundle")?;
    let to = PathBuf::from(&folder).join(name);
    if to == from {
        return Ok(path);
    }
    if to.starts_with(&from) {
        return Err("Can't move a show inside itself".into());
    }
    // A folder with no project.json is left from a move Drive undid: the copy goes into it.
    if to.join("project.json").exists() {
        return Err(format!("There's already a show called {} in that folder", name.to_string_lossy()));
    }
    fs::create_dir_all(&folder).map_err(|e| format!("create folder: {e}"))?;
    if to.exists() || drive_of(&from) != drive_of(&to) || fs::rename(&from, &to).is_err() {
        copy_move(&from, &to)?;
    }
    Ok(to.to_string_lossy().to_string())
}

/// Rename a show bundle to `<stem>.showsheet` in the same folder (Drive for desktop renames the Drive folder
/// to match). Adds " 2", " 3"… if another show has that name. Returns its new path.
#[tauri::command]
pub fn bundle_rename(path: String, stem: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    if !from.extension().is_some_and(|e| e == "showsheet") || !from.join("project.json").is_file() {
        return Err("That isn't a show".into());
    }
    let stem = stem.trim();
    if stem.is_empty() || stem.contains(['/', ':']) || stem.starts_with('.') {
        return Err("That name can't be used for a folder".into());
    }
    let parent = from.parent().ok_or("That isn't a show")?;
    let same = |p: &Path| fs::canonicalize(p).ok() == fs::canonicalize(&from).ok();
    let mut to = parent.join(format!("{stem}.showsheet"));
    let mut n = 2;
    // macOS folders ignore case, so "Show" → "SHOW" finds itself: that's a rename, not a clash.
    while to.exists() && !same(&to) {
        to = parent.join(format!("{stem} {n}.showsheet"));
        n += 1;
    }
    if to.as_os_str() == from.as_os_str() {
        return Ok(path);
    }
    fs::rename(&from, &to).map_err(|e| format!("Couldn't rename the show's folder: {e}"))?;
    Ok(to.to_string_lossy().to_string())
}

// --- finding shows anywhere in Google Drive ------------------------------------------

/// The top of each Google Drive for desktop account: just the signed-in account if it's there.
fn drive_mounts(cloud_storage: &Path, email: Option<&str>) -> Vec<PathBuf> {
    let mut mounts: Vec<PathBuf> = fs::read_dir(cloud_storage)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    mounts.retain(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("GoogleDrive-")));
    mounts.sort();
    if let Some(e) = email {
        let mine: Vec<PathBuf> = mounts.iter().filter(|m| m.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(&format!("GoogleDrive-{e}")))).cloned().collect();
        if !mine.is_empty() {
            return mine;
        }
    }
    mounts
}

/// Where to look: My Drive and every shared drive of each account.
pub fn drive_roots(cloud_storage: &Path, email: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for m in drive_mounts(cloud_storage, email) {
        if let Some(md) = my_drive(&m) {
            roots.push(md);
        }
        if let Ok(shared) = fs::read_dir(m.join("Shared drives")) {
            let mut drives: Vec<PathBuf> = shared.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
            drives.sort();
            roots.extend(drives);
        }
    }
    roots
}

const SCAN_DEPTH: usize = 6;
const SCAN_FOLDERS: usize = 4000; // stop looking after this many folders, so a huge drive can't hang the app

/// Every .showsheet bundle under `root`, up to SCAN_DEPTH folders down. Bundles aren't looked inside.
#[cfg(test)]
pub fn find_bundles(root: &Path, out: &mut Vec<PathBuf>, budget: &mut usize) {
    find_bundles_each(root, SCAN_DEPTH, budget, &mut |p| out.push(p));
}

fn find_bundles_each(root: &Path, max_depth: usize, budget: &mut usize, found: &mut dyn FnMut(PathBuf)) {
    let mut queue = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = queue.pop() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if name.ends_with(".showsheet") {
                found(path);
            } else if depth + 1 < max_depth {
                queue.push((path, depth + 1));
            }
        }
    }
}

/// Every show in the signed-in user's Google Drive (My Drive and shared drives), newest first.
/// Folders where shows were found before (`hints`) are checked first. Drive for desktop fetches folder
/// listings over the network, so a full scan can take a minute: each show is also sent as a
/// `show-found` event as soon as it's found.
#[tauri::command]
pub async fn shows_scan(app: tauri::AppHandle, email: Option<String>, hints: Vec<String>) -> Vec<ShowSummary> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return vec![] };
        let mut roots = drive_roots(&home.join("Library/CloudStorage"), email.as_deref());
        let legacy = PathBuf::from("/Volumes/GoogleDrive");
        if roots.is_empty() && legacy.is_dir() {
            roots.push(legacy);
        }
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let mut found = |p: PathBuf| {
            if seen.insert(p.clone()) {
                if let Some(s) = summary(&p) {
                    let _ = app.emit("show-found", &s);
                    out.push(s);
                }
            }
        };
        let mut budget = SCAN_FOLDERS;
        for h in hints.iter().filter(|h| roots.iter().any(|r| Path::new(h).starts_with(r))) {
            find_bundles_each(Path::new(h), 1, &mut budget, &mut found);
        }
        for r in &roots {
            find_bundles_each(r, SCAN_DEPTH, &mut budget, &mut found);
        }
        out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        out
    })
    .await
    .unwrap_or_default()
}

/// The Google Drive item id of a file or folder synced by Drive for desktop (for an "Open in Drive" link).
#[tauri::command]
pub fn drive_item_id(path: String) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/xattr").args(["-p", "com.google.drivefs.item-id#S", &path]).output().ok()?;
    let id = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !id.is_empty()).then_some(id)
}

// --- who has a show open ------------------------------------------------------------
// Each open app writes presence/<email>.json inside the bundle every 30 seconds; Drive syncs it to the
// others. Anyone whose file is fresher than PRESENCE_FRESH_MS has the show open.

const PRESENCE_DIR: &str = "presence";
const PRESENCE_FRESH_MS: u64 = 3 * 60 * 1000;

#[derive(Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub struct Presence {
    email: String,
    name: String,
    at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn presence_file(bundle: &str, email: &str) -> PathBuf {
    let safe: String = email.chars().map(|c| if c.is_ascii_alphanumeric() || "@._-".contains(c) { c } else { '_' }).collect();
    PathBuf::from(bundle).join(PRESENCE_DIR).join(format!("{safe}.json"))
}

/// Say "I have this show open", and return everyone else who does.
#[tauri::command]
pub fn presence_beat(bundle: String, email: String, name: String) -> Vec<Presence> {
    let file = presence_file(&bundle, &email);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let me = Presence { email: email.clone(), name, at: now_ms() };
    if let Ok(bytes) = serde_json::to_vec(&me) {
        let _ = fs::write(&file, bytes);
    }
    presence_others(&bundle, &email, now_ms())
}

pub fn presence_others(bundle: &str, email: &str, now: u64) -> Vec<Presence> {
    let Ok(entries) = fs::read_dir(PathBuf::from(bundle).join(PRESENCE_DIR)) else { return vec![] };
    let mut out: Vec<Presence> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| serde_json::from_str::<Presence>(&fs::read_to_string(e.path()).ok()?).ok())
        .filter(|p| !p.email.eq_ignore_ascii_case(email) && now.saturating_sub(p.at) < PRESENCE_FRESH_MS)
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Closing the show: remove my presence file.
#[tauri::command]
pub fn presence_leave(bundle: String, email: String) {
    let _ = fs::remove_file(presence_file(&bundle, &email));
}

/// Delete a show: move its whole bundle (project, renders, clips, stills) to the Trash. In Google Drive
/// that also puts it in Drive's bin, where it can be restored for 30 days. Linked source files aren't touched.
#[tauri::command]
pub fn bundle_trash(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.extension().is_some_and(|e| e == "showsheet") || !p.join("project.json").is_file() {
        return Err("That isn't a show".into());
    }
    trash::delete(&p).map_err(|e| format!("Couldn't move the show to the Trash: {e}"))
}

/// Move files the app made inside a show (under its media/ folder) to the Trash. Paths are bundle-relative;
/// anything outside media/ is refused. Files that are already gone are skipped.
#[tauri::command]
pub fn bundle_trash_files(bundle: String, paths: Vec<String>) -> Result<(), String> {
    let root = PathBuf::from(&bundle);
    if !root.join("project.json").is_file() {
        return Err("That isn't a show".into());
    }
    let mut files = Vec::new();
    for rel in &paths {
        let p = Path::new(rel);
        if !rel.starts_with("media/") || p.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(format!("{rel} isn't in the show's media folder"));
        }
        let full = root.join(p);
        if full.exists() {
            files.push(full);
        }
    }
    if files.is_empty() {
        return Ok(());
    }
    trash::delete_all(&files).map_err(|e| format!("Couldn't move the files to the Trash: {e}"))
}

/// Short summaries of specific bundles (recently opened shows outside the Drive folder).
#[tauri::command]
pub fn shows_summaries(paths: Vec<String>) -> Vec<ShowSummary> {
    paths.iter().filter_map(|p| summary(Path::new(p))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("pmss-shows-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn lists_drive_accounts_from_cloud_storage() {
        let cs = temp("accounts");
        assert!(drive_accounts(&cs.join("missing")).is_empty());
        fs::create_dir_all(cs.join("GoogleDrive-zoe@pm.com")).unwrap();
        fs::create_dir_all(cs.join("GoogleDrive-me@pm.com")).unwrap();
        fs::create_dir_all(cs.join("Dropbox")).unwrap();
        assert_eq!(drive_accounts(&cs), vec!["me@pm.com", "zoe@pm.com"]);
    }

    #[test]
    fn tells_my_drive_and_each_shared_drive_apart() {
        let m = PathBuf::from("/Users/me/Library/CloudStorage/GoogleDrive-me@pm.com");
        let mine = drive_of(&m.join("My Drive/Tests/A.showsheet"));
        assert_eq!(mine, Some(m.join("My Drive")));
        assert_eq!(drive_of(&m.join("Shared drives/PM/Overmono/A.showsheet")), Some(m.join("Shared drives/PM")));
        assert_ne!(drive_of(&m.join("Shared drives/PM/A.showsheet")), drive_of(&m.join("Shared drives/Other/A.showsheet")));
        assert_eq!(drive_of(Path::new("/Users/me/Desktop/A.showsheet")), None);
    }

    #[test]
    fn moves_between_drives_by_copying_even_over_a_leftover() {
        let m = temp("cross").join("GoogleDrive-me@pm.com");
        let from = m.join("My Drive/Tests/A.showsheet");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("project.json"), "{}").unwrap();
        fs::write(from.join("A | SHOW SHEET.gsheet"), "{}").unwrap();
        let dest = m.join("Shared drives/PM/Overmono");
        fs::create_dir_all(dest.join("A.showsheet/presence")).unwrap(); // left by a move Drive undid
        let moved = bundle_move(from.to_string_lossy().to_string(), dest.to_string_lossy().to_string()).unwrap();
        assert!(PathBuf::from(&moved).join("project.json").is_file());
        assert!(from.join("A | SHOW SHEET.gsheet").is_file(), "copied, not renamed: the Sheet waits for the sync");
    }

    #[test]
    fn moving_by_copy_leaves_google_files_for_the_sync() {
        let root = temp("copy-move");
        let from = root.join("A.showsheet");
        fs::create_dir_all(from.join("media/grabs")).unwrap();
        fs::create_dir_all(from.join(SLIDES_IMAGES)).unwrap();
        fs::write(from.join("project.json"), "{}").unwrap();
        fs::write(from.join("media/grabs/01.jpg"), "jpg").unwrap();
        fs::write(from.join("A | SHOW SHEET.gsheet"), "{}").unwrap();
        fs::write(from.join(SLIDES_IMAGES).join("r.jpg"), "jpg").unwrap();
        let to = root.join("shared/A.showsheet");
        copy_move(&from, &to).unwrap();
        assert!(to.join("project.json").is_file() && to.join("media/grabs/01.jpg").is_file());
        assert!(!to.join("A | SHOW SHEET.gsheet").exists(), "a copied pointer would be a new Sheet");
        assert!(!to.join(SLIDES_IMAGES).exists());
        assert!(from.join("A | SHOW SHEET.gsheet").is_file(), "the Sheet stays for the sync to move");
        assert!(from.join(SLIDES_IMAGES).join("r.jpg").is_file());
        assert!(!from.join("project.json").exists() && !from.join("media").exists());

        // A bundle with no Google files goes completely.
        let plain = root.join("B.showsheet");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("project.json"), "{}").unwrap();
        copy_move(&plain, &root.join("shared/B.showsheet")).unwrap();
        assert!(!plain.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn renames_a_show_and_avoids_clashes() {
        let dir = temp("rename");
        let make = |name: &str| {
            let p = dir.join(name);
            fs::create_dir_all(&p).unwrap();
            fs::write(p.join("project.json"), "{}").unwrap();
            p.to_string_lossy().to_string()
        };
        let a = make("OLD.showsheet");
        make("TAKEN.showsheet");
        let renamed = bundle_rename(a, "NEW".into()).unwrap();
        assert!(renamed.ends_with("/NEW.showsheet") && Path::new(&renamed).join("project.json").exists());
        assert!(bundle_rename(renamed.clone(), "TAKEN".into()).unwrap().ends_with("/TAKEN 2.showsheet"));
        assert!(bundle_rename(dir.join("TAKEN.showsheet").to_string_lossy().into(), "a/b".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_my_drive_for_the_signed_in_account() {
        let cs = temp("cloud");
        fs::create_dir_all(cs.join("GoogleDrive-a@x.com/My Drive")).unwrap();
        fs::create_dir_all(cs.join("GoogleDrive-b@x.com/Meine Ablage")).unwrap();
        assert_eq!(find_drive(&cs, Some("B@x.com")).unwrap(), cs.join("GoogleDrive-b@x.com/Meine Ablage"));
        assert_eq!(find_drive(&cs, Some("c@x.com")).unwrap(), cs.join("GoogleDrive-a@x.com/My Drive"));
        assert!(find_drive(&temp("empty"), None).is_none());
    }

    #[test]
    fn moves_a_bundle_and_refuses_clashes() {
        let base = temp("move");
        let show = base.join("A.showsheet");
        fs::create_dir_all(show.join("media/renders")).unwrap();
        fs::write(show.join("project.json"), "{}").unwrap();
        fs::write(show.join("media/renders/x.jpg"), "x").unwrap();
        let dest = base.join("Shared drives/Team");
        let moved = bundle_move(show.to_string_lossy().to_string(), dest.to_string_lossy().to_string()).unwrap();
        assert_eq!(PathBuf::from(&moved), dest.join("A.showsheet"));
        assert!(dest.join("A.showsheet/media/renders/x.jpg").exists() && !show.exists());
        fs::create_dir_all(&show).unwrap();
        fs::write(show.join("project.json"), "{}").unwrap();
        assert!(bundle_move(show.to_string_lossy().to_string(), dest.to_string_lossy().to_string()).is_err(), "name taken");
        assert!(bundle_move(moved.clone(), PathBuf::from(&moved).join("inner").to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn scans_my_drive_and_shared_drives_for_shows() {
        let cs = temp("scan");
        let mine = cs.join("GoogleDrive-me@pm.com");
        fs::create_dir_all(mine.join("My Drive/Old/A.showsheet/media")).unwrap();
        fs::create_dir_all(mine.join("Shared drives/Pixelmappers/Show Sheets/2026/B.showsheet")).unwrap();
        fs::create_dir_all(mine.join("Shared drives/Pixelmappers/Show Sheets/2026/B.showsheet/inner.showsheet")).unwrap();
        fs::create_dir_all(mine.join("Shared drives/Pixelmappers/.hidden/C.showsheet")).unwrap();
        fs::create_dir_all(cs.join("GoogleDrive-other@x.com/My Drive/D.showsheet")).unwrap();
        let roots = drive_roots(&cs, Some("ME@pm.com"));
        assert_eq!(roots, vec![mine.join("My Drive"), mine.join("Shared drives/Pixelmappers")]);
        let mut found = Vec::new();
        let mut budget = 100;
        for r in &roots { find_bundles(r, &mut found, &mut budget); }
        found.sort();
        assert_eq!(found, vec![mine.join("My Drive/Old/A.showsheet"), mine.join("Shared drives/Pixelmappers/Show Sheets/2026/B.showsheet")]);
    }

    #[test]
    fn presence_shows_others_with_fresh_files() {
        let b = temp("presence").join("S.showsheet");
        fs::create_dir_all(&b).unwrap();
        let bundle = b.to_string_lossy().to_string();
        assert!(presence_beat(bundle.clone(), "me@pm.com".into(), "Me".into()).is_empty());
        presence_beat(bundle.clone(), "sam@pm.com".into(), "Sam".into());
        let now = now_ms();
        assert_eq!(presence_others(&bundle, "ME@pm.com", now).iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Sam"]);
        assert!(presence_others(&bundle, "me@pm.com", now + PRESENCE_FRESH_MS + 1).is_empty(), "stale");
        presence_leave(bundle.clone(), "sam@pm.com".into());
        assert!(presence_others(&bundle, "me@pm.com", now).is_empty());
    }

    #[test]
    fn only_trashes_show_bundles() {
        let dir = temp("trash");
        fs::create_dir_all(dir.join("Notes")).unwrap();
        assert!(bundle_trash(dir.join("Notes").to_string_lossy().to_string()).is_err());
        assert!(bundle_trash(dir.join("Missing.showsheet").to_string_lossy().to_string()).is_err());
        assert!(dir.join("Notes").exists());
    }

    #[test]
    fn lists_show_bundles_newest_first() {
        let dir = temp("list");
        for (name, songs) in [("A.showsheet", 2), ("B.showsheet", 1)] {
            let b = dir.join(name);
            fs::create_dir_all(&b).unwrap();
            let order: Vec<String> = (0..songs).map(|i| format!("s{i}")).collect();
            let project = json!({"name": name, "venue": "Hall", "set_order": order, "songs": {"s0": {"hero": "media/renders/x.jpg"}}});
            fs::write(b.join("project.json"), project.to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        fs::create_dir_all(dir.join("not a show")).unwrap();
        let list = shows_list(dir.to_string_lossy().to_string()).unwrap();
        assert_eq!(list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["B.showsheet", "A.showsheet"]);
        assert_eq!(list[1].songs, 2);
        assert!(list[1].cover.as_deref().unwrap().ends_with("A.showsheet/media/renders/x.jpg"));
        // A picked main image wins while its file is there
        let a = dir.join("A.showsheet");
        let project = json!({"name": "A", "set_order": ["s0"], "songs": {"s0": {"hero": "media/renders/x.jpg"}}, "cover": "media/grabs/y.jpg"});
        fs::write(a.join("project.json"), project.to_string()).unwrap();
        assert!(summary(&a).unwrap().cover.unwrap().ends_with("media/renders/x.jpg"));
        fs::create_dir_all(a.join("media/grabs")).unwrap();
        fs::write(a.join("media/grabs/y.jpg"), b"").unwrap();
        assert!(summary(&a).unwrap().cover.unwrap().ends_with("media/grabs/y.jpg"));
        assert!(shows_list(dir.join("missing").to_string_lossy().to_string()).unwrap().is_empty());
    }
}

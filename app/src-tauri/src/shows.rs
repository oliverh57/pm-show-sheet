//! Files in a show's copy on this Mac. Shows live in Google Drive and the app reaches them through the Drive API
//! (src/drive/ and drive.rs); this moves media the app made to the Trash when it's no longer used.

use std::path::{Path, PathBuf};

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn only_trashes_media_inside_a_show() {
        let show = std::env::temp_dir().join(format!("pmss-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&show);
        fs::create_dir_all(&show).unwrap();
        assert!(bundle_trash_files(show.display().to_string(), vec![]).is_err()); // no project.json
        fs::write(show.join("project.json"), "{}").unwrap();
        assert!(bundle_trash_files(show.display().to_string(), vec!["project.json".into()]).is_err());
        assert!(bundle_trash_files(show.display().to_string(), vec!["media/../project.json".into()]).is_err());
        assert!(bundle_trash_files(show.display().to_string(), vec!["media/gone.jpg".into()]).is_ok());
        let _ = fs::remove_dir_all(&show);
    }
}

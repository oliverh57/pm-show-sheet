//! Shows in Google Drive through the Drive API, without Google Drive for desktop. Each show is copied to a folder in
//! the app's data folder (shows/<Drive folder id>/, laid out as in Drive), which the frontend keeps in step with Drive
//! (src/drive/). This side downloads and uploads files, and fetches a show's media when the player or an image asks
//! for a file that isn't on this Mac yet (stream.rs calls `fetch_blocking`).
//!
//! `.drive.json` in each show's folder is the frontend's manifest: the show's Drive folder id and each file's Drive id.
//! This side only reads it.

use crate::google::{access_token, api_error, forget_token, mime_for, multipart_body};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

const FILES: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
const RETURN: &str = "fields=id,name,headRevisionId,md5Checksum,size,modifiedTime&supportsAllDrives=true";
pub const MANIFEST: &str = ".drive.json";
/// Files up to this size go up in one request; bigger ones (clips) in resumable chunks.
const SIMPLE_MAX: u64 = 5 * 1024 * 1024;
const CHUNK: usize = 8 * 1024 * 1024; // a multiple of 256 KB, as Drive asks
const FETCH_WAIT: Duration = Duration::from_secs(300);

static APP: OnceLock<AppHandle> = OnceLock::new();
static DOWNLOADS: Semaphore = Semaphore::const_new(6);
static FETCHING: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn err<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Where shows are copied to on this Mac.
pub fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("shows"))
}

#[tauri::command]
pub fn drive_cache_root(app: AppHandle) -> Result<String, String> {
    let root = cache_root(&app).ok_or("no app data folder")?;
    fs::create_dir_all(&root).map_err(err("create the shows folder"))?;
    Ok(root.to_string_lossy().to_string())
}

/// Drive ids are letters, digits, `-` and `_`.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A path inside a show's copy, with no `..`, so nothing outside the shows folder is written.
fn in_cache(app: &AppHandle, path: &Path) -> bool {
    cache_root(app).is_some_and(|root| path.starts_with(&root) && path != root) && !path.components().any(|c| matches!(c, std::path::Component::ParentDir))
}

/// GET a Drive API URL as JSON, signing in again once on a 401.
async fn get_json(app: &AppHandle, url: &str) -> Result<Value, String> {
    for attempt in 0..2 {
        let token = access_token(app).await?;
        let res = reqwest::Client::new().get(url).bearer_auth(token).send().await.map_err(err("reach Google Drive"))?;
        let status = res.status();
        let text = res.text().await.map_err(err("read Drive's reply"))?;
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            forget_token(app);
            continue;
        }
        if !status.is_success() {
            return Err(api_error(status, &text));
        }
        return serde_json::from_str(&text).map_err(err("read Drive's reply"));
    }
    unreachable!()
}

/// Download a Drive file to `dest` (through a .part file, so a half-downloaded file is never mistaken for the file).
/// `revision`: an earlier version of the file instead of the current one.
async fn download_to(app: &AppHandle, file_id: &str, revision: Option<&str>, dest: &Path) -> Result<u64, String> {
    if !valid_id(file_id) || revision.is_some_and(|r| !valid_id(r)) {
        return Err(format!("not a Drive file id: {file_id}"));
    }
    let _slot = DOWNLOADS.acquire().await.map_err(err("download"))?;
    let url = match revision {
        Some(rev) => format!("{FILES}/{file_id}/revisions/{rev}?alt=media&supportsAllDrives=true"),
        None => format!("{FILES}/{file_id}?alt=media&supportsAllDrives=true"),
    };
    let mut res = None;
    for attempt in 0..2 {
        let token = access_token(app).await?;
        let r = reqwest::Client::new().get(&url).bearer_auth(token).send().await.map_err(err("reach Google Drive"))?;
        if r.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            forget_token(app);
            continue;
        }
        if !r.status().is_success() {
            let status = r.status();
            return Err(api_error(status, &r.text().await.unwrap_or_default()));
        }
        res = Some(r);
        break;
    }
    let mut res = res.ok_or("Google sign-in has expired")?;
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(err("create folder"))?;
    }
    let part = dest.with_file_name(format!("{}.part", dest.file_name().and_then(|n| n.to_str()).unwrap_or("download")));
    let mut file = fs::File::create(&part).map_err(err("write download"))?;
    let mut n = 0u64;
    loop {
        match res.chunk().await {
            Ok(Some(bytes)) => {
                file.write_all(&bytes).map_err(err("write download"))?;
                n += bytes.len() as u64;
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&part);
                return Err(format!("download from Drive: {e}"));
            }
        }
    }
    file.flush().map_err(err("write download"))?;
    drop(file);
    fs::rename(&part, dest).map_err(err("save download"))?;
    Ok(n)
}

/// Download a Drive file (or one `revision` of it) into a show's copy on this Mac.
#[tauri::command]
pub async fn drive_download(app: AppHandle, file_id: String, dest: String, revision: Option<String>) -> Result<(), String> {
    let dest = PathBuf::from(dest);
    if !in_cache(&app, &dest) {
        return Err("Downloads only go into the app's shows folder".into());
    }
    download_to(&app, &file_id, revision.as_deref(), &dest).await.map(|_| ())
}

/// Which of these files are on this Mac.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

/// Delete files from a show's copy on this Mac (bundle-relative, under media/). They stay in Google Drive and download
/// again when they're needed. Returns how many were deleted.
#[tauri::command]
pub fn drive_evict(app: AppHandle, bundle: String, paths: Vec<String>) -> Result<usize, String> {
    let show = PathBuf::from(&bundle);
    if !in_cache(&app, &show) {
        return Err("That isn't one of the app's show copies".into());
    }
    let mut n = 0;
    for rel in paths {
        let p = Path::new(&rel);
        if !rel.starts_with("media/") || p.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            continue;
        }
        if fs::remove_file(show.join(p)).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Delete a show's whole copy from this Mac (the show itself is in Google Drive).
#[tauri::command]
pub fn drive_forget(app: AppHandle, bundle: String) -> Result<(), String> {
    let show = PathBuf::from(&bundle);
    if !in_cache(&app, &show) || show.parent() != cache_root(&app).as_deref() {
        return Err("That isn't one of the app's show copies".into());
    }
    if show.exists() { fs::remove_dir_all(&show).map_err(err("remove the show's copy")) } else { Ok(()) }
}

/// Upload a file to Drive: a new file in `parent`, or new content for `file_id`. `properties` are set on it too.
/// Returns the file's id, name, headRevisionId, md5Checksum, size and modifiedTime.
#[tauri::command]
pub async fn drive_upload(app: AppHandle, path: String, name: Option<String>, parent: Option<String>, file_id: Option<String>, properties: Option<Value>) -> Result<Value, String> {
    let src = PathBuf::from(&path);
    let size = fs::metadata(&src).map_err(err("read file"))?.len();
    let mime = mime_for(&src);
    let mut meta = serde_json::Map::new();
    if let Some(p) = properties {
        meta.insert("properties".into(), p);
    }
    match (&file_id, &parent) {
        (Some(id), _) if !valid_id(id) => return Err(format!("not a Drive file id: {id}")),
        (Some(_), _) => {}
        (None, Some(p)) => {
            meta.insert("parents".into(), serde_json::json!([p]));
            meta.insert("name".into(), Value::String(name.clone().unwrap_or_else(|| src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())));
        }
        (None, None) => return Err("upload needs a folder or a file id".into()),
    }
    let meta = Value::Object(meta);
    let (method, base) = match &file_id {
        Some(id) => (reqwest::Method::PATCH, format!("{UPLOAD}/{id}")),
        None => (reqwest::Method::POST, UPLOAD.to_string()),
    };
    if size <= SIMPLE_MAX {
        let bytes = fs::read(&src).map_err(err("read file"))?;
        let boundary = format!("pmss{}", std::process::id());
        let body = multipart_body(&boundary, &meta, mime, &bytes);
        let url = format!("{base}?uploadType=multipart&{RETURN}");
        for attempt in 0..2 {
            let token = access_token(&app).await?;
            let res = reqwest::Client::new()
                .request(method.clone(), &url)
                .bearer_auth(token)
                .header("Content-Type", format!("multipart/related; boundary={boundary}"))
                .body(body.clone())
                .send()
                .await
                .map_err(err("upload to Drive"))?;
            let status = res.status();
            let text = res.text().await.map_err(err("read Drive's reply"))?;
            if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                forget_token(&app);
                continue;
            }
            if !status.is_success() {
                return Err(api_error(status, &text));
            }
            return serde_json::from_str(&text).map_err(err("read Drive's reply"));
        }
        unreachable!()
    }
    resumable(&app, method, &format!("{base}?uploadType=resumable&{RETURN}"), &meta, &src, size, mime).await
}

/// A resumable upload: open a session, then send the file in chunks.
async fn resumable(app: &AppHandle, method: reqwest::Method, url: &str, meta: &Value, src: &Path, size: u64, mime: &str) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let token = access_token(app).await?;
    let res = client
        .request(method, url)
        .bearer_auth(&token)
        .header("X-Upload-Content-Type", mime)
        .header("X-Upload-Content-Length", size)
        .json(meta)
        .send()
        .await
        .map_err(err("start upload"))?;
    if !res.status().is_success() {
        let status = res.status();
        return Err(api_error(status, &res.text().await.unwrap_or_default()));
    }
    let session = res.headers().get("location").and_then(|v| v.to_str().ok()).ok_or("Drive didn't open an upload")?.to_string();
    let mut file = fs::File::open(src).map_err(err("read file"))?;
    let mut buf = vec![0u8; CHUNK];
    let mut offset = 0u64;
    loop {
        file.seek(SeekFrom::Start(offset)).map_err(err("read file"))?;
        let mut n = 0;
        while n < CHUNK {
            let got = file.read(&mut buf[n..]).map_err(err("read file"))?;
            if got == 0 {
                break;
            }
            n += got;
        }
        let end = offset + n as u64;
        let token = access_token(app).await?;
        let res = client
            .put(&session)
            .bearer_auth(&token)
            .header("Content-Length", n)
            .header("Content-Range", format!("bytes {offset}-{}/{size}", end.saturating_sub(1)))
            .body(buf[..n].to_vec())
            .send()
            .await
            .map_err(err("upload to Drive"))?;
        let status = res.status();
        if status.as_u16() == 308 {
            // "Range: bytes=0-N": what Drive has so far
            offset = res.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.rsplit('-').next()?.parse::<u64>().ok()).map(|last| last + 1).unwrap_or(0);
            continue;
        }
        let text = res.text().await.map_err(err("read Drive's reply"))?;
        if !status.is_success() {
            return Err(api_error(status, &text));
        }
        return serde_json::from_str(&text).map_err(err("read Drive's reply"));
    }
}

/// The show folder a cached path is in, and the path inside it ("media/renders/x.jpg").
fn split_cached(root: &Path, path: &Path) -> Option<(PathBuf, String)> {
    let rest = path.strip_prefix(root).ok()?;
    let mut parts = rest.components();
    let show = root.join(parts.next()?.as_os_str());
    let rel: Vec<String> = parts.map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    (!rel.is_empty()).then(|| (show, rel.join("/")))
}

/// The Drive id of a file in a show: from the manifest, else looked up folder by folder from the show's folder.
async fn file_id(app: &AppHandle, show: &Path, rel: &str) -> Result<String, String> {
    let manifest: Value = fs::read_to_string(show.join(MANIFEST)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    if let Some(id) = manifest["files"][rel]["id"].as_str() {
        return Ok(id.to_string());
    }
    let mut parent = manifest["folderId"].as_str().ok_or("This show isn't linked to Google Drive")?.to_string();
    for name in rel.split('/') {
        let q = format!("'{parent}' in parents and name = '{}' and trashed = false", name.replace('\\', "\\\\").replace('\'', "\\'"));
        let url = reqwest::Url::parse_with_params(FILES, &[("q", q.as_str()), ("fields", "files(id)"), ("supportsAllDrives", "true"), ("includeItemsFromAllDrives", "true")]).map_err(err("url"))?;
        let found = get_json(app, url.as_str()).await?;
        parent = found["files"][0]["id"].as_str().ok_or_else(|| format!("{rel} isn't in Google Drive"))?.to_string();
    }
    Ok(parent)
}

/// Make sure a file in a show's copy is on this Mac, downloading it if it isn't. Several asks for the same file
/// share one download.
async fn fetch(app: &AppHandle, path: &Path) -> Result<(), String> {
    let root = cache_root(app).ok_or("no app data folder")?;
    let (show, rel) = split_cached(&root, path).ok_or("not in a show")?;
    let started = Instant::now();
    loop {
        if path.exists() {
            return Ok(());
        }
        let mine = {
            let mut busy = FETCHING.lock().unwrap();
            busy.get_or_insert_with(HashSet::new).insert(path.to_path_buf())
        };
        if mine {
            break;
        }
        if started.elapsed() > FETCH_WAIT {
            return Err("timed out waiting for a download".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let result = async {
        let id = file_id(app, &show, &rel).await?;
        download_to(app, &id, None, path).await.map(|_| ())
    }
    .await;
    FETCHING.lock().unwrap().get_or_insert_with(HashSet::new).remove(path);
    result
}

/// For the media server: true once `path` is on this Mac, downloading it first if it's in a show's copy.
pub fn fetch_blocking(path: &Path) -> bool {
    if path.exists() {
        return true;
    }
    let Some(app) = APP.get() else { return false };
    if !in_cache(app, path) {
        return false;
    }
    tauri::async_runtime::block_on(fetch(app, path)).is_ok()
}

/// Download any of a show's files (bundle-relative paths) that aren't on this Mac. Returns a note for each one that
/// couldn't be.
#[tauri::command]
pub async fn drive_fetch(app: AppHandle, bundle: String, paths: Vec<String>) -> Vec<String> {
    let show = PathBuf::from(&bundle);
    if !in_cache(&app, &show) {
        return vec!["This show isn't one of the app's copies".into()];
    }
    let jobs: Vec<_> = paths
        .into_iter()
        .filter(|rel| !rel.starts_with('/') && !rel.split('/').any(|p| p == ".."))
        .map(|rel| {
            let (app, path) = (app.clone(), show.join(&rel));
            tauri::async_runtime::spawn(async move { fetch(&app, &path).await.map_err(|e| format!("{rel}: {e}")) })
        })
        .collect();
    let mut notes = Vec::new();
    for job in jobs {
        if let Ok(Err(note)) = job.await {
            notes.push(note);
        }
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_ids_are_checked() {
        assert!(valid_id("1AbC-d_9"));
        assert!(!valid_id(""));
        assert!(!valid_id("abc/../x"));
        assert!(!valid_id("a b"));
    }

    #[test]
    fn splits_a_cached_path_into_show_and_file() {
        let root = PathBuf::from("/Users/x/Library/Application Support/app/shows");
        let (show, rel) = split_cached(&root, &root.join("FOLDER1/media/renders/a b.jpg")).unwrap();
        assert_eq!(show, root.join("FOLDER1"));
        assert_eq!(rel, "media/renders/a b.jpg");
        assert!(split_cached(&root, &root.join("FOLDER1")).is_none());
        assert!(split_cached(&root, Path::new("/elsewhere/x.jpg")).is_none());
    }
}

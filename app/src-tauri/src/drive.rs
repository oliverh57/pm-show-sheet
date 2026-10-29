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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
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
/// The most the shows folder may take up, in bytes (0: no limit), from the app's settings (drive_set_cache_limit).
static CACHE_LIMIT: AtomicU64 = AtomicU64::new(0);
/// One trim at a time.
static TRIMMING: Mutex<()> = Mutex::new(());

/// How far an upload has got, in bytes, for the upload progress bar (src/components/UploadProgress.tsx). `id` is the
/// file's path.
#[derive(Clone, serde::Serialize)]
struct UploadProgress {
    id: String,
    sent: u64,
    total: u64,
}

fn upload_progress(app: &AppHandle, path: &Path, sent: u64, total: u64) {
    let _ = app.emit("upload-progress", UploadProgress { id: path.to_string_lossy().to_string(), sent, total });
}

/// How far a media download has got (src/drive/media.ts `watchDownloads`): a start, bytes now and then, and an end
/// (`done`, whether or not it worked). `id` is the file's path; `total` is 0 until Drive says the size.
#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    id: String,
    received: u64,
    total: u64,
    done: bool,
}
const DOWNLOAD_PROGRESS_EVERY: Duration = Duration::from_millis(150);

fn download_progress(app: &AppHandle, id: &str, received: u64, total: u64, done: bool) {
    let _ = app.emit("download-progress", DownloadProgress { id: id.to_string(), received, total, done });
}

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
/// `revision`: an earlier version of the file instead of the current one. `progress` gets the bytes received so far, and
/// the size (0 if Drive doesn't say), every so often.
async fn download_to(app: &AppHandle, file_id: &str, revision: Option<&str>, dest: &Path, progress: &(dyn Fn(u64, u64) + Send + Sync)) -> Result<u64, String> {
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
    let size = res.content_length().unwrap_or(0);
    let mut n = 0u64;
    let mut reported = Instant::now();
    progress(0, size);
    loop {
        match res.chunk().await {
            Ok(Some(bytes)) => {
                file.write_all(&bytes).map_err(err("write download"))?;
                n += bytes.len() as u64;
                if reported.elapsed() >= DOWNLOAD_PROGRESS_EVERY {
                    progress(n, size);
                    reported = Instant::now();
                }
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
    download_to(&app, &file_id, revision.as_deref(), &dest, &|_, _| {}).await.map(|_| ())
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

/// Every show copied to this Mac (its folder in the shows folder), opened lately or not.
#[tauri::command]
pub fn drive_cached_shows(app: AppHandle) -> Vec<String> {
    let Some(root) = cache_root(&app) else { return vec![] };
    let Ok(entries) = fs::read_dir(&root) else { return vec![] };
    entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).map(|p| p.to_string_lossy().to_string()).collect()
}

/// Bytes the shows folder takes up on this Mac.
#[tauri::command]
pub async fn drive_cache_size(app: AppHandle) -> u64 {
    let Some(root) = cache_root(&app) else { return 0 };
    tauri::async_runtime::spawn_blocking(move || dir_size(&root)).await.unwrap_or(0)
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries.flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => dir_size(&e.path()),
        Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
        _ => 0,
    }).sum()
}

/// Space on this Mac: what the shows folder takes up, and the size of the disk it's on and what's free there, in bytes.
#[derive(serde::Serialize)]
pub struct Storage {
    cache: u64,
    total: u64,
    free: u64,
}

#[tauri::command]
pub async fn drive_storage(app: AppHandle) -> Result<Storage, String> {
    let root = cache_root(&app).ok_or("no app data folder")?;
    fs::create_dir_all(&root).map_err(err("create the shows folder"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let (total, free) = disk_space(&root);
        Storage { cache: dir_size(&root), total, free }
    })
    .await
    .map_err(err("measure storage"))
}

/// The size of the disk holding `path`, and the space free on it (to apps), in bytes. Zeros if it can't be read.
fn disk_space(path: &Path) -> (u64, u64) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return (0, 0) };
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return (0, 0);
    }
    let block = s.f_frsize as u64;
    (s.f_blocks as u64 * block, s.f_bavail as u64 * block)
}

/// Set the most the shows folder may take up (0: no limit), and trim it to that now. Returns the bytes freed.
#[tauri::command]
pub async fn drive_set_cache_limit(app: AppHandle, bytes: u64) -> u64 {
    CACHE_LIMIT.store(bytes, Ordering::Relaxed);
    let Some(root) = cache_root(&app) else { return 0 };
    tauri::async_runtime::spawn_blocking(move || trim_cache(&root, bytes, None)).await.unwrap_or(0)
}

/// Over `limit` bytes, delete the shows folder's least recently used media until it's under: only files that are in
/// Google Drive (in their show's manifest), so they download again when they're shown. Never `keep` (a file just
/// downloaded) or one downloading. Returns the bytes freed.
fn trim_cache(root: &Path, limit: u64, keep: Option<&Path>) -> u64 {
    if limit == 0 {
        return 0;
    }
    let _one = TRIMMING.lock().unwrap_or_else(|e| e.into_inner());
    let total = dir_size(root);
    if total <= limit {
        return 0;
    }
    let busy = FETCHING.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for show in fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let manifest: Value = fs::read_to_string(show.join(MANIFEST)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let Some(listed) = manifest["files"].as_object() else { continue };
        for rel in listed.keys() {
            let p = Path::new(rel);
            if !rel.starts_with("media/") || p.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
                continue;
            }
            let path = show.join(p);
            if keep == Some(path.as_path()) || busy.contains(&path) {
                continue;
            }
            let Ok(m) = fs::metadata(&path) else { continue };
            if !m.is_file() {
                continue;
            }
            // Last used: last read, or downloaded if that's later.
            let used = [m.accessed(), m.modified()].into_iter().flatten().max().unwrap_or(SystemTime::UNIX_EPOCH);
            files.push((used, m.len(), path));
        }
    }
    files.sort_by_key(|f| f.0);
    let over = total - limit;
    let mut freed = 0;
    for (_, len, path) in files {
        if freed >= over {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            freed += len;
        }
    }
    freed
}

/// Open the shows folder in Finder.
#[tauri::command]
pub fn drive_open_cache(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let root = cache_root(&app).ok_or("no app data folder")?;
    fs::create_dir_all(&root).map_err(err("create the shows folder"))?;
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(err("open the shows folder"))
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
            upload_progress(&app, &src, size, size);
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
    upload_progress(app, src, 0, size);
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
            upload_progress(app, src, offset, size);
            continue;
        }
        let text = res.text().await.map_err(err("read Drive's reply"))?;
        if !status.is_success() {
            return Err(api_error(status, &text));
        }
        upload_progress(app, src, size, size);
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
/// share one download. `report`: show it in the download progress bar (not for copies the Sheet sync needs).
async fn fetch(app: &AppHandle, path: &Path, report: bool) -> Result<(), String> {
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
    let key = path.to_string_lossy().to_string();
    let progress = |got: u64, size: u64, done: bool| if report { download_progress(app, &key, got, size, done) };
    progress(0, 0, false);
    let result = async {
        let id = file_id(app, &show, &rel).await?;
        download_to(app, &id, None, path, &|got, size| progress(got, size, false)).await.map(|_| ())
    }
    .await;
    progress(0, 0, true);
    FETCHING.lock().unwrap().get_or_insert_with(HashSet::new).remove(path);
    // Make room: the least recently used media goes once the shows folder is over its limit.
    let limit = CACHE_LIMIT.load(Ordering::Relaxed);
    if result.is_ok() && limit > 0 {
        let keep = path.to_path_buf();
        tauri::async_runtime::spawn_blocking(move || trim_cache(&root, limit, Some(&keep)));
    }
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
    tauri::async_runtime::block_on(fetch(app, path, true)).is_ok()
}

/// Download any of a show's files (bundle-relative paths) that aren't on this Mac. Returns a note for each one that
/// couldn't be. `quiet`: keep them out of the download progress bar.
#[tauri::command]
pub async fn drive_fetch(app: AppHandle, bundle: String, paths: Vec<String>, quiet: Option<bool>) -> Vec<String> {
    let report = !quiet.unwrap_or(false);
    let show = PathBuf::from(&bundle);
    if !in_cache(&app, &show) {
        return vec!["This show isn't one of the app's copies".into()];
    }
    let jobs: Vec<_> = paths
        .into_iter()
        .filter(|rel| !rel.starts_with('/') && !rel.split('/').any(|p| p == ".."))
        .map(|rel| {
            let (app, path) = (app.clone(), show.join(&rel));
            tauri::async_runtime::spawn(async move { fetch(&app, &path, report).await.map_err(|e| format!("{rel}: {e}")) })
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
    fn trims_the_least_recently_used_media_in_drive() {
        let root = std::env::temp_dir().join(format!("pm-trim-{}", std::process::id()));
        let media = root.join("show1/media/clips");
        fs::create_dir_all(&media).unwrap();
        let listed = serde_json::json!({ "files": { "media/clips/old.mp4": {}, "media/clips/mid.mp4": {}, "media/clips/new.mp4": {}, "media/../x": {} } });
        fs::write(root.join("show1").join(MANIFEST), listed.to_string()).unwrap();
        let now = SystemTime::now();
        for (name, age) in [("old.mp4", 300), ("mid.mp4", 200), ("new.mp4", 100), ("uploading.mp4", 400)] {
            let f = fs::File::create(media.join(name)).unwrap();
            f.set_len(1000).unwrap();
            let at = now - Duration::from_secs(age);
            f.set_times(fs::FileTimes::new().set_accessed(at).set_modified(at)).unwrap();
        }
        // 4000 bytes of media (plus the manifest) under a 2500-byte limit: the two oldest files in Drive go.
        assert_eq!(trim_cache(&root, 2500, None), 2000);
        assert!(!media.join("old.mp4").exists() && !media.join("mid.mp4").exists());
        assert!(media.join("new.mp4").exists() && media.join("uploading.mp4").exists());
        assert_eq!(trim_cache(&root, 0, None), 0);
        // A file just downloaded stays, however old.
        assert_eq!(trim_cache(&root, 1500, Some(&media.join("new.mp4"))), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn measures_the_disk() {
        let (total, free) = disk_space(&std::env::temp_dir());
        assert!(total > 0 && free > 0 && free <= total);
    }

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

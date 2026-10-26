//! Google sign-in: installed-app OAuth with PKCE and a loopback redirect (DESIGN.md §8.8).
//!
//! The OAuth client (a Google Cloud "Desktop app" client) comes from, in order:
//! the PM_GOOGLE_CLIENT_ID / PM_GOOGLE_CLIENT_SECRET build-time environment variables,
//! or a client JSON file the user picked once, copied to the app's config folder as google_client.json.
//! The refresh token is kept in the macOS keychain; the signed-in profile is cached on disk so the
//! app opens offline.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "com.pixelmappers.showsheet";
const KEYCHAIN_ACCOUNT: &str = "google-refresh-token";
const CLIENT_FILE: &str = "google_client.json";
const USER_FILE: &str = "google_user.json";
/// Full Drive access: the app reads and writes shows other people (and older versions) made, and puts the Sheet and
/// deck in their folders (drive.file would only reach files this app made itself).
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive";
const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/drive";
pub const SIGN_IN_AGAIN: &str = "Sign in to Google again to let the app put the Sheet and deck in the show's folder";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GoogleUser {
    pub name: String,
    pub email: String,
    pub picture: Option<String>,
}

struct Client {
    id: String,
    secret: String,
}

fn err<E: std::fmt::Display>(context: &str) -> impl Fn(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err("find config folder"))?;
    fs::create_dir_all(&dir).map_err(err("create config folder"))?;
    Ok(dir)
}

/// Read a client JSON as downloaded from Google Cloud: {"installed": {"client_id", "client_secret", …}}.
fn parse_client(text: &str) -> Result<Client, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(err("read client file"))?;
    let inner = v.get("installed").or_else(|| v.get("web")).unwrap_or(&v);
    let id = inner["client_id"].as_str().ok_or("the file has no client_id")?;
    let secret = inner["client_secret"].as_str().ok_or("the file has no client_secret")?;
    Ok(Client { id: id.into(), secret: secret.into() })
}

fn client(app: &AppHandle) -> Option<Client> {
    if let (Some(id), Some(secret)) = (option_env!("PM_GOOGLE_CLIENT_ID"), option_env!("PM_GOOGLE_CLIENT_SECRET")) {
        if !id.is_empty() && !secret.is_empty() {
            return Some(Client { id: id.into(), secret: secret.into() });
        }
    }
    let file = config_dir(app).ok()?.join(CLIENT_FILE);
    parse_client(&fs::read_to_string(file).ok()?).ok()
}

#[tauri::command]
pub fn google_client_configured(app: AppHandle) -> bool {
    client(&app).is_some()
}

/// Remember the OAuth client file the user chose (copied into the app's config folder).
#[tauri::command]
pub fn google_set_client(app: AppHandle, path: String) -> Result<(), String> {
    let text = fs::read_to_string(&path).map_err(err("read client file"))?;
    parse_client(&text)?;
    fs::write(config_dir(&app)?.join(CLIENT_FILE), text).map_err(err("save client file"))
}

fn random_token(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(err("generate random token"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The query string of the first line of an HTTP request: "GET /?code=…&state=… HTTP/1.1".
pub fn parse_redirect(request: &str) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let get = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
    Some((get("code"), get("state"), get("error")))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title>\
<body style=\"font:15px -apple-system,system-ui;display:grid;place-items:center;height:90vh;color:#1d1d1f\">\
<div style=\"text-align:center\"><h2 style=\"font-weight:600\">You're signed in</h2>\
<p style=\"color:#6e6e73\">You can close this tab and go back to PM Show Sheet.</p></div>";

/// Wait for the browser to come back to the loopback address with ?code=…
fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(err("listen for sign-in"))?;
    let started = Instant::now();
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let Some((code, got_state, error)) = parse_redirect(&request) else { continue };
                if code.is_none() && error.is_none() {
                    // e.g. a favicon request
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                let body = if error.is_some() { "Sign-in was cancelled. You can close this tab." } else { DONE_PAGE };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                if let Some(e) = error {
                    return Err(format!("Google sign-in was cancelled ({e})"));
                }
                if got_state.as_deref() != Some(state) {
                    return Err("Sign-in response didn't match this request; try again".into());
                }
                return code.ok_or_else(|| "Google didn't return a sign-in code".into());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if started.elapsed() > SIGN_IN_TIMEOUT {
                    return Err("Sign-in timed out. Try again.".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("listen for sign-in: {e}")),
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct UserInfo {
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

fn keychain() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(err("open keychain"))
}

// Where the refresh token lives. Release builds use the keychain. Dev builds get a new code signature on
// every rebuild, so macOS would ask for the keychain password each time: they keep it in a private file
// (owner-only permissions) in the app's config folder instead. Either way it's read at most once per run.
const TOKEN_FILE: &str = "google_refresh_token";

fn save_refresh(app: &AppHandle, token: &str) -> Result<(), String> {
    app.state::<TokenCache>().1.lock().unwrap().replace(token.to_string());
    if cfg!(debug_assertions) {
        let file = config_dir(app)?.join(TOKEN_FILE);
        fs::write(&file, token).map_err(err("save sign-in"))?;
        set_private(&file);
        Ok(())
    } else {
        keychain()?.set_password(token).map_err(err("save sign-in to the keychain"))
    }
}

fn load_refresh(app: &AppHandle) -> Option<String> {
    let cache = app.state::<TokenCache>();
    if let Some(t) = cache.1.lock().unwrap().clone() {
        return Some(t);
    }
    let token = if cfg!(debug_assertions) {
        let file = config_dir(app).ok()?.join(TOKEN_FILE);
        fs::read_to_string(&file).ok().filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string()).or_else(|| {
            // Signed in with an older dev build: move the token out of the keychain (one last prompt).
            let t = keychain().ok()?.get_password().ok()?;
            if fs::write(&file, &t).is_ok() {
                set_private(&file);
                if let Ok(entry) = keychain() { let _ = entry.delete_credential(); }
            }
            Some(t)
        })?
    } else {
        keychain().ok()?.get_password().ok()?
    };
    cache.1.lock().unwrap().replace(token.clone());
    Some(token)
}

fn delete_refresh(app: &AppHandle) {
    app.state::<TokenCache>().1.lock().unwrap().take();
    if let Ok(dir) = config_dir(app) { let _ = fs::remove_file(dir.join(TOKEN_FILE)); }
    if !cfg!(debug_assertions) {
        if let Ok(entry) = keychain() { let _ = entry.delete_credential(); }
    }
}

fn set_private(file: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
}

/// Open Google in the browser, wait for the user to sign in, and return who they are.
#[tauri::command]
pub async fn google_sign_in(app: AppHandle) -> Result<GoogleUser, String> {
    let client = client(&app).ok_or("Google sign-in isn't set up on this Mac yet")?;
    let verifier = random_token(48)?;
    let state = random_token(16)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err("listen for sign-in"))?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(err("listen for sign-in"))?.port());
    let auth_url = Url::parse_with_params("https://accounts.google.com/o/oauth2/v2/auth", &[
        ("client_id", client.id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("code_challenge", pkce_challenge(&verifier).as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]).map_err(err("build sign-in link"))?;
    app.opener().open_url(auth_url.as_str(), None::<&str>).map_err(err("open the browser"))?;

    let state_for_wait = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state_for_wait))
        .await
        .map_err(err("wait for sign-in"))??;

    let http = reqwest::Client::new();
    let tokens: TokenResponse = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(err("reach Google"))?
        .error_for_status()
        .map_err(err("finish sign-in"))?
        .json()
        .await
        .map_err(err("read sign-in response"))?;
    let info: UserInfo = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(err("reach Google"))?
        .error_for_status()
        .map_err(err("read your Google profile"))?
        .json()
        .await
        .map_err(err("read your Google profile"))?;

    if let Some(refresh) = tokens.refresh_token {
        save_refresh(&app, &refresh)?;
    }
    let user = GoogleUser { name: info.name.unwrap_or_else(|| info.email.clone()), email: info.email, picture: info.picture };
    let bytes = serde_json::to_vec_pretty(&user).map_err(err("encode profile"))?;
    fs::write(config_dir(&app)?.join(USER_FILE), bytes).map_err(err("save profile"))?;
    Ok(user)
}

/// Who's signed in on this Mac, from the cached profile (works offline, and doesn't touch the keychain).
/// None if signed out. A missing or revoked token shows up later, when sync asks for a token.
#[tauri::command]
pub fn google_current_user(app: AppHandle) -> Option<GoogleUser> {
    let text = fs::read_to_string(config_dir(&app).ok()?.join(USER_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub async fn google_sign_out(app: AppHandle) -> Result<(), String> {
    if let Some(token) = load_refresh(&app) {
        // Best effort: tell Google to forget the token too.
        let _ = reqwest::Client::new()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", token.as_str())])
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }
    delete_refresh(&app);
    *app.state::<TokenCache>().0.lock().unwrap() = None;
    let _ = fs::remove_file(config_dir(&app)?.join(USER_FILE));
    Ok(())
}

// --- API access for the sync engine ---------------------------------------------

/// The current access token and when it stops working, plus the refresh token once it's been read.
#[derive(Default)]
pub struct TokenCache(Mutex<Option<(String, Instant)>>, Mutex<Option<String>>);

#[derive(Deserialize)]
struct Refreshed {
    access_token: String,
    expires_in: u64,
    scope: Option<String>,
}

/// Whether a token's scopes include full Drive access (sign-ins from before the app asked for it don't).
fn has_drive_scope(scope: &str) -> bool {
    scope.split_whitespace().any(|s| s == DRIVE_SCOPE)
}

pub(crate) async fn access_token(app: &AppHandle) -> Result<String, String> {
    let cache = app.state::<TokenCache>();
    if let Some((token, until)) = cache.0.lock().unwrap().clone() {
        if until > Instant::now() + Duration::from_secs(60) {
            return Ok(token);
        }
    }
    let client = client(app).ok_or("Google sign-in isn't set up on this Mac")?;
    let refresh = load_refresh(app).ok_or_else(|| "Sign in to Google again".to_string())?;
    let res: Refreshed = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .form(&[("client_id", client.id.as_str()), ("client_secret", client.secret.as_str()), ("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")])
        .send()
        .await
        .map_err(err("reach Google"))?
        .error_for_status()
        .map_err(|_| "Google sign-in has expired. Sign out and in again.".to_string())?
        .json()
        .await
        .map_err(err("read token"))?;
    if res.scope.as_deref().is_some_and(|s| !has_drive_scope(s)) {
        return Err(SIGN_IN_AGAIN.into());
    }
    *cache.0.lock().unwrap() = Some((res.access_token.clone(), Instant::now() + Duration::from_secs(res.expires_in)));
    Ok(res.access_token)
}

pub(crate) fn forget_token(app: &AppHandle) {
    *app.state::<TokenCache>().0.lock().unwrap() = None;
}

/// Only Google's API hosts, so the frontend can't send the token anywhere else.
pub fn allowed_api_url(url: &str) -> bool {
    ["https://www.googleapis.com/", "https://sheets.googleapis.com/", "https://slides.googleapis.com/"].iter().any(|p| url.starts_with(p))
}

/// Turn a Google error response into one readable line.
pub(crate) fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("Google {}: {msg}", status.as_u16())
}

/// One Google API call (Sheets, Slides or Drive) as the signed-in user. Returns the JSON response.
#[tauri::command]
pub async fn google_api(app: AppHandle, method: String, url: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    if !allowed_api_url(&url) {
        return Err(format!("not a Google API URL: {url}"));
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(err("method"))?;
    for attempt in 0..2 {
        let token = access_token(&app).await?;
        let mut req = reqwest::Client::new().request(method.clone(), &url).bearer_auth(&token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(err("reach Google"))?;
        let status = res.status();
        let text = res.text().await.map_err(err("read Google's reply"))?;
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            forget_token(&app);
            continue;
        }
        if !status.is_success() {
            return Err(api_error(status, &text));
        }
        return Ok(if text.trim().is_empty() { serde_json::Value::Null } else { serde_json::from_str(&text).map_err(err("read Google's reply"))? });
    }
    unreachable!()
}

pub(crate) fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// A multipart/related body: JSON metadata, then the file bytes.
pub fn multipart_body(boundary: &str, metadata: &serde_json::Value, mime: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Upload a file to Drive (create in `parent`, or replace `file_id`'s content). Images can be
/// downsized first (renders are 4096px; `max_px` = 2560 for Drive). Returns the file id.
#[tauri::command]
pub async fn google_upload(app: AppHandle, path: String, name: String, parent: Option<String>, file_id: Option<String>, max_px: Option<u32>) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let mut mime = mime_for(&src);
    let bytes = if let (Some(px), "image/jpeg" | "image/png") = (max_px, mime) {
        let tmp = std::env::temp_dir().join(format!("pmss-upload-{}.jpg", std::process::id()));
        let ok = std::process::Command::new("sips")
            .args(["-Z", &px.to_string(), "-s", "format", "jpeg", "-s", "formatOptions", "80"])
            .arg(&src).arg("--out").arg(&tmp)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let data = if ok { fs::read(&tmp) } else { fs::read(&src) }.map_err(err("read image"))?;
        let _ = fs::remove_file(&tmp);
        if ok {
            mime = "image/jpeg";
        }
        data
    } else {
        fs::read(&src).map_err(err("read file"))?
    };
    let metadata = match (&file_id, &parent) {
        (Some(_), _) => serde_json::json!({}),
        (None, Some(p)) => serde_json::json!({ "name": name, "parents": [p] }),
        (None, None) => serde_json::json!({ "name": name }),
    };
    let boundary = format!("pmss{}", std::process::id());
    let body = multipart_body(&boundary, &metadata, mime, &bytes);
    let (method, url) = match &file_id {
        Some(id) => (reqwest::Method::PATCH, format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=multipart&fields=id&supportsAllDrives=true")),
        None => (reqwest::Method::POST, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true".to_string()),
    };
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
        let v: serde_json::Value = serde_json::from_str(&text).map_err(err("read Drive's reply"))?;
        return v["id"].as_str().map(String::from).ok_or_else(|| "Drive didn't return a file id".into());
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc_7636_example() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn reads_code_and_state_from_redirect() {
        let req = "GET /?state=abc&code=4%2F0Ab&scope=email HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(parse_redirect(req), Some((Some("4/0Ab".into()), Some("abc".into()), None)));
        let denied = "GET /?error=access_denied&state=abc HTTP/1.1\r\n";
        assert_eq!(parse_redirect(denied).unwrap().2.as_deref(), Some("access_denied"));
    }

    #[test]
    fn drive_scope_must_be_full_drive() {
        assert!(has_drive_scope("openid https://www.googleapis.com/auth/drive email"));
        assert!(!has_drive_scope("openid https://www.googleapis.com/auth/drive.file email"));
    }

    #[test]
    fn api_calls_only_go_to_google() {
        assert!(allowed_api_url("https://sheets.googleapis.com/v4/spreadsheets/x:batchUpdate"));
        assert!(allowed_api_url("https://www.googleapis.com/drive/v3/files"));
        assert!(!allowed_api_url("https://evil.example.com/?https://sheets.googleapis.com/"));
    }

    #[test]
    fn builds_multipart_upload() {
        let body = multipart_body("b", &serde_json::json!({"name": "x.jpg"}), "image/jpeg", b"DATA");
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with("--b\r\nContent-Type: application/json"));
        assert!(text.contains("{\"name\":\"x.jpg\"}\r\n--b\r\nContent-Type: image/jpeg\r\n\r\nDATA\r\n--b--"));
    }

    #[test]
    fn parses_downloaded_client_file() {
        let c = parse_client(r#"{"installed":{"client_id":"id.apps","client_secret":"s"}}"#).unwrap();
        assert_eq!((c.id.as_str(), c.secret.as_str()), ("id.apps", "s"));
        assert!(parse_client(r#"{"installed":{}}"#).is_err());
    }
}

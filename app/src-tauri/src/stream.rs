// Plays local video in the webview over http://127.0.0.1. The asset:// protocol answers each range request with at
// most 1 MB, and WebKit gives up on a long show record whose index (moov) is bigger than that, so videos stream from
// here instead, the way Safari would read them from a web server: any range, sent in full.
// Only this Mac can connect, and only with the random token in the URL; only files the asset scope allows are served.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;

static BASE: OnceLock<String> = OnceLock::new();

/// Start the server (once) and return its base URL: http://127.0.0.1:<port>/<token>
pub fn start() -> String {
    BASE.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the media server");
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let mut bytes = [0u8; 16];
        let _ = getrandom::fill(&mut bytes);
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let prefix = format!("/{token}"); // then the file's absolute path
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let prefix = prefix.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &prefix); // the player drops connections it's done with: that's fine
                });
            }
        });
        format!("http://127.0.0.1:{port}/{token}")
    })
    .clone()
}

#[tauri::command]
pub fn media_server() -> String {
    start()
}

/// Files the app may play: anything under the home folder or on a mounted volume (as tauri.conf.json's asset scope).
fn allowed(path: &PathBuf) -> bool {
    let home = std::env::var("HOME").map(PathBuf::from).ok();
    path.is_absolute()
        && !path.components().any(|c| matches!(c, std::path::Component::ParentDir))
        && (home.is_some_and(|h| path.starts_with(h)) || path.starts_with("/Volumes"))
}

fn mime(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("aif") | Some("aiff") => "audio/aiff",
        _ => "video/mp4",
    }
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "bytes=START-END" or "bytes=START-" → (start, end inclusive), clamped to the file.
fn range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?; // the last n bytes
        (len.saturating_sub(n), len.checked_sub(1)?)
    } else {
        let start: u64 = a.parse().ok()?;
        (start, if b.is_empty() { len.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(len.checked_sub(1)?) })
    };
    (start <= end && start < len).then_some((start, end))
}

fn serve(stream: TcpStream, prefix: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut range_header = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }
    let respond = |out: &mut TcpStream, status: &str| out.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());

    let Some(rest) = target.strip_prefix(prefix) else { return respond(&mut out, "403 Forbidden") };
    let path = PathBuf::from(decode(rest.split('?').next().unwrap_or("")));
    if !allowed(&path) {
        return respond(&mut out, "403 Forbidden");
    }
    let Ok(mut file) = File::open(&path) else { return respond(&mut out, "404 Not Found") };
    let len = file.metadata()?.len();
    let (status, start, end) = match range_header.as_deref() {
        Some(h) => match range(h, len) {
            Some((s, e)) => ("206 Partial Content", s, e),
            None => {
                return out.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
            }
        },
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let n = if len == 0 { 0 } else { end - start + 1 };
    // Any origin may read it (the token is the lock): the player reads LTC audio with crossorigin="anonymous".
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {n}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n", mime(&path));
    if status.starts_with("206") {
        head += &format!("Content-Range: bytes {start}-{end}/{len}\r\n");
    }
    head += "\r\n";
    out.write_all(head.as_bytes())?;
    if method == "HEAD" || n == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    std::io::copy(&mut file.take(n), &mut out)?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(range("bytes=100-", 100), None);
        assert_eq!(decode("/Users/a%20b/%26.mp4"), "/Users/a b/&.mp4");
    }

    #[test]
    fn serves_a_range_and_refuses_without_the_token() {
        let base = start();
        let dir = std::env::temp_dir().join(format!("pmss-stream-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("a b.mp4");
        std::fs::write(&file, b"0123456789").unwrap();
        let home = std::env::var("HOME").unwrap();
        let get = |url: &str, range: Option<&str>| -> String {
            let rest = url.strip_prefix("http://").unwrap();
            let (host, path) = rest.split_once('/').unwrap();
            let mut s = TcpStream::connect(host).unwrap();
            let r = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
            write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n{r}\r\n").unwrap();
            let mut body = String::new();
            s.read_to_string(&mut body).unwrap();
            body
        };
        // Temp files live outside $HOME on macOS: outside the scope, so refused. Serve one from $HOME instead.
        if !file.starts_with(&home) {
            assert!(get(&format!("{base}{}", file.display().to_string().replace(' ', "%20")), None).starts_with("HTTP/1.1 403"));
        }
        let mine = PathBuf::from(&home).join(format!(".pmss-stream-test-{}.mp4", std::process::id()));
        std::fs::write(&mine, b"0123456789").unwrap();
        let url = format!("{base}{}", mine.display());
        let res = get(&url, Some("bytes=2-5"));
        let _ = std::fs::remove_file(&mine);
        assert!(res.starts_with("HTTP/1.1 206"), "{res}");
        assert!(res.contains("Content-Range: bytes 2-5/10"));
        assert!(res.ends_with("2345"));
        let wrong = base.rsplit_once('/').unwrap().0.to_string() + "/nottoken" + &mine.display().to_string();
        assert!(get(&wrong, None).starts_with("HTTP/1.1 403"));
    }
}

//! ffmpeg and ffprobe, which the app needs for file details, LTC, clips and saved copies. They come
//! from Homebrew: the setup guide installs them with brew in the background, or, when Homebrew isn't
//! here, opens a Terminal script that installs Homebrew first (that needs the Mac password).

use crate::tool_path;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct ToolsStatus {
    ffmpeg: bool,
    ffprobe: bool,
    brew: bool,
}

#[tauri::command]
pub fn tools_status() -> ToolsStatus {
    ToolsStatus { ffmpeg: tool_path("ffmpeg").is_some(), ffprobe: tool_path("ffprobe").is_some(), brew: tool_path("brew").is_some() }
}

/// `brew install ffmpeg` (ffprobe comes with it). Emits each line of brew's output as `tools-install-log`.
#[tauri::command]
pub async fn tools_install(app: AppHandle) -> Result<(), String> {
    let brew = tool_path("brew").ok_or("Homebrew isn't installed")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Apps opened from Finder get a bare PATH; brew's formulae expect its own bin folder on it.
        let bin = brew.parent().unwrap_or(Path::new("/opt/homebrew/bin"));
        let mut child = Command::new(&brew)
            .args(["install", "ffmpeg"])
            .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", bin.display()))
            .env("HOMEBREW_NO_ENV_HINTS", "1")
            .env("HOMEBREW_NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't run Homebrew: {e}"))?;
        // brew writes progress to stdout and warnings to stderr; keep stderr for the error message.
        let stderr = child.stderr.take();
        let errors = std::thread::spawn(move || stderr.map(|s| BufReader::new(s).lines().map_while(Result::ok).collect::<Vec<_>>()).unwrap_or_default());
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app.emit("tools-install-log", line);
            }
        }
        let status = child.wait().map_err(|e| format!("Couldn't run Homebrew: {e}"))?;
        let errors = errors.join().unwrap_or_default();
        if status.success() && tool_path("ffmpeg").is_some() && tool_path("ffprobe").is_some() {
            return Ok(());
        }
        let last = errors.iter().rev().find(|l| l.starts_with("Error")).or(errors.last()).cloned().unwrap_or_else(|| "unknown error".into());
        Err(format!("Homebrew couldn't install ffmpeg: {last}"))
    })
    .await
    .map_err(|e| format!("Couldn't run Homebrew: {e}"))?
}

const TERMINAL_SCRIPT: &str = r##"#!/bin/bash
# Opened by PM Show Sheet: installs ffmpeg, and Homebrew first if it isn't on this Mac.
clear
echo "Installing ffmpeg for PM Show Sheet"
echo
BREW="$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -n 1)"
if [ -z "$BREW" ]; then
  echo "First Homebrew, which installs ffmpeg. It asks for the password you use to log in to this Mac"
  echo "(nothing shows as you type it), then to press Return."
  echo
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || { echo; echo "Homebrew wasn't installed, so neither was ffmpeg."; exit 1; }
  BREW="$(ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -n 1)"
fi
echo
"$BREW" install ffmpeg && { echo; echo "Done. You can close this window and go back to PM Show Sheet."; }
"##;

/// Open the install script in Terminal (a .command file opens there and runs).
#[tauri::command]
pub fn tools_install_in_terminal() -> Result<(), String> {
    let script = std::env::temp_dir().join("Install ffmpeg for PM Show Sheet.command");
    std::fs::write(&script, TERMINAL_SCRIPT).map_err(|e| format!("Couldn't write the install script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("Couldn't write the install script: {e}"))?;
    }
    let ok = Command::new("open").arg(&script).status().map_err(|e| format!("Couldn't open Terminal: {e}"))?.success();
    if ok { Ok(()) } else { Err("Couldn't open Terminal".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_script_is_valid_bash() {
        let path = std::env::temp_dir().join(format!("pmss-tools-{}.sh", std::process::id()));
        std::fs::write(&path, TERMINAL_SCRIPT).unwrap();
        assert!(Command::new("bash").arg("-n").arg(&path).status().unwrap().success());
    }
}

# PM Show Sheet

Pixelmappers' desktop app for building show sheets: running order, renders, audio versions, show records, colours and notes per song. It publishes a Google Sheet and Slides deck for collaborators.

## Install (Mac)

Paste into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/oliverh57/pm-show-sheet/main/install.sh | bash
```

This installs the latest version into Applications and opens it. After that the app updates itself in the background: it checks GitHub on launch and every few hours, then offers **Restart to update**.

## Shipping an update

```bash
scripts/release.sh 0.2.0 "What changed"
```

This bumps the version, tags it and pushes. GitHub Actions (`.github/workflows/release.yml`) builds a universal app (Apple Silicon and Intel), signs it and publishes a release with `latest.json`, which installed apps check.

How the install avoids macOS's trust prompts:
- **No "unidentified developer" warning.** curl downloads don't carry macOS's quarantine flag, so Gatekeeper never stops the app. The updater downloads the same way.
- **Folder-access approval survives updates.** Every release is signed with the same self-signed certificate, so macOS sees each update as the same app.
- **Tampered updates are rejected.** Each update archive carries a minisign signature, which the app checks against the public key in `app/src-tauri/tauri.conf.json` before installing.

Release secrets (GitHub → Settings → Secrets): `PMSS_CODESIGN_P12`, `PMSS_CODESIGN_P12_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Local copies live in `~/.tauri/` on the release machine, never in the repo.

## Layout

| Path | What |
|---|---|
| `app/` | The Tauri + React app (see `app/README.md`) |
| `DESIGN.md` | Design doc: decisions, data model, Google sync, risks |
| `prototypes/google-sheets/` | Google Sheets and Slides publishing prototype (Python) |
| `prototypes/ltc/` | LTC timecode decoding prototype |
| `install.sh`, `scripts/` | Installer and release tooling |

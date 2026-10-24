# PM Show Sheet (desktop app)

Tauri 2 + React 19 + TypeScript. macOS. This is phase 2 of DESIGN.md (the local core): show bundles on disk, the set list grid, the song detail panel and the column manager. Live sync, Google publishing and the render inbox come later.

## Run

Needs Node and Rust (installed with `brew install node rustup`, then `rustup default stable`). Homebrew's rustup isn't on PATH by default, so:

```bash
export PATH="$(brew --prefix rustup)/bin:$PATH"
```
```bash
npm install
```
```bash
npm run tauri dev
```

| Command | Does |
|---|---|
| `npm run tauri dev` | Desktop app with hot reload |
| `npm run dev` | UI only in a browser at http://localhost:1420. Shows live in memory; nothing touches disk |
| `npm test` | Model and undo tests (vitest) |
| `cargo test` (in `src-tauri/`) | Bundle create, save, open and media import tests |
| `npm run tauri build` | Release `.app` / `.dmg` |

## What's here

Light, macOS-style UI (designed in `prototypes/ui-design/`).

**Sign in** with Google (installed-app OAuth with PKCE, `src-tauri/src/google.rs`). The OAuth client is a Google Cloud "Desktop app" client:
- release builds get it from the `PM_GOOGLE_CLIENT_ID` / `PM_GOOGLE_CLIENT_SECRET` secrets at build time;
- otherwise the sign-in screen asks for the client JSON once per Mac (it's copied to the app's config folder).
The refresh token is kept in the macOS keychain.

**Google Drive setup**: after sign-in, if Google Drive for desktop isn't installed or isn't signed in to the user's account (`shows::drive_status`), a guide walks through downloading, installing and signing in, and carries on by itself once Drive appears. It can be skipped (shows then open read only). `npm run dev` with `?nodrive` previews it.

**ffmpeg setup**: after that, if ffmpeg or ffprobe is missing (`tools::tools_status`), a second guide installs them. With Homebrew on the Mac the app runs `brew install ffmpeg` itself and shows its progress; without it, **Open Terminal** runs a script that installs Homebrew (it asks for the Mac password, and needs an admin account) and then ffmpeg. Either way the guide carries on once ffmpeg appears, and can be skipped. Preview with `?noffmpeg` (add `&nobrew` for the Terminal route).

**All shows** (home): every `.showsheet` in the signed-in account's Google Drive, My Drive and every shared drive, found through Google Drive for desktop (`src-tauri/src/shows.rs`, `shows_scan`). The last list shows straight away; folders that held shows are checked first, then the rest (a full scan of big shared drives can take a minute). New shows go to the last folder used, or wherever most shows are. A show outside your Google Drive opens read only, with a banner to move it in. **Open in Drive** opens the show's folder on drive.google.com. Each open app writes `presence/<email>.json` in the bundle every 30 s, so the sidebar shows who else has the show open. Click the show name for **Show settings** (name, venue, date, location, Google files, columns).

**Inside a show** (sidebar: Songs ⌘1, Media ⌘2, Share ⌘3, Sheet ⌘4). New shows get a setup guide: Songs → Media → Share.
- **Songs**: cards in running order (or a list). Drag a card to reorder; drop on Archive to take it out of the set. Every song has a BPM (it can't be removed). Add songs by typing (`Rosemary, 04:00`), pasting a set list (choose the column order, e.g. Name, TC, BPM), or from the show audio's TC map. Each card shows the show's **note fields** (long-text columns with `on_card`; Lighting and Camera direction by default). **+ Note field** adds one to every song; × takes it off the cards and keeps the notes. Click a card for its detail panel (notes, TC, audio version, segue, statuses, media, colours).
- **Media**: drop or choose files, then answer **What is this media?** (show record, song clip, renders & stills, audio). The **Render inbox** tab culls watch folders (P / X / U, 1–9).
  - **Show record / show audio**: the app reads LTC from every audio channel (`src-tauri/src/ltc.rs`, about 5 s for a 90-minute record) and splits it into TC blocks, matched to songs by TC start. A block can be split when TC runs on through two sections (e.g. an intro into a song): split at the player position or a typed TC; a song with no TC gets the TC where its part starts, and the app suggests the split when such a song follows a matched one. With no LTC, mark songs by hand: play or scrub, press **M** at each song's start.
  - **Playback**: records and audio play in place; when a file has LTC on one channel, that channel is muted (Web Audio) and left out of clips.
  - **Clips**: one 720p H.264 clip per song into `media/clips/` (and optionally a still into `media/grabs/`), cut with ffmpeg in the background.
- **Share & publish**: the always-on Google Sheet and Slides deck (`src/google/`). While a show is open the app pulls edits from the Sheet's ✎ columns and pushes the show a few seconds after each change, redraws the deck when you pause, and checks the Sheet every minute. Clashing edits are listed here to resolve. Sync is always on. The Sheet, deck and a `Slides images` folder live inside the show's own `.showsheet` folder in Drive, so they move, share and delete with the show; shows from before that are moved in on their next sync. This needs the full `drive` scope (the `.showsheet` folder is made by Drive for desktop, not the app); after the scope change everyone signs in once more.
- **Sheet view**: the grid, with Columns.

Needs ffmpeg and ffprobe (`brew install ffmpeg`) for file details, LTC and clips.

**Also:** undo/redo (⌘Z / ⇧⌘Z), autosave, ⌘S.

## Browser preview

`npm run dev` runs the UI in a browser. Shows live in memory and sign-in is simulated; the LTC scan returns the Overmono TC map from DESIGN.md Appendix A, and clips aren't cut. The dev server can also list and read files inside the project folder (`/__pm/list`, `/__pm/probe`, `/@fs/`), so the render inbox and Add media work against `Exmaple Content/`. In dev builds, `window.__pm` exposes the store and model operations for poking at state.

## Layout

```
src/model/       types, pure operations (ops.ts), gel library, sample show, tests
src/store.ts     zustand state: show, undo history, selection
src/backend.ts   Tauri commands (desktop) or in-memory stand-in (browser)
src/library.ts   finding, opening and creating shows (Drive folder, recent shows)
src/jobs.ts      background clip cutting
src/components/  SignIn, Home, Shell (sidebar, setup guide), SongsPage, SongDrawer (+ SongSections), MediaPage,
                 ImportPage (+ Marker), RenderInbox, OtherPages (Share, Sheet), Grid, ColumnsDialog
src-tauri/src/   lib.rs (bundles, media import, probe, clip_cut, frame_grab, ltc_scan), google.rs, shows.rs, ltc.rs
```

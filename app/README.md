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

**Google Drive**: shows live in Google Drive and the app reaches them through the Drive API as the signed-in user (`src/drive/`, `src-tauri/src/drive.rs`). Google Drive for desktop isn't needed. Each show you open is copied to `~/Library/Application Support/com.pixelmappers.showsheet/shows/<Drive folder id>/` and kept in step with Drive:
- **Saving** writes the copy on this Mac, then uploads `project.json`. If someone else saved since, their version is downloaded and merged field by field with yours (`src/drive/merge.ts`: different fields both survive; when you both changed the same one, yours wins and a toast says so), then uploaded. With no connection the save waits and the sidebar says Offline.
- **Live**: every 10 s the app checks whether `project.json` changed in Drive and merges it in; undo history is rebased so undo never takes back a teammate's edit.
- **Media** the app makes (clips, stills, crops, imported renders) uploads into the show's `media/` folder after each save. Files made on another Mac download the first time they're shown, through the local media server (`src-tauri/src/stream.rs`), or before ffmpeg reads them.
- **Who's here**: each open app sets its own key in the show folder's Drive `properties` every 30 s, so the sidebar shows who else has the show open.
- **Records and audio** stay where they are on each Mac's disks (they're linked, not uploaded). One added on another Mac shows **Locate…** on the Media page.
- **Storage** (Settings): a show's clips and images can be removed from this Mac and download again when shown; clips of shows not opened for a chosen time are removed by themselves.

**ffmpeg setup**: after sign-in, if ffmpeg or ffprobe is missing (`tools::tools_status`), a second guide installs them. With Homebrew on the Mac the app runs `brew install ffmpeg` itself and shows its progress; without it, **Open Terminal** runs a script that installs Homebrew (it asks for the Mac password, and needs an admin account) and then ffmpeg. Either way the guide carries on once ffmpeg appears, and can be skipped. Preview with `?noffmpeg` (add `&nobrew` for the Terminal route).

**All shows** (home): every `.showsheet` folder the signed-in account can reach in Google Drive: My Drive, every shared drive, and shows shared with you (`src/drive/list.ts`). A Drive search finds them; each show folder carries a short summary in its Drive `properties` (name, venue, date, songs) so the list doesn't download every show. The last list shows straight away. A show you can only view opens read only. **New show** and **Move** pick a Drive folder (`DriveFolderPicker`); new shows go to the last folder used, or My Drive › Pixelmappers Show Sheets. **Open in Drive** opens the show's folder on drive.google.com. Click the show name for **Show settings** (name, venue, date, location, Google files, columns).

**Inside a show** (sidebar: Songs ⌘1, Media ⌘2, Share ⌘3, Sheet ⌘4). New shows get a setup guide: Songs → Media → Share.
- **Songs**: cards in running order (or a list). Drag a card to reorder; drop on Archive to take it out of the set. Every song has a BPM (it can't be removed). Add songs by typing (`Rosemary, 04:00`), pasting a set list (choose the column order, e.g. Name, TC, BPM), or from the show audio's TC map. Each card shows the show's **note fields** (long-text columns with `on_card`; Lighting and Camera direction by default). **+ Note field** adds one to every song; × takes it off the cards and keeps the notes. Click a card for its detail panel (notes, TC, audio version, segue, statuses, media, colours).
- **Media**: drop or choose files, then answer **What is this media?** (show record, song clip, renders & stills, audio). The **Render inbox** tab culls watch folders (P / X / U, 1–9).
  - **Show record / show audio**: the app reads LTC from every audio channel (`src-tauri/src/ltc.rs`, about 5 s for a 90-minute record) and splits it into TC blocks, matched to songs by TC start. A block can be split when TC runs on through two sections (e.g. an intro into a song): split at the player position or a typed TC; a song with no TC gets the TC where its part starts, and the app suggests the split when such a song follows a matched one. With no LTC, mark songs by hand: play or scrub, press **M** at each song's start.
  - **Playback**: records and audio play in place; when a file has LTC on one channel, that channel is muted (Web Audio) and left out of clips.
  - **Clips**: one 720p H.264 clip per song into `media/clips/` (and optionally a still into `media/grabs/`), cut with ffmpeg in the background.
- **Share & publish**: the always-on Google Sheet and Slides deck (`src/google/`). While a show is open the app pulls edits from the Sheet's ✎ columns and pushes the show a few seconds after each change, redraws the deck when you pause, and checks the Sheet every minute. Clashing edits are listed here to resolve. Sync is always on. The Sheet, deck and a `Slides images` folder live inside the show's own `.showsheet` folder in Drive, so they move, share and delete with the show; shows from before that are moved in on their next sync. This needs the full `drive` scope (shows made by other people and older versions aren't the app's own files, which is all `drive.file` reaches).
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
src/library.ts   finding, opening, creating and moving shows
src/drive/       Drive API: listing shows, the copy on this Mac, three-way merge, media uploads, presence
src/storage.ts   removing downloaded media from this Mac
src/jobs.ts      background clip cutting
src/components/  SignIn, Home, Shell (sidebar, setup guide), SongsPage, SongDrawer (+ SongSections), MediaPage,
                 ImportPage (+ Marker), RenderInbox, OtherPages (Share, Sheet), Grid, ColumnsDialog
src-tauri/src/   lib.rs (bundles, media import, probe, clip_cut, frame_grab, ltc_scan), google.rs, drive.rs (downloads,
                 uploads, media from other Macs), stream.rs (local media server), ltc.rs
```

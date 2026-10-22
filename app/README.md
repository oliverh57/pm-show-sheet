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

Three views (⌘1 / ⌘2 / ⌘3) and a big **+ Add media** button (⌘I).

**Songs** (main view)
- Left: the running order as cards, then the song archive. Drag ⋮⋮ (or ⌥↑ / ⌥↓) to reorder or archive.
  - Each card shows what the song already has (renders, audio, records, open notes), so gaps stand out.
  - A **Show media** card at the top covers whole-show records, show audio and watch folders.
- Right: the workspace for the selected song: + Renders, + Audio, + Song record, then sections for Renders (hero and gallery), Audio (versions, newest is current, with a player), Records (with a video player), Colours (gel library), Details and Notes.

**Add media**, in six types:

| Type | What it is | Stored |
|---|---|---|
| Show record | Whole-show video (wide, multicam, content, LTC) | Linked in place |
| Song record | Video of one song | Linked in place |
| Show audio | Continuous playback for the whole show | Linked, with a version label |
| Song audio | A new version for a song; it becomes current and fills AUDIO VERSION | Linked, with a version label |
| Renders | Stills for a song | Copied into `media/renders` |
| Watch folder | A Depence export folder for the render inbox | Linked |

- Files can be chosen in the dialog or dropped from Finder anywhere on the window.
- Images dropped on a song's card go straight onto that song; anything else opens Add media with the type guessed.
- The song is suggested from the filename, and the version from names like `V4.1`, `v20250609b` or `012025`.
- Each file's details (duration, resolution, fps, channels, any timecode track) are read with ffprobe.

**Render inbox**
- Every image in the watch folders, re-checked every 5 seconds, grouped into sessions by save time.
- Keys: **P** approve, **X** reject, **U** clear, arrows to move, **Space** for the big view, **1–9** to assign to running-order song 1–9.
- Approving copies the render into the song, and optionally makes it the hero.
- Decisions are kept per machine in the show's `inbox.json`.

**Sheet**: the spreadsheet grid from before, with Columns for managing columns.

**Also:** undo/redo, autosave, ⌘S.

**Known:** two of the example records are fragmented MP4s. Chrome can't play those progressively; untested in the app's WebKit view. If ▶ Watch stays blank in the app, the next step is to have the app make a playable proxy copy.

## Browser preview

`npm run dev` runs the UI in a browser. Shows live in memory. The dev server can also list and read files inside the project folder (`/__pm/list`, `/__pm/probe`, `/@fs/`), so the render inbox and Add media work against `Exmaple Content/`. In dev builds, `window.__pm` exposes the store and model operations for poking at state.

## Layout

```
src/model/       types, pure operations (ops.ts), gel library, sample show, tests
src/store.ts     zustand state: show, undo history, selection
src/backend.ts   Tauri commands (desktop) or in-memory stand-in (browser)
src/components/  SongCards, SongWorkspace (+ SongSections), AddMediaDialog, RenderInbox, Grid, ColumnsDialog
src-tauri/src/   bundle_create/open/save, media_import, list_folder, probe_media, side_read/write
```

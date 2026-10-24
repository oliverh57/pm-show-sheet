# Pixelmappers Show Sheet — Design Doc

Status: planning · Last updated: 2026-10-21 · Platform: macOS

## 1. Summary

An internal macOS desktop app for building **show sheets**: the collection of everything Pixelmappers needs to make a show and present it to collaborators. That covers the running order, audio versions, timecode, colours, notes for each department, reference images, renders, clips from show records, rehearsal notes, blocking and research.

Today this lives in hand-built Google Sheets (three past shows were reviewed for this design). Those sheets work well as a grid but are poor at media: the Reference Photo, Colour and Dia Ref columns are nearly always empty. The app keeps the grid and adds proper media handling, and it still publishes a familiar Google Sheet and Slides deck that collaborators can comment on and partly edit.

### Goals
- A fast grid of songs, as easy to use as the current sheets, with a detail panel for media, notes and comments on each song.
- Drag in folders of renders, show records, phone footage and stills, then cull them, clip them, grab frames and attach them to songs.
- Several Pixelmappers staff can edit the same show live.
- The project is saved on disk as a portable bundle.
- An up-to-date Google Sheet and Google Slides deck that collaborators can view, comment on and partly edit, with their edits and comments flowing back into the app.
- No server to run or maintain.

### Non-goals for v1
- Windows support.
- An artist or song library spanning multiple shows. New shows are made by duplicating an existing one.
- Several running orders per show.
- Audio analysis (BPM detection, finding song sections automatically).
- Change history or named snapshots inside the app. Undo within a session is enough.
- A content asset register (an "Assets" tab in one of the past sheets).
- Collaborators choosing between render options.
- Background sync while no team member has the app open.

## 2. Users

| Who | Where they work | What they do |
|---|---|---|
| Pixelmappers staff | In the app (Google Workspace sign-in) | Build and edit the show, cull renders, clip records, take notes, publish |
| External collaborators (artist, MD, video director, camera ops, LD) | In the Google Sheet and Slides | Read; comment; edit the columns opened up to them; add rehearsal notes in session tabs |

## 3. Decision log

| Area | Decision |
|---|---|
| App type | Desktop app on macOS only (Tauri recommended, see §10) |
| Project storage | Hybrid bundle: project data, generated clips, approved renders and stills are copied in; large source records are only linked, with relink tools |
| Where shows live | In a "Pixelmappers Show Sheets" folder in the user's Google Drive, synced by Google Drive for desktop; the app lists that folder as "All shows". A folder can be chosen instead if Drive isn't installed (2026-10-22) |
| Team sync | Live multi-user editing through **Firestore** (managed, no server to run), with offline cache |
| Google sync | Runs inside whichever app is open; one machine at a time holds a sync lock. When no app is open, nothing syncs |
| Sign-in | Google Workspace, restricted to the Pixelmappers domain |
| Shared output | **Both** a Google Sheet (working grid) and Google Slides (one slide per song) |
| Collaborator edits | Only some columns are editable. Enforced with protected ranges, and each row has a hidden ID so moving or inserting columns doesn't break sync |
| Collaborator access | **Invite by email** as viewer, commenter or editor; each invite also gives read access to the show's `media/` folder so images load. Images are never public. Link sharing is secondary (images won't show for link-only viewers) |
| Media hosting | Media is uploaded automatically to a Drive folder per show; video goes up as low-quality H.264 copies |
| Columns | Core fields plus per-show custom fields, saved as templates |
| Status ticks | Plain checkboxes; each show picks which ones it has |
| Song pool | One set list plus an archive pool; songs can be archived and brought back |
| Segues | A simple "segues into next" flag on the song |
| Audio | Usually **one audio file per song**, each with its own version history; a single continuous show file (for example a DJ-style set) is also supported, split by its TC blocks. Version labels set by the user are trusted. **Compare mode** shows what changed between two versions. No musical analysis |
| Footage alignment | Decode LTC from an audio channel where present (the main case), or use a tmcd track; otherwise manual in/out marking |
| Media attachment | Each song has a gallery; any item can be pinned to a specific field |
| Renders | Review inbox with Lightroom-style culling; versions kept per song; one hero image plus up to 3 extras per song |
| Rejected renders | Stay in the source folder, hidden but linked; can be approved later |
| File → song matching | Always confirmed by hand; the app suggests a song when the filename contains its name |
| Show record output | A low-quality clip per song (uploaded) plus frame grabs into the song gallery |
| Comments | Shown on the matching song; reply and resolve from the app; turn into a note; desktop notification |
| Colours | Gel library (Lee, Rosco, named whites) plus eyedropper and custom hex |
| Main view | Grid plus a song detail panel |
| Sheet layout | Mirrors the old sheets: main sheet (archive below a divider), session notes tabs, global notes, blocking, research |
| Rehearsal notes | Quick keyboard entry in the app, plus collaborators typing into session tabs in the Sheet |
| Research | Per-song inspo board, kept in the song detail panel |
| Show info | Stage and screen layout references; global show notes |
| Branding | Pixelmappers house style on the Sheet and Slides |
| Exports | PDF of the deck, printable running order, CSV/XLSX |
| History | Not needed beyond undo |

## 4. Architecture

```
┌──────────────────────── Mac (each team member) ────────────────────────┐
│                                                                         │
│  Tauri app (WKWebView UI: React + TS)                                   │
│   ├─ Grid + Song detail panel + Render inbox + Record clipper           │
│   ├─ Firestore JS SDK  ◄──── live sync + offline cache ────►  Firestore │
│   ├─ Google sync worker (only runs while this app holds the sync lock)  │
│   │     ├─ Sheets API  (push grid, pull editable cells + session notes) │
│   │     ├─ Slides API  (regenerate per-song slides)                     │
│   │     └─ Drive API   (media uploads, comments, sharing)               │
│   └─ Rust side: file access, folder watching, ffmpeg/ffprobe sidecar   │
│                                                                         │
│  Disk: MyShow.showsheet/  (bundle: snapshot + copied media + proxies)   │
│        + linked source records on any drive                             │
└─────────────────────────────────────────────────────────────────────────┘
                 │                                   │
          Firestore (Firebase project)      Google Drive (per-show folder)
          • live show data                  • Show Sheet  • Show Slides
          • sync lock                       • media/ (proxies, stills)
          • media metadata (not bytes)      • collaborators comment / edit
```

### 4.1 Where the truth lives
- **Firestore** is the source of truth for show data while people are working together live.
- **The bundle on disk** holds a full snapshot of the show data (written on change, debounced) plus all copied media. It means the show is still "a file on the computer": it can be opened offline, zipped, archived and duplicated.
- **Google Sheet and Slides** are published views of the show. The only data that comes back from them is edits to editable cells, rows added in session notes tabs, and comments.

### 4.2 Media across machines
Firestore stores media **metadata** only. Media files are handled like this:
- Approved renders, frame grabs and clips are copied into the bundle of the person who added them, and a low-quality copy is uploaded to the show's Drive folder.
- Other team members' apps fetch those copies from Drive on demand and cache them in their own bundle.
- Full-quality originals and large source records stay on the machine (or drive) where they were added. The app shows "original on Oliver's machine / drive *X*" when a file isn't available locally.

### 4.3 Duplicating a show
"Duplicate show" copies the bundle (optionally without media), gives the copy a new show ID and Firestore document, and clears the Google links. The next publish creates a new Sheet, deck and Drive folder.

## 5. Data model

The same shapes are used in Firestore and in the bundle's `project.json`. IDs are ULIDs.

```
Show
  id, name, artist, template_id, house_style_version
  google: { sheet_id, slides_id, drive_folder_id, share_settings }
  columns: ColumnDef[]          // order + visibility for this show
  status_columns: StatusDef[]   // e.g. AUDIO, TC'D, LX, VID, VIZ, AUTO
  set_order: SongId[]           // the running order
  archive: SongId[]             // the song pool not in the set
  global_notes: rich text
  layout_refs: MediaId[]        // stage plot, screen layouts, rig drawings
  sessions: Session[]           // rehearsal/run sessions → notes tabs

ColumnDef
  id, label, department (LX | CONTENT | VIDEO | CAMERAS | STAGING | SFX | MD | custom)
  type: text | longtext | colour_set | media_ref | select | number | timecode
  collaborator_editable: bool   // drives protected ranges
  on_slide: bool

Song
  id, number ("33", "38?" allowed), name, album?
  audio_version (free text: "V3", "012025", "Spotify")
  tc_start ("04:30:00:00" — blocks aren't always on the hour), tc_end?, bpm?
  segues_into_next: bool
  statuses: { [status_id]: bool }
  colours: ColourSwatch[]       // ordered
  fields: { [column_id]: value }
  gallery: MediaId[]
  pinned: { [column_id]: MediaId }
  hero_render: MediaId?, extra_renders: MediaId[] (≤3)
  render_versions: RenderVersion[]
  blocking: BlockingRow[]
  inspo: InspoItem[]
  comments: CommentThread[]     // mirrored from Google

ColourSwatch
  kind: gel | named | hex
  gel: { maker: "Lee" | "Rosco", code, name }? ; hex; label?

Media
  id, kind: still | video | audio | doc
  origin: render | frame_grab | record_clip | upload | layout
  local_path (in-bundle or linked), source_machine, linked_source?
  drive_file_id?, proxy_drive_file_id?
  tc_in?, tc_out?, source_media_id?   // for clips and frame grabs
  added_by, added_at, note?

RenderVersion
  media_id, version (v1, v2…), approved_by, approved_at, note

AudioFile                          // one imported audio file
  id, path (linked), scope: song | show
  version_label ("V3", "012025", "V4.1"), song_id? (scope = song)
  received_at, from?, note? ("V2 DOWN A SEMITONE")
  programme_channel, ltc_channel?, ltc_fps?
  duration, loudness_lufs
  fingerprint: { envelope, chroma, onsets }               // cached for compare mode
  tc_map: { file_offset, tc_start, tc_end, song_id? }[]   // 1 entry for a song file; one per block for a show file

Song.audio_versions: AudioFileId[] (newest first), Song.current_audio: AudioFileId
Show.show_audio_versions: AudioFileId[]                   // continuous show files, if used

AudioComparison                    // cached result of compare mode
  a: AudioFileId, b: AudioFileId, song_id?
  offset, regions: { kind: same | changed | inserted | removed | level, a_range?, b_range?, delta_db? }[]
  duration_delta, loudness_delta, tc_start_delta, summary (generated text)

SourceRecord                       // a linked show record
  id, path, kind: ltc_record | wide | multicam | phone | content_record | render_video
  tc_source: ltc_audio(channel) | tmcd | none
  tc_map?: { file_offset, tc_start, tc_end }[]            // decoded from LTC
  fps, duration
  song_marks: { song_id, in, out, source: auto_tc | manual }[]

InboxItem                          // stored per machine, not shared
  path, folder_id, state: new | approved | rejected
  suggested_song_id?

Session
  id, label ("16/10 PM", "Show Day Run 1"), date
  notes: Note[]

Note
  id, song_id? (null = global), text, tc?, from, department, assignee?
  done: bool, source: app | sheet | comment, linked_media_id?

BlockingRow
  song_id, performer ("ARTIST", "CHORUS", "EXTRA"), sections: { [section]: text }
  // sections entered by hand per song: Start, V1, C1, V2, C2, Bridge, Final Chorus, Outro

InspoItem
  kind: link | image | note ; url?, media_id?, text?, preview?

CommentThread
  google_comment_id, target: sheet | slides
  anchor: { song_id?, column_id? } (best effort), resolved, replies[]
```

## 6. Bundle on disk

```
ARTIST_TOUR_2026.showsheet/
  project.json            # full snapshot of show data (+ firestore show id)
  media/
    renders/              # approved renders, copied in
    grabs/                # frame grabs from records
    clips/                # per-song clips, full quality if exported locally
    layout/               # stage plots, screen layouts
    inspo/
  proxies/                # low-quality H.264 copies of video
  thumbs/                 # thumbnails for the grid and inbox
  links.json              # linked source records + render folders (paths, bookmarks)
  inbox.json              # per-machine render triage state
```

- Linked files are stored with macOS security-scoped bookmarks plus the path, so they survive a moved or renamed file. A relink tool handles missing drives.
- On macOS the bundle is a package, so Finder shows it as a single file.

## 7. Features (v1)

### 7.1 Set list grid and song detail
- A grid in running order, then an "Archive" divider, then the pool of archived songs. Rows are dragged to reorder or to archive and restore.
- Columns come from the show's `ColumnDef[]`. Departments are colour-banded like the current sheets, columns can be grouped and collapsed, and status ticks sit at the left.
- A segue shows as a bracket or link icon between two rows. In the Sheet it is shown as "Cont." in the TC column of the following song.
- Clicking a song opens the detail panel, with tabs:
  - **Overview**: fields, colours, audio version, TC.
  - **Media**: gallery, pins, hero and extras.
  - **Renders**: approved renders and their versions.
  - **Clips**: marks on records and the clips made from them.
  - **Blocking**.
  - **Inspo**.
  - **Comments and notes**.
- Keyboard-first editing: arrow keys and Enter, type to edit, tick boxes with space.

### 7.2 Templates and columns
- Core fields always exist: #, Name, Audio Version, TC Hour, BPM, Colours, Colour Ref, statuses.
- Department columns are added from a library (Lighting Notes, Content Ref, Content Notes, Cam Framing, Video Design Notes, Notch Layer, Camera Summary & FX, Camera Direction, Staging, SFX, MD Note, Logo, Light Boxes, …) or created on the spot.
- Each column records whether collaborators can edit it and whether it appears on the slide.
- "Save as template" stores columns, statuses and the slide layout. Starter templates are made from past show sheets.

### 7.3 Colours
- Up to 4 ordered swatches per song plus a free-text colour reference ("Red then Sea Green").
- Swatch picker: Lee and Rosco gel library (searchable by code or name), named whites and corrections (OW, CTB, Double CTB, CTO, Tungsten, Sodium), an eyedropper that works on any still in the gallery, and custom hex.
- Gel swatches show their name in the Sheet and on the slide (for example "L201 Full CTB").

### 7.4 Audio and timecode
Audio arrives in two shapes:
- **One file per song (most common).** Each song has its own file, often with LTC on one channel at that song's TC start.
- **One continuous show file (less common).** The whole set runs as one file with seamless transitions (example record A). Each song sits in its own TC block (`02:00`, `01:30`, `00:20`…), and the blocks are not in TC order. See Appendix A.

Both shapes are linked, not copied. Audio is never uploaded to Drive.

**Importing**
- Drag in one file or a whole delivery folder.
- For each file, the app finds the LTC channel (it is the near-square-wave channel), if there is one, and decodes the TC start and frame rate. It also measures duration and loudness, and builds the fingerprint used by compare mode.
- **Per-song files:** matched to songs by name in the filename (audio deliveries usually are named) and by TC start, then confirmed by the user. The version label is suggested from the filename (`_V3`, `v20250609b`) or the delivery folder name, and the user can edit it. **The label the user sets is trusted.** The new file becomes the song's current version, and earlier versions stay in its history.
- **Continuous show file:** the app scans for TC jumps to build the TC map, one block per song. For a new show it offers to **create the set list from the map** (one row per block, in playback order, TC start filled in, user types the names). For an existing show it matches blocks to songs by TC start and flags new, missing or reordered blocks. Songs in a continuous file are marked as segues by default, because the transitions are seamless. The boundary is the TC jump, which can fall in the middle of a blend.
- Per-song overrides still work for one-off sources ("Spotify", "012025").

**Compare mode** (see what changed between two versions)
- Open it from a song's audio tab ("V3 vs V2"), or from a new delivery ("what changed in this batch?").
- **Alignment:** versions are lined up on their programme audio, not by sample position, so an added 8-bar intro doesn't make the whole song read as changed. This uses cross-correlation on the loudness envelope plus chroma and onset features, then DTW (dynamic time warping) over regions that have shifted.
- **What it shows:**
  - two waveforms stacked and aligned, with regions marked **same**, **changed**, **inserted**, **removed** or **level change** (with dB);
  - deltas for duration, loudness (LUFS) and TC start.
- **A/B listening:** both versions play locked together, and `Tab` switches between them at the same musical position. Clicking a changed region loops it.
- **TC impact:** when the TC start moves, or material is inserted or removed before a point, the app warns that **timecoded cues after that point have moved by N frames**. It shows the shift as a TC table (from → to) that lighting and video programmers can use directly.
- **Summary:** a generated change note (for example "V3 vs V2: new 0:00–0:15 intro (+15.0s), chorus 2 +1.5 dB, outro 6.2s shorter, cues after 00:00:15:00 shift +375 frames"). It can be added to the song as a rehearsal note or as a comment for MD/audio. The user can add their own notes too ("V2 DOWN A SEMITONE"). A pitch or key change won't be detected automatically.
- For continuous show files the compare runs per TC block, so the result reads per song.
- Identical files show "no audio changes" rather than an error.

**Other**
- A segue shows as "Cont." in the TC column.
- In-app playback of any version (scrub, play from TC) is available everywhere audio appears.
- Musical analysis (BPM, sections, key) is out of scope.

### 7.5 Render inbox (Depence)
1. Drag a Depence export folder into the app. It is linked and watched (with FSEvents), so new files appear in the inbox automatically.
2. **Cull** screen: a thumbnail grid plus a full-screen view.
   - `P` approves, `X` rejects, `U` clears the flag, arrow keys move.
   - `1–9` (or typing a song name) assigns a song.
   - `C` compares 2–4 iterations side by side.
3. File-to-song matching: if the filename contains a song name (fuzzy match), that song is suggested. **It is never auto-assigned**; the user always confirms. In practice Depence names files after the scene with a counter (`DEF VIDEO DEVELOPMENT - PATCHED_23.jpg`), so suggestions will rarely fire. The inbox should help in other ways:
   - sort by capture time, and group into **sessions** where there's a gap of more than about an hour (the example folder has two sessions, 19 and 23 June);
   - **stack near-duplicate iterations** using a perceptual hash, so a run of 6 almost-identical looks can be culled as one stack, with compare open by default;
   - once one render in a stack is assigned to a song, offer the same song for the rest of the stack.
   - Renders are 4096×2160 sRGB JPEGs of about 1 MB each. Thumbnails are generated at 512px, and the version uploaded to Drive is 2560px.
4. Approving a render copies it into `media/renders/`, adds it as a new version on the song, and queues the Drive upload. Video renders also get a low-quality copy made.
5. Rejected and unflagged files stay in the source folder, hidden behind a filter, so they can be approved later.
6. Each song has a hero render (shown in the Sheet) plus up to 3 extras (shown on the slide). Approving a newer render prompts "replace hero?".

### 7.6 Show records and clipping
- Drag in any recording: an LTC record, a wide shot, a multicam record, a content (media server output) record, phone footage or a video render. It is **linked, not copied**.
- **Timecode detection, in order:**
  1. **LTC on an audio channel.** This is the real-world case: example record A carries LTC on the right channel. The app decodes it across the file and builds a TC map matching the playback's TC blocks.
  2. A QuickTime tmcd or MXF timecode track, read with `ffprobe`. None of the example records has one.
  3. Neither found: manual marking.
- **Auto-split by TC:** each TC block in the record that matches a song's TC start becomes that song's in/out automatically, which the user checks. Clips are cut using the file time at which each LTC frame was decoded, not by counting frames, because the record's video rate (23.976) differs from the TC rate (25).
- Decoded TC is checked for valid ranges (hours under 24, minutes under 60, and so on). LTC is often garbled or missing in the minutes before and after the show; those parts become "pre-show" and "post-show".
- **Manual:** scrub, `I`/`O`, pick the song. For a no-TC record, marking the first song's start and then each boundary in turn is the fast path. A later option: line up a no-TC record against the playback audio (which is the same programme audio), to suggest boundaries.
- Burned-in TC (`[25] 04:00:23:16` on example record A) is not read from the picture; it serves as the visual check while marking.
- For each marked song the app can:
  - make a **low-quality clip** (720p H.264, roughly 2–3 Mbps), save it in the bundle, upload it to Drive, and link it from the Sheet and slide;
  - take **frame grabs** (`G` while scrubbing) into the song's gallery, which can then be pinned to a field.
- Playback: WKWebView plays ProRes and HEVC natively on macOS. The example records are already lightweight (1080p H.264, 5–6.5 Mbps, 1.5 h, about 4 GB), so they play directly. A scrubbing copy is only made for heavy or unusual files.

### 7.7 Media gallery and pinning
- Every song has a gallery of stills, clips and renders.
- Any item can be pinned to a field (for example a frame grab into "Cam Framing", a render into "Content Ref"). Pinned items appear in that cell in the Sheet and in that area of the slide.

### 7.8 Rehearsal notes
- Sessions ("14/10", "16/10 PM", "Show Day Run 1") each map to one notes tab in the Sheet, using the existing template columns: song, note, TC, from, assigned to, done.
- **Quick entry** (`N` or a global hotkey): type the note, `Tab` to the department or assignee, `Enter` to save. The selected song is used by default; a song left blank makes it a global note.
- Notes collaborators add in the Sheet's session tab are pulled into the app. New rows without an ID become new notes, and the app writes the ID back.
- Any comment can be turned into a note.

### 7.9 Blocking
- For each song, a grid of performer rows (ARTIST, CHORUS, EXTRA, …) against hand-entered sections (Start, V1, C1, …).
- Published as the BLOCKING tab in the Sheet.

### 7.10 Inspo (per song)
- Links (YouTube and web, with title and thumbnail previews), images and notes in the song detail panel.
- Published to a RESEARCH tab in the Sheet, grouped by song.

### 7.11 Show info
- Global show notes, shown in the app's header panel, the GLOBAL NOTES tab and a deck intro slide.
- Stage and screen layout references (plots, screen layouts, rig drawings), shown on intro slides.

## 8. Google integration

### 8.1 Sync lock
- Only one running app does Google sync at any moment. It holds a lock in a Firestore document: `{holder, expires_at}`, renewed every 30s and taken over with a transaction once it expires.
- The app holding the lock:
  - pushes show changes to the Sheet (debounced, one `batchUpdate` per flush);
  - polls the Sheet for editable cells and session tab rows every 60s;
  - polls Drive comments every 60s;
  - regenerates Slides on demand ("Publish slides"), or automatically after the show has been idle for a few minutes;
  - uploads queued media.
- Every app can see sync status: last push, last pull, and who holds the lock.

### 8.2 Sheet layout (mirrors the old sheets)
Tabs: **SHOW SHEET** · **GLOBAL NOTES** · one tab per **session** · **BLOCKING** · **RESEARCH**.

- SHOW SHEET has a title banner, department header bands, the set list, an "ARCHIVE" divider, then the archived songs.
- **Hidden column A** holds the song ID; **row 1 (hidden)** holds the column IDs. Sync matches rows and columns by these IDs, not by position, so a collaborator inserting or moving rows or columns does no damage.
- **Protected ranges** cover every column where `collaborator_editable = false`, plus the ID row and column. Editors and link editors can only change the unlocked columns. (Prototype item: check that protections hold for link editors.)
- Images use `=IMAGE()` with a Drive-hosted thumbnail URL. Clips and render sets appear as links to Drive files. (See risk R3 on visibility.)
- Colour swatches are cell background fills plus the gel name as text.

### 8.3 Pulling collaborator edits back
- For each editable cell, the app stores the value and hash it last pushed.
- On each poll:
  - If the Sheet value differs and the app value hasn't changed since the last push, the Sheet value is taken into the app.
  - If both have changed, the app value is kept and a **conflict** badge appears on the song, showing the Sheet value so someone can resolve it by hand.
- Session tabs: rows are matched by their hidden note ID, and rows with no ID become new notes.

### 8.4 Slides
- A cover slide, a set list slide, global notes and layout slides, then **one slide per song** in running order.
- Song slide: #, name, audio version, TC, colour swatches with gel names, the hero render plus up to 3 extras, pinned media, and the text of fields marked `on_slide`. A record clip is embedded as a Drive video where there is one.
- The deck is **regenerated** by the app, so it is shared **comment-only**. Slide object IDs are derived from song IDs, so comments stay attached to the right song.
- Uses the Pixelmappers house style: black pages, the white PIXELMAPPERS logo, **Lexend** as the accent font (titles, labels, department headings), Roboto for body text, Roboto Mono for TC and versions. Song titles step down in size so long names stay on one line.
- Images are inserted by making each one link-public just for the insert (R9); the deck keeps its own copies. Edits made directly in the deck are overwritten on the next publish.

### 8.5 Comments
- Drive `comments.list` is polled for both the Sheet and the deck.
- A comment is mapped to a song by its anchor (Sheet: row, then song ID; Slides: slide ID). Mapping a Sheet comment to an exact column is best effort (risk R1).
- In the app: a thread appears on the song with an unread badge and a desktop notification. Users can reply and resolve, and both write back to Google. "Make note" turns a comment into a rehearsal note.
- Comments with no anchor go to a show-level "Unplaced comments" list.

### 8.6 Drive folder and media
```
Pixelmappers Show Sheets/<Show name>/
  <Show> | SHOW SHEET   (Google Sheet)
  <Show> | SHOW DECK    (Google Slides)
  media/stills/  media/clips/  media/renders/  media/layout/
```
- Video is uploaded as low quality (720p H.264, roughly 2–3 Mbps). Stills are uploaded as JPEG with a 2560px long edge.
- Uploads can be resumed, are queued with retries, and show their progress in the app.

### 8.7 Sharing
- A Share dialog in the app can:
  - **Invite by email** (viewer, commenter or editor), using Drive `permissions.create` on the Sheet, deck and media folder;
  - **Create a link** (anyone with the link, as viewer, commenter or editor).
- With an **edit** link, people who aren't signed in can edit and comment, and they show up as "Anonymous" (seen in the prototype). The dialog should warn about this, and default to invites or to commenter or viewer links.
- **Every invite also shares the show's `media/` folder** (viewer, without a second email). Images are fetched with the viewer's own access, so this is what makes them load; the images themselves are never made public (R3, tested).
- Link sharing is still available, but people with only the link can't see images. The dialog says so.
- Removing someone removes both permissions.
- The deck is always comment-only for collaborators, whatever role they have on the Sheet.

### 8.8 Auth and scopes
- Google sign-in with OAuth (PKCE with a loopback redirect), restricted to the Workspace domain. The OAuth app is "Internal", so Google verification isn't needed.
- Scopes: `drive` (full Drive, so the Sheet and deck can be created inside each show's `.showsheet` folder, which Drive for desktop made), plus `openid email profile`. `drive.file` was used first but only reaches files the app created, which kept the Sheet and deck in a separate folder. The Firebase Auth Google provider uses the same account.
- Firestore security rules: only domain users can access, and per-show membership is optional later.

### 8.9 Quotas
- Sheets API allows about 60 write requests per minute per user. Pushes are debounced and batched into one `batchUpdate`, and polls read only the editable ranges plus session tabs.
- Slides regeneration runs as batched requests and is throttled.

## 9. Exports
- **PDF of the deck**: Drive export of the Slides deck as PDF.
- **Printable running order**: a one-page A4 or US Letter PDF made locally, with #, name, TC, segue markers, audio version and one chosen notes column. In house style.
- **CSV / XLSX** of the set list, plus XLSX with one sheet per tab.

## 10. Tech stack (recommended)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | Small, macOS-native WKWebView (plays ProRes and HEVC natively, which Electron's Chromium can't); Rust for file watching and ffmpeg; security-scoped bookmarks |
| UI | React + TypeScript | Team familiarity, ecosystem |
| Grid | **Custom DOM table** (built in phase 2) | A 60-row set list doesn't need a canvas grid; a plain table gives full control of swatches, thumbnails, ticks, sticky columns and keyboard editing. Revisit Glide Data Grid if shows grow past a few hundred rows |
| State / sync | zustand store with snapshot undo (phase 2); Firebase JS SDK (Firestore) with persistent cache (phase 3) | Live sync and offline support, no server |
| Media | ffmpeg / ffprobe sidecar (bundled) | Proxies, clips, thumbnails, timecode reading |
| LTC decode | libltc (Rust binding) or an ffmpeg-based approach | Reading LTC from audio channels |
| Google | REST: Sheets v4, Slides v1, Drive v3 | Called from the sync worker |
| Packaging | Signed and notarised .dmg, auto-update through Tauri updater | Internal distribution |

## 11. Risks and prototypes (do first)

R1–R3 are covered by the Google Sheets prototype in `prototypes/google-sheets/` (see its README test script).

| # | Risk | Prototype |
|---|---|---|
| R1 | Sheet comment anchors are unreliable in the Drive API | Make a Sheet, add comments in several cells through the UI, read `comments.list`, see whether row and column can be recovered. If not, fall back to the song row or the "Unplaced comments" list. **Result (2026-10-21): the anchor can't be used.** It is opaque, e.g. `{"type":"workbook-range","uid":0,"range":"930910868"}`, with no row or column. **Matching the quoted text worked**: the comment's quoted cell text found the exact cell (the right song's CAMERA DIRECTION cell). It will fail for comments on empty cells and for text that repeats ("NO CAMERAS"). Next: test those cases; consider putting the song name into the quoted text via a per-row helper, or falling back to "Unplaced" |
| R2 | Protected ranges may not hold for "anyone with link" editors | Share with a link editor, try editing protected and unprotected columns. **Passed (2026-10-21):** a link editor in a private window couldn't edit LIGHTING NOTES or insert rows or columns; ✎ cells and notes ticks were editable, and `pull` brought them in with no false protected-cell reports |
| R3 | `=IMAGE()` and Slides `createImage` need URLs Google can fetch, which can mean making media "anyone with link" readable; unreleased renders could then be exposed | Test `drive.file`-scoped thumbnails and per-file link sharing; decide whether an unlisted link is acceptable or whether images should be inserted another way. **First result (2026-10-21):** a new sheet shows `#REF!` in every `=IMAGE()` cell until someone clicks **Allow access** in the browser, once per file. After allowing, **private** images (lh3 URL) load for the owner. With private images, **a link collaborator sees no images**. It looks like the image is fetched with the viewer's own access, so images will be visible to whoever can see the media files. **Resolved:** sharing the `media/` folder with a user makes the images load for them, so images stay private (no public links) and the app shares the media folder with every invitee |
| R4 | Embedded and LTC timecode varies across ProRes, multicam, MXF and phone files | **Mostly done.** LTC decodes cleanly from the example playback WAV and example record A (`prototypes/ltc/`). Remaining: port to Rust with libltc, test drop-frame and 29.97/30 fps, test a ProRes multicam record and a file with a tmcd track |
| R8 | Lining up two audio versions when material is inserted, removed or retimed | Prototype compare mode (envelope cross-correlation, then DTW) on real V-to-V deliveries; check that the TC shift table is accurate to the frame |
| R9 | Slides can only insert images from a URL Google can fetch, which clashes with "images are never public" | **Passed (2026-10-21):** each image is made link-public only for the insert, then private again (in a `finally`). The deck keeps its own Google-hosted copy of each image, so deck viewers see images without `media/` access. The deck also stores the original link, but that file is private again. Republishing keeps slide IDs and redraws their contents; still to check whether comments on a slide survive. Embedded Drive video needs `media/` access, which invites already give |
| R5 | Firestore cost and limits for media-heavy shows | Keep media out of Firestore (metadata only); check document sizes for a 60-song show |
| R6 | Sync lock handover (laptop sleeps while holding the lock) | Short lock expiry plus takeover in a transaction; test with two machines |
| R7 | Collaborators editing the same cell as the app | Conflict badge flow (§8.3) |

## 12. Phasing

1. **Prototypes**: R1–R4, about 1 week.
2. **Local core**: bundle format, grid and detail panel, songs, set list and archive, segues, columns and templates, statuses, colours and the gel library, undo.
3. **Live team**: Google and Firebase sign-in, Firestore model, presence (who's viewing which song), bundle snapshotting.
4. **Media**: galleries and pinning, render inbox and culling, records, timecode and in/out marks, clip proxies, frame grabs, Drive upload queue.
5. **Google publishing**: Sheet push → pull back editable cells and session notes → comments → Slides → sharing dialog.
6. **Show-day tools**: quick notes entry, blocking, inspo, show info, exports, final house style pass.

## 13. Inputs needed
- ~~House style assets~~: logo supplied (`PIXELAMMPERS BRANDING/`); accent font Lexend. Still open: brand colours beyond black and white.
- The Google account that will own the Firebase project and the Google Cloud OAuth client.
- More samples: a Depence **video** render, a ProRes multicam record, a phone clip, and a sheet or list of the song names for the Autumn 2026 TC map (to test set list creation).
- Which department columns collaborators should be able to edit by default.
- The gel list to include (full Lee and Rosco, or a curated house list).

## Appendix A. Example content findings (2026-10-21)

From the files in `Exmaple Content/`.

### Playback audio: `AUDIO FILES/LTC + AUDIO - AUTUMN 2026 90' V4.1_48_24.wav` (and V4.2)
- 48 kHz / 24-bit stereo WAV, 88:50 long. Plain `fmt`/`data` chunks: no BWF `bext` or `iXML`, so there's no timecode or metadata in the header.
- **Channel 1 is programme audio; channel 2 is LTC at 25 fps**, non-drop-frame. It is easy to spot: the signal is almost perfectly even, like a square wave.
- TC is **one block per song**, not continuous. Scanning every 10s gives this map (file time → TC start):

| File time | TC block | | File time | TC block |
|---|---|---|---|---|
| 0:00 | 02:00 | | 43:40 | 04:30 |
| 5:40 | 01:30 | | 48:20 | 00:30 |
| 10:40 | 00:20 | | 55:20 | 03:30 |
| 14:20 | 04:00 | | 58:50 | 05:00 |
| 18:00 | 09:00 | | 61:40 | 10:00 |
| 22:20 | 22:00 | | 66:20 | 23:00 |
| 26:50 | 11:00 | | 74:20 | 21:00 |
| 30:50 | 11:30 | | 79:00 | 02:30 |
| 34:00 | 18:00 | | 84:30 | 20:00 |
| 38:50 | 00:10 | | | |

  That's 19 blocks, so probably 19 songs or cues. Times are within the 10s scan step; a real import would find the exact frame.
- V4.1 and V4.2 are byte-for-byte identical because they were duplicated to build the example pack. Real version labels are trusted. A real V4.1 → V4.2 pair is needed to test compare mode.
- This is the **continuous** case: one file for the whole set with seamless transitions (a DJ-style set). The more common delivery is one audio file per song.

### Show records: `SHOW RECORDS/`
| File | Video | Audio | Timecode |
|---|---|---|---|
| Record A: full show with TC | 1080p H.264 23.976, 6.5 Mbps, 89 min, 4.2 GB | Stereo AAC: ch1 programme, **ch2 LTC** | No tmcd track. **LTC on ch2 decodes cleanly and follows the same TC block map as the playback.** Burned-in TC is present and matches the LTC to within 1 frame. Garbled LTC in the first and last ~40s |
| Record B: wide record, no TC | 1080p H.264 23.976, 6.5 Mbps, 95 min, 4.5 GB | Stereo AAC, ch1 effectively silent, programme on ch2 | None. Wide record with on-screen overlays. Manual marking |
| Record C: content record | 1080p H.264 **60 fps** Main, 5 Mbps, 105 min, 3.9 GB, letterboxed | Stereo AAC, **silent** | None. A media server output record. Manual marking (or later, matching against content files) |

Implications:
- LTC in an audio channel is the main way records carry timecode; a tmcd track is the exception.
- The app must decode LTC itself, decide which channel holds it, and handle silent or one-sided audio.
- Video frame rate ≠ TC rate, so clip boundaries come from the file time where each LTC frame was decoded.
- Records are already proxy-sized; no transcode is needed just to scrub them.

### Depence renders: `DEPENCE RENDERS FOLDER/`
- 54 JPEGs, 4096×2160 sRGB, 0.5–1.1 MB each, about 50 MB in total.
- Two filename series: `DEF VID DEVELOPMENT[_n]` (7, 19 June) and `DEF VIDEO DEVELOPMENT - PATCHED[_n]` (47, 23 June). These are Depence scene name plus a counter, with **no song names**.
- Many consecutive frames are small variations of the same look, which is exactly what the cull and stack UI is for.
- No exact duplicates.

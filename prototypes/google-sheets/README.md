# Google Sheets prototype

Proves the Google side of the design (DESIGN.md §8) before the real app is built. It publishes a show to a Google Sheet in the Pixelmappers house style, pulls collaborator edits back, reads comments, and shares the sheet. It tests risks **R1** (comment anchors), **R2** (protected ranges for link editors) and **R3** (images in the sheet).

`show.json` plays the part of the app's data. It's created from `sample_show.json` (a made-up sample show) on first run. Edit it by hand to act as "the app".

## What it builds

**SHOW SHEET tab**
- Black banner with the logo and show name, a department colour band, then column labels.
- Running order, then a **SONG ARCHIVE** divider, then archived songs.
- Status checkboxes, gel colour swatches, a render thumbnail per song, and "Cont." for segues.
- Hidden column A holds song IDs and hidden row 1 holds column IDs, so sync matches cells by ID rather than position.
- The whole tab is protected **except the ✎ columns** (CONTENT NOTES and CAMERA DIRECTION in the sample).

**Notes tabs** (GLOBAL NOTES, 16/10 PM NOTES)
- Every column is editable, with a song dropdown and a DONE checkbox.
- Collaborators can add notes in the empty rows below.

**Drive folder** `<show> — PM Show Sheet/` holding the sheet and `media/` (renders downsized to 1600px, plus the logo).

## Google Cloud setup (once, about 10 minutes)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (for example "PM Show Sheet") under the Pixelmappers Workspace.
2. **APIs & Services → Library**: enable **Google Sheets API**, **Google Drive API** and **Google Slides API**.
3. **OAuth consent screen**: choose **Internal**, so only Pixelmappers accounts can sign in and Google verification isn't needed. Add the scope `…/auth/drive.file`.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Download the JSON and save it here as `credentials.json`. It's ignored by git; don't share it.

## Run

```bash
cd "prototypes/google-sheets"
```
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
```bash
.venv/bin/python selftest.py
```
```bash
.venv/bin/python cli.py dry-run
```
```bash
.venv/bin/python cli.py publish
```

The first `publish` opens a browser to sign in with your Pixelmappers Google account. The token is stored in `.state/token.json`. `publish` prints the sheet URL; `status` shows it again.

| Command | Does |
|---|---|
| `publish [--image-mode private\|public] [--image-url lh3\|thumbnail\|uc]` | Create the sheet or update it in place. Rows are matched by ID and moved, inserted or deleted, never rebuilt |
| `slides [--image-url …]` | Build or refresh the deck: cover, running order, one slide per song (render, demo clip, notes marked `on_slide`). Images are link-public only during insertion |
| `pull` | Bring sheet edits into `show.json`: ✎ cells, notes edits, new note rows. Reports conflicts and protected-cell changes |
| `sync` | `pull` then `publish`, which is what the app's sync worker will do |
| `comments` / `comments reply ID TEXT` / `comments resolve ID [TEXT]` | List comments with their raw anchor and inferred cell; reply or resolve |
| `share link --role commenter\|writer\|reader` | Anyone with the link gets that role |
| `share invite EMAIL --role … [--no-notify]` | Invite one person by email. Also gives them view access to `media/`, so images load for them |
| `share uninvite EMAIL` | Remove that person from the sheet and from `media/` |
| `share revoke-link` | Turn off link sharing; invited people keep access |

## Test script

Work through these and note the results in DESIGN.md §11.

**R2: protected ranges and link editors**
1. `cli.py share link --role writer`
2. Open the link in a browser signed into a **different, non-Pixelmappers** Google account.
3. Try to edit LIGHTING NOTES (should be blocked), insert a row or column in SHOW SHEET (should be blocked), and type in CAMERA DIRECTION (should work).
4. Add a note in an empty row of `16/10 PM NOTES` and tick DONE on another note.
5. `cli.py pull`. Expect `accepted` for the camera direction edit and the tick, `new_notes` for the added row (its ID appears in hidden column A), and no `protected_changed`.

**Conflict handling**
1. Edit `cam_dir` for Glass Hall in `show.json`, and edit the same cell in the sheet to something different.
2. `cli.py pull` should report a conflict and keep the app value; the conflict is saved in `show.json → conflicts`.

**R1: comment anchors**
1. As the second account, comment on a CAMERA DIRECTION cell, a song NAME cell, an empty cell and a notes row.
2. `cli.py comments`. For each comment, record whether `anchor (raw)` is usable and whether `inferred cells` (matched on quoted text) found the right song.
3. Try `comments reply` and `comments resolve`, and check they show up in the sheet.
4. Change the running order in `show.json` (swap two songs), run `publish`, and check whether the **comments moved with their rows**. Rows are moved with `moveDimension`, so they should.

**R3: images**
1. `publish` (default `--image-mode private`). Do the render thumbnails show for you, and for the second account?
2. `publish --image-mode public`, which makes each image viewable by anyone with its link. Check both accounts again.
3. If the thumbnails stay blank, try `--image-url thumbnail` and `--image-url uc`.
4. Decide: is "unlisted public link" acceptable for unreleased renders? If not, the real app needs another approach (for example images only in Slides, or links instead of thumbnails).

**Scope check**
Everything above runs on `drive.file`, Google's narrowest Drive permission, which covers only files this app created. If any step fails with 403/insufficient scope, note which one.

## Files

| File | Role |
|---|---|
| `layout.py` | Show → tab grids → Sheets API requests (house style, IDs, protections, validation). Pure |
| `sync_logic.py` | Row reconcile (move/insert/delete), three-way pull for show and notes tabs, comment-to-cell inference. Pure |
| `model.py` | Show JSON helpers, the published snapshot |
| `ops.py` | Google calls: Drive folder and files, image upload, publish, pull, comments, sharing |
| `gclient.py` | OAuth sign-in (`drive.file` scope) |
| `cli.py` | Commands above |
| `selftest.py` | Offline tests of layout and sync logic against a simulated sheet |

## Known limits (prototype)
- Columns are fixed once a tab exists. Adding or removing columns isn't reconciled yet.
- Polling only runs when you run `pull`; there's no sync lock.
- Images are re-uploaded only when the file's modified time changes.

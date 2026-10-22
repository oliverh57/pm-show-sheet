"""Talks to Google: publish, pull, comments, sharing. The decisions live in sync_logic/layout."""
from __future__ import annotations

import contextlib
import subprocess
import tempfile
import time
from pathlib import Path

import layout
import model
import slides_layout
import sync_logic

FOLDER_MIME = "application/vnd.google-apps.folder"
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
SLIDES_MIME = "application/vnd.google-apps.presentation"
FIRST_TAB_ID = 1001


# --- Drive files ---------------------------------------------------------------

def ensure_drive_files(drive, show: dict, state: dict) -> None:
    if not state.get("folder_id"):
        f = drive.files().create(body={"name": f"{show['name']} — PM Show Sheet", "mimeType": FOLDER_MIME},
                                 fields="id").execute()
        state["folder_id"] = f["id"]
    if not state.get("media_folder_id"):
        f = drive.files().create(body={"name": "media", "mimeType": FOLDER_MIME, "parents": [state["folder_id"]]},
                                 fields="id").execute()
        state["media_folder_id"] = f["id"]
    if not state.get("spreadsheet_id"):
        f = drive.files().create(body={"name": f"{show['name']} | SHOW SHEET", "mimeType": SHEET_MIME,
                                       "parents": [state["folder_id"]]},
                                 fields="id,webViewLink").execute()
        state["spreadsheet_id"], state["sheet_url"] = f["id"], f["webViewLink"]
        state["tabs"] = {}
    if not state.get("owner_email"):
        state["owner_email"] = drive.about().get(fields="user(emailAddress)").execute()["user"]["emailAddress"]


def image_url(file_id: str, style: str) -> str:
    return {
        "lh3": f"https://lh3.googleusercontent.com/d/{file_id}",
        "thumbnail": f"https://drive.google.com/thumbnail?id={file_id}&sz=w1000",
        "uc": f"https://drive.google.com/uc?export=view&id={file_id}",
    }[style]


def upload_image(drive, state: dict, path: Path, mode: str, style: str) -> str | None:
    """Upload (or re-upload if changed) a still into the show's media folder; return an =IMAGE() URL."""
    from googleapiclient.http import MediaFileUpload

    if not path.exists():
        print(f"  ! image not found, skipped: {path}")
        return None
    images = state.setdefault("images", {})
    key = str(path.resolve())
    rec = images.get(key)
    mtime = path.stat().st_mtime
    if not rec or rec["mtime"] != mtime:
        with tempfile.TemporaryDirectory() as tmp:
            src = path
            if path.suffix.lower() in (".jpg", ".jpeg"):
                src = Path(tmp) / (path.stem + ".jpg")  # downsized copy: renders are 4096px
                subprocess.run(["sips", "-Z", "1600", str(path), "--out", str(src)], check=True, capture_output=True)
            media = MediaFileUpload(str(src), resumable=False)
            if rec:
                drive.files().update(fileId=rec["file_id"], media_body=media).execute()
            else:
                f = drive.files().create(body={"name": path.name, "parents": [state["media_folder_id"]]},
                                         media_body=media, fields="id").execute()
                rec = {"file_id": f["id"], "public": False}
        rec["mtime"] = mtime
        images[key] = rec
        print(f"  ↑ uploaded {path.name}")
    if mode == "keep":
        pass
    elif mode == "public" and not rec["public"]:
        drive.permissions().create(fileId=rec["file_id"], body={"type": "anyone", "role": "reader", "allowFileDiscovery": False}).execute()
        rec["public"] = True
    elif mode == "private" and rec["public"]:
        drive.permissions().delete(fileId=rec["file_id"], permissionId="anyoneWithLink").execute()
        rec["public"] = False
    return image_url(rec["file_id"], style)


# --- Sheets helpers --------------------------------------------------------------

def a1(title: str) -> str:
    return "'" + title.replace("'", "''") + "'"


def tab_titles(sheets, ssid: str) -> dict[int, str]:
    meta = sheets.spreadsheets().get(spreadsheetId=ssid, fields="sheets(properties(sheetId,title))").execute()
    return {s["properties"]["sheetId"]: s["properties"]["title"] for s in meta["sheets"]}


def read_tab(sheets, ssid: str, title: str) -> list[list]:
    res = sheets.spreadsheets().values().get(spreadsheetId=ssid, range=a1(title),
                                             valueRenderOption="UNFORMATTED_VALUE").execute()
    return res.get("values", [])


def read_row_ids(sheets, ssid: str, title: str, header: int) -> list[str]:
    res = sheets.spreadsheets().values().get(spreadsheetId=ssid, range=a1(title) + f"!A{header + 1}:A",
                                             valueRenderOption="UNFORMATTED_VALUE").execute()
    return [model.normalize(r[0]) if r else "" for r in res.get("values", [])]


def grids_for(show: dict, image_urls: dict, logo_url: str | None) -> list[tuple[str, layout.TabGrid]]:
    grids = [("show", layout.show_tab(show, image_urls, logo_url))]
    grids += [(f"session:{s['id']}", layout.notes_tab(show, s)) for s in show["sessions"]]
    return grids


# --- publish / pull --------------------------------------------------------------

def publish(sheets, drive, show_path: Path, show: dict, state: dict, image_mode: str, url_style: str) -> None:
    ensure_drive_files(drive, show, state)
    ssid = state["spreadsheet_id"]
    base = show_path.parent

    image_urls = {}
    for song in show["songs"].values():
        if song.get("hero"):
            url = upload_image(drive, state, base / song["hero"], image_mode, url_style)
            if url:
                image_urls[song["hero"]] = url
    logo = show.get("branding", {}).get("logo")
    logo_url = upload_image(drive, state, base / logo, image_mode, url_style) if logo else None

    existing = tab_titles(sheets, ssid)
    tabs = state.setdefault("tabs", {})
    next_id = max([FIRST_TAB_ID - 1, *existing, *tabs.values()]) + 1
    requests = []
    for key, grid in grids_for(show, image_urls, logo_url):
        sid = tabs.get(key)
        if sid is None or sid not in existing:
            sid, next_id = next_id, next_id + 1
            tabs[key] = sid
            requests += layout.structure_requests(grid, sid, state["owner_email"])
            print(f"  + new tab '{grid.title}'")
        else:
            if existing[sid] != grid.title:
                requests.append({"updateSheetProperties": {"properties": {"sheetId": sid, "title": grid.title}, "fields": "title"}})
            current = read_row_ids(sheets, ssid, existing[sid], grid.header_count)
            ops, _ = sync_logic.reconcile_rows(current, grid.row_ids)
            if ops:
                print(f"  ~ '{grid.title}': {len(ops)} row move/insert/delete")
            requests += layout.reconcile_requests(ops, sid, grid.header_count)
        requests += layout.content_requests(grid, sid)

    stale = [k for k in tabs if k.startswith("session:") and k.split(":", 1)[1] not in {s["id"] for s in show["sessions"]}]
    for k in stale:
        print(f"  ! tab for removed session kept (may hold collaborator notes): {existing.get(tabs[k], k)}")
    if 0 in existing and 0 not in tabs.values():
        requests.append({"deleteSheet": {"sheetId": 0}})  # the default 'Sheet1'

    sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": requests}).execute()
    state["last_pushed"] = model.snapshot(show)
    print(f"Published {len(requests)} requests → {state['sheet_url']}")


def pull(sheets, show: dict, state: dict) -> list[tuple[str, dict]]:
    ssid = state["spreadsheet_id"]
    last = state.setdefault("last_pushed", {})
    titles = tab_titles(sheets, ssid)
    reports = []
    for key, sid in state.get("tabs", {}).items():
        title = titles.get(sid)
        if title is None:
            reports.append((key, {"error": "tab was deleted in the sheet"}))
            continue
        values = read_tab(sheets, ssid, title)
        if key == "show":
            reports.append((title, sync_logic.diff_show_tab(show, last, values)))
            continue
        session = next((s for s in show["sessions"] if f"session:{s['id']}" == key), None)
        if session is None:
            continue
        report, id_writes = sync_logic.diff_notes_tab(show, session, last, values)
        if id_writes:
            data = [{"range": a1(title) + f"!A{r + 1}", "values": [[nid]]} for r, nid in id_writes]
            sheets.spreadsheets().values().batchUpdate(spreadsheetId=ssid, body={"valueInputOption": "RAW", "data": data}).execute()
        reports.append((title, report))
    return reports


# --- comments --------------------------------------------------------------------

COMMENT_FIELDS = ("comments(id,content,anchor,quotedFileContent,resolved,createdTime,"
                  "author(displayName,emailAddress),replies(id,content,action,author(displayName)))")


def list_comments(sheets, drive, show: dict, state: dict) -> list[dict]:
    ssid = state["spreadsheet_id"]
    comments, token = [], None
    while True:
        res = drive.comments().list(fileId=ssid, fields=f"nextPageToken,{COMMENT_FIELDS}", pageSize=100,
                                    pageToken=token, includeDeleted=False).execute()
        comments += res.get("comments", [])
        token = res.get("nextPageToken")
        if not token:
            break
    titles = tab_titles(sheets, ssid)
    tab_values = {t: read_tab(sheets, ssid, t) for t in titles.values()}
    out = []
    for c in comments:
        quoted = (c.get("quotedFileContent") or {}).get("value", "")
        hits = sync_logic.infer_comment_cells(tab_values, quoted)
        song_ids = {h["row_id"] for h in hits if h["row_id"] in show["songs"]}
        out.append({
            "id": c["id"], "author": c.get("author", {}).get("displayName", "?"), "content": c.get("content", ""),
            "resolved": c.get("resolved", False), "anchor_raw": c.get("anchor"), "quoted": quoted,
            "inferred_cells": hits, "song_id": song_ids.pop() if len(song_ids) == 1 else None,
            "replies": [{"author": r.get("author", {}).get("displayName", "?"), "content": r.get("content", ""),
                         "action": r.get("action")} for r in c.get("replies", [])],
        })
    show["comments"] = out
    return out


def reply_comment(drive, state: dict, comment_id: str, text: str, resolve: bool = False) -> None:
    body = {"content": text}
    if resolve:
        body["action"] = "resolve"
    drive.replies().create(fileId=state["spreadsheet_id"], commentId=comment_id, body=body, fields="id").execute()


# --- sharing ---------------------------------------------------------------------

def share_link(drive, state: dict, role: str) -> None:
    drive.permissions().create(fileId=state["spreadsheet_id"],
                               body={"type": "anyone", "role": role, "allowFileDiscovery": False}).execute()


def invite(drive, state: dict, email: str, role: str, notify: bool) -> None:
    """Share the sheet, and the media folder as viewer: =IMAGE() loads with the viewer's own access."""
    drive.permissions().create(fileId=state["spreadsheet_id"], sendNotificationEmail=notify,
                               body={"type": "user", "role": role, "emailAddress": email}).execute()
    drive.permissions().create(fileId=state["media_folder_id"], sendNotificationEmail=False,
                               body={"type": "user", "role": "reader", "emailAddress": email}).execute()


def uninvite(drive, state: dict, email: str) -> list[str]:
    removed = []
    for key in ("spreadsheet_id", "media_folder_id"):
        perms = drive.permissions().list(fileId=state[key], fields="permissions(id,emailAddress)").execute()
        for p in perms.get("permissions", []):
            if (p.get("emailAddress") or "").lower() == email.lower():
                drive.permissions().delete(fileId=state[key], permissionId=p["id"]).execute()
                removed.append(key)
    return removed


def revoke_link(drive, state: dict) -> None:
    drive.permissions().delete(fileId=state["spreadsheet_id"], permissionId="anyoneWithLink").execute()


# --- slides ----------------------------------------------------------------------

def ensure_deck(drive, show: dict, state: dict) -> None:
    if not state.get("presentation_id"):
        f = drive.files().create(body={"name": f"{show['name']} | SHOW DECK", "mimeType": SLIDES_MIME,
                                       "parents": [state["folder_id"]]},
                                 fields="id,webViewLink").execute()
        state["presentation_id"], state["slides_url"] = f["id"], f["webViewLink"]


def upload_clip(drive, state: dict, base: Path, clip: dict) -> str | None:
    """Cut a low-quality 720p H.264 copy of a record section and upload it to media/."""
    from googleapiclient.http import MediaFileUpload

    src = base / clip["source"]
    if not src.exists():
        print(f"  ! clip source not found, skipped: {src}")
        return None
    key = f"{src.resolve()}|{clip['in']}|{clip['out']}"
    clips = state.setdefault("clips", {})
    if key in clips:
        return clips[key]["file_id"]
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / f"{src.stem}_{int(clip['in'])}-{int(clip['out'])}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-ss", str(clip["in"]), "-t", str(clip["out"] - clip["in"]), "-i", str(src),
                        "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k",
                        "-maxrate", "3000k", "-bufsize", "5000k", "-c:a", "aac", "-b:a", "128k",
                        "-movflags", "+faststart", str(out)], check=True)
        size_mb = out.stat().st_size / 1e6
        f = drive.files().create(body={"name": out.name, "parents": [state["media_folder_id"]]},
                                 media_body=MediaFileUpload(str(out), mimetype="video/mp4", resumable=True),
                                 fields="id").execute()
    clips[key] = {"file_id": f["id"]}
    print(f"  ↑ uploaded clip {out.name} ({size_mb:.1f} MB)")
    return f["id"]


@contextlib.contextmanager
def temporarily_public(drive, file_ids: list[str]):
    """Slides can only insert an image from a URL Google can fetch, and it keeps its own copy.
    So: open each image to anyone-with-link for the insert, then close it again, even on failure."""
    opened = []
    try:
        for fid in file_ids:
            drive.permissions().create(fileId=fid, body={"type": "anyone", "role": "reader", "allowFileDiscovery": False}).execute()
            opened.append(fid)
        if opened:
            time.sleep(2)  # let the permission propagate before Slides fetches
        yield
    finally:
        for fid in opened:
            with contextlib.suppress(Exception):
                drive.permissions().delete(fileId=fid, permissionId="anyoneWithLink").execute()
        if opened:
            print(f"  ✓ {len(opened)} images were link-public only while inserting, now private again")


def publish_slides(slides, drive, show_path: Path, show: dict, state: dict, url_style: str) -> None:
    from googleapiclient.errors import HttpError

    ensure_drive_files(drive, show, state)
    ensure_deck(drive, show, state)
    base = show_path.parent
    images = state.setdefault("images", {})

    def image(path_str: str) -> tuple[str | None, str | None]:
        path = base / path_str
        url = upload_image(drive, state, path, "keep", url_style)
        rec = images.get(str(path.resolve()))
        return url, (rec["file_id"] if rec and not rec.get("public") else None)

    image_urls, to_open = {}, set()
    for sid in show["set_order"]:
        hero = show["songs"][sid].get("hero")
        if hero:
            url, fid = image(hero)
            if url:
                image_urls[hero] = url
            if fid:
                to_open.add(fid)
    logo_url = None
    if show.get("branding", {}).get("logo"):
        logo_url, fid = image(show["branding"]["logo"])
        if fid:
            to_open.add(fid)
    video_ids = {}
    for sid in show["set_order"]:
        clip = show["songs"][sid].get("clip")
        if clip:
            vid = upload_clip(drive, state, base, clip)
            if vid:
                video_ids[sid] = vid

    pres = slides.presentations().get(presentationId=state["presentation_id"],
                                      fields="slides(objectId,pageElements(objectId))").execute()
    existing = {s["objectId"]: [e["objectId"] for e in s.get("pageElements", [])] for s in pres.get("slides", [])}
    rev = state.get("slides_rev", 0) + 1
    requests = slides_layout.build(show, rev, image_urls, logo_url, video_ids, existing)

    with temporarily_public(drive, sorted(to_open)):
        for attempt in range(3):
            try:
                slides.presentations().batchUpdate(presentationId=state["presentation_id"], body={"requests": requests}).execute()
                break
            except HttpError as e:
                if attempt == 2 or "image" not in str(e).lower():
                    raise
                print(f"  … image fetch failed, retrying ({e.reason})")
                time.sleep(3)
    state["slides_rev"] = rev
    print(f"Published {len(requests)} slide requests → {state['slides_url']}")

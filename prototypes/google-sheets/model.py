"""Show data helpers. The show JSON file stands in for the app's data store."""
from __future__ import annotations

import json
import secrets
import time
from pathlib import Path

NOTE_FIELDS = ["song", "note", "tc", "from", "assignee", "done"]
ARCHIVE_ROW_ID = "__archive"


def new_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}{secrets.token_hex(2)}"


def load_json(path: Path) -> dict:
    return json.loads(Path(path).read_text())


def save_json(path: Path, data: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def normalize(v):
    """Make a sheet value and an app value comparable."""
    if isinstance(v, bool):
        return v
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def as_bool(v) -> bool:
    return v is True or str(v).strip().upper() == "TRUE"


# --- songs -----------------------------------------------------------------

def row_order(show: dict) -> list[str]:
    """Row ids for the SHOW SHEET tab: running order, divider, archive."""
    return list(show["set_order"]) + [ARCHIVE_ROW_ID] + list(show["archive"])


def prev_song(show: dict, song_id: str) -> dict | None:
    for ids in (show["set_order"], show["archive"]):
        if song_id in ids:
            i = ids.index(song_id)
            return show["songs"][ids[i - 1]] if i > 0 else None
    return None


def song_value(col: dict, song: dict, prev: dict | None = None):
    kind, cid = col.get("type", "text"), col["id"]
    if kind == "tick":
        return bool(song.get("statuses", {}).get(cid, False))
    if kind == "colour":
        swatches = song.get("colours", [])
        i = col.get("index", 0)
        return swatches[i].get("label", "") if i < len(swatches) else ""
    if kind == "image":
        return ""
    if kind == "tc" and prev and prev.get("segues_into_next"):
        return "Cont."
    return song.get("fields", {}).get(cid, "")


def set_song_value(col: dict, song: dict, value) -> None:
    kind, cid = col.get("type", "text"), col["id"]
    if kind == "tick":
        song.setdefault("statuses", {})[cid] = as_bool(value)
    elif kind in ("colour", "image"):
        raise ValueError(f"column {cid} ({kind}) is not editable from the sheet")
    else:
        song.setdefault("fields", {})[cid] = value


def find_song_by_name(show: dict, name: str) -> str | None:
    key = name.strip().lower()
    for sid, song in show["songs"].items():
        if song.get("fields", {}).get("name", "").strip().lower() == key:
            return sid
    return None


# --- notes -----------------------------------------------------------------

def note_value(show: dict, note: dict, field: str):
    if field == "song":
        sid = note.get("song_id")
        if sid and sid in show["songs"]:
            return show["songs"][sid]["fields"].get("name", "")
        return note.get("song_name", "")
    if field == "note":
        return note.get("text", "")
    if field == "done":
        return bool(note.get("done", False))
    return note.get(field, "")


def set_note_value(show: dict, note: dict, field: str, value) -> None:
    if field == "song":
        name = normalize(value)
        sid = find_song_by_name(show, name) if name else None
        note["song_id"] = sid
        if name and not sid:
            note["song_name"] = name  # unmatched: keep what was typed
        else:
            note.pop("song_name", None)
    elif field == "note":
        note["text"] = value
    elif field == "done":
        note["done"] = as_bool(value)
    else:
        note[field] = value


def snapshot(show: dict) -> dict:
    """Every value as published, keyed so pull can do a three-way compare."""
    last = {}
    for rid in show["set_order"] + show["archive"]:
        song, prev = show["songs"][rid], prev_song(show, rid)
        for col in show["columns"]:
            last[f"show|{rid}|{col['id']}"] = normalize(song_value(col, song, prev))
    for session in show["sessions"]:
        for note in session["notes"]:
            for f in NOTE_FIELDS:
                last[f"notes|{note['id']}|{f}"] = normalize(note_value(show, note, f))
    return last

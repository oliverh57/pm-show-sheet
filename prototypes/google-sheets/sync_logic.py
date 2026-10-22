"""Sync decisions, kept free of network calls so selftest.py can exercise them offline."""
from __future__ import annotations

import layout
import model


def reconcile_rows(current: list[str], desired: list[str]) -> tuple[list[tuple], list[str]]:
    """Ops that turn the sheet's row ids into the desired order, moving rows rather than
    rewriting them so anything attached to a row (comments, collaborator formatting) moves too.

    Rows with a blank id are left alone; rows whose id is no longer wanted are deleted.
    """
    ops, cur = [], list(current)
    for i, rid in enumerate(desired):
        if i < len(cur) and cur[i] == rid:
            continue
        if rid in cur[i:]:
            p = cur.index(rid, i)
            ops.append(("move", p, i))
            cur.insert(i, cur.pop(p))
        else:
            ops.append(("insert", i))
            cur.insert(i, rid)
    wanted = set(desired)
    for j in range(len(cur) - 1, len(desired) - 1, -1):
        if cur[j] and cur[j] not in wanted:
            ops.append(("delete", j))
            cur.pop(j)
    return ops, cur


def _cell(row: list, i: int | None):
    return row[i] if i is not None and i < len(row) else ""


def _empty_report() -> dict:
    return {"accepted": [], "conflicts": [], "protected_changed": [], "unknown_rows": [],
            "missing_rows": [], "new_notes": []}


def _three_way(key, sheet_v, local_v, last, on_accept, where, report, show):
    """Sheet changed since publish: take it if the app didn't change too, else flag a conflict."""
    pushed = last.get(key)
    if pushed is None or sheet_v == pushed:
        return
    if local_v == pushed:
        on_accept()
        last[key] = sheet_v
        report["accepted"].append(where)
    elif local_v == sheet_v:
        last[key] = sheet_v
    else:
        report["conflicts"].append(where)
        show.setdefault("conflicts", {})[key] = {"sheet": sheet_v, "app": local_v, "published": pushed}


def diff_show_tab(show: dict, last: dict, values: list[list]) -> dict:
    """Compare the SHOW SHEET tab (as read back) with the app; apply accepted edits to `show`."""
    report = _empty_report()
    if not values:
        report["missing_rows"] = model.row_order(show)
        return report
    colpos = {cid: i for i, cid in enumerate(values[0]) if cid}
    seen = set()
    for r, row in enumerate(values[layout.SHOW_HEADER_ROWS:], start=layout.SHOW_HEADER_ROWS):
        rid = model.normalize(row[0]) if row else ""
        if rid == model.ARCHIVE_ROW_ID:
            continue
        song = show["songs"].get(rid) if rid else None
        if not song:
            if any(model.normalize(v) != "" for v in row):
                report["unknown_rows"].append({"row": r + 1, "id": rid, "values": [v for v in row[1:] if v != ""]})
            continue
        seen.add(rid)
        prev = model.prev_song(show, rid)
        for col in show["columns"]:
            # Image cells hold =IMAGE() formulas; their read-back value is the fetch result (or #REF!), not data.
            if col["id"] not in colpos or col.get("type") == "image":
                continue
            raw = _cell(row, colpos.get(col["id"]))
            sheet_v = model.as_bool(raw) if col.get("type") == "tick" else model.normalize(raw)
            local_v = model.normalize(model.song_value(col, song, prev))
            key = f"show|{rid}|{col['id']}"
            where = {"row": r + 1, "song": song["fields"].get("name", rid), "column": col["label"],
                     "sheet": sheet_v, "published": last.get(key), "app": local_v}
            if not col.get("editable"):
                if key in last and sheet_v != last[key]:
                    report["protected_changed"].append(where)
                continue
            _three_way(key, sheet_v, local_v, last,
                       lambda c=col, s=song, v=sheet_v: model.set_song_value(c, s, v),
                       where, report, show)
    report["missing_rows"] = [rid for rid in show["set_order"] + show["archive"] if rid not in seen]
    return report


def diff_notes_tab(show: dict, session: dict, last: dict, values: list[list]) -> tuple[dict, list[tuple[int, str]]]:
    """Compare a notes tab with the app. Rows without an id become new notes.

    Returns the report and (row_index, new_id) pairs to write back into the hidden id column.
    """
    report = _empty_report()
    id_writes = []
    if not values:
        return report, id_writes
    colpos = {cid: i for i, cid in enumerate(values[0]) if cid}
    notes = {n["id"]: n for n in session["notes"]}
    seen = set()
    for r, row in enumerate(values[layout.NOTES_HEADER_ROWS:], start=layout.NOTES_HEADER_ROWS):
        rid = model.normalize(row[0]) if row else ""
        vals = {}
        for f in model.NOTE_FIELDS:
            raw = _cell(row, colpos.get(f))
            vals[f] = model.as_bool(raw) if f == "done" else model.normalize(raw)
        if not rid:
            if vals["note"] == "":
                continue
            note = {"id": model.new_id("note"), "source": "sheet", "done": False}
            for f in model.NOTE_FIELDS:
                model.set_note_value(show, note, f, vals[f])
            session["notes"].append(note)
            for f in model.NOTE_FIELDS:
                last[f"notes|{note['id']}|{f}"] = model.normalize(model.note_value(show, note, f))
            id_writes.append((r, note["id"]))
            report["new_notes"].append({"row": r + 1, "song": vals["song"], "note": vals["note"], "from": vals["from"]})
            continue
        note = notes.get(rid)
        if not note:
            report["unknown_rows"].append({"row": r + 1, "id": rid})
            continue
        seen.add(rid)
        for f in model.NOTE_FIELDS:
            key = f"notes|{rid}|{f}"
            local_v = model.normalize(model.note_value(show, note, f))
            where = {"row": r + 1, "note": note.get("text", ""), "field": f,
                     "sheet": vals[f], "published": last.get(key), "app": local_v}
            _three_way(key, vals[f], local_v, last,
                       lambda f=f, v=vals[f]: model.set_note_value(show, note, f, v),
                       where, report, show)
    report["missing_rows"] = [n["id"] for n in session["notes"] if n["id"] not in seen and n["id"] not in {i for _, i in id_writes}]
    return report, id_writes


def infer_comment_cells(tabs: dict[str, list[list]], quoted: str) -> list[dict]:
    """Fallback for unreliable anchors: find the cells whose value matches the comment's quoted text."""
    target = model.normalize(quoted)
    if not target:
        return []
    hits = []
    for title, values in tabs.items():
        col_ids = values[0] if values else []
        for r, row in enumerate(values):
            for c, v in enumerate(row):
                if c > 0 and r > 0 and model.normalize(v) == target:
                    hits.append({"tab": title, "row": r + 1, "row_id": model.normalize(row[0]) if row else "",
                                 "col_id": col_ids[c] if c < len(col_ids) else ""})
    return hits

"""Offline checks of layout and sync logic against a simulated sheet. Run: python selftest.py"""
import copy
import json

import layout
import model
import sync_logic

show = model.load_json("sample_show.json")


def fresh():
    s = copy.deepcopy(show)
    return s, model.snapshot(s)


def sheet_values(s):
    return layout.plain_values(layout.show_tab(s, {}, None))


def find(values, row_id, col_id):
    r = next(i for i, row in enumerate(values) if row and row[0] == row_id)
    return r, values[0].index(col_id)


# 1. Layout shape
g = layout.show_tab(show, {}, None)
assert g.col_ids[0] == "__id" and g.row_ids == model.row_order(show), "row order"
assert all(len(r) == len(g.col_ids) for r in g.header_rows + g.data_rows), "ragged rows"
assert g.data_rows[g.row_ids.index("s_seven")][g.col_ids.index("tc")].value == "Cont.", "segue → Cont."
for r0, r1, c0, c1 in g.merges:
    assert c1 <= g.frozen_cols or c0 >= g.frozen_cols, f"merge {c0}-{c1} crosses frozen columns"
json.dumps(layout.structure_requests(g, 1, "x@y") + layout.content_requests(g, 1))
print("ok  layout")

# 2. Row reconcile
cases = [
    (["a", "b", "c"], ["a", "b", "c"], []),
    (["a", "b", "c"], ["c", "a", "b"], [("move", 2, 0)]),
    (["a", "c"], ["a", "b", "c"], [("insert", 1)]),
    (["a", "x", "b"], ["a", "b"], [("move", 2, 1), ("delete", 2)]),
    (["a", "", "b"], ["a", "b"], [("move", 2, 1)]),
]
for cur, want, expect in cases:
    ops, final = sync_logic.reconcile_rows(cur, want)
    assert ops == expect, (cur, want, ops)
    assert [x for x in final if x][: len(want)] == want
print("ok  reconcile")

# 3. Collaborator edits an editable cell → accepted into the app
s, last = fresh()
v = sheet_values(s)
r, c = find(v, "s_glass", "cam_dir")
v[r][c] = "Cameras back in for final chorus"
rep = sync_logic.diff_show_tab(s, last, v)
assert len(rep["accepted"]) == 1 and s["songs"]["s_glass"]["fields"]["cam_dir"] == "Cameras back in for final chorus"
assert last["show|s_glass|cam_dir"] == "Cameras back in for final chorus"
print("ok  editable cell accepted")

# 4. A protected cell changed (protection bypassed / owner edit) → reported, not applied
s, last = fresh()
v = sheet_values(s)
r, c = find(v, "s_glass", "lx_notes")
v[r][c] = "hacked"
rep = sync_logic.diff_show_tab(s, last, v)
assert len(rep["protected_changed"]) == 1 and s["songs"]["s_glass"]["fields"]["lx_notes"] != "hacked"
print("ok  protected change flagged")

# 5. Both sides changed → conflict, app value kept
s, last = fresh()
v = sheet_values(s)
r, c = find(v, "s_lights", "content_notes")
v[r][c] = "sheet version"
s["songs"]["s_lights"]["fields"]["content_notes"] = "app version"
rep = sync_logic.diff_show_tab(s, last, v)
assert len(rep["conflicts"]) == 1 and s["songs"]["s_lights"]["fields"]["content_notes"] == "app version"
assert "show|s_lights|content_notes" in s["conflicts"]
print("ok  conflict kept app value")

# 6. Rows moved by sorting/filtering don't matter: matched by id
s, last = fresh()
v = sheet_values(s)
body = v[layout.SHOW_HEADER_ROWS:]
v = v[: layout.SHOW_HEADER_ROWS] + list(reversed(body))
rep = sync_logic.diff_show_tab(s, last, v)
assert not any(rep[k] for k in ("accepted", "conflicts", "protected_changed", "missing_rows")), rep
print("ok  row order independent")

# 6b. =IMAGE() cells read back as their fetch result (e.g. #REF! before "Allow access") → ignored
s, last = fresh()
v = sheet_values(s)
r, c = find(v, "s_lights", "hero")
v[r][c] = "#REF! (Please use a desktop web browser to allow access to fetch data from external urls.)"
rep = sync_logic.diff_show_tab(s, last, v)
assert not rep["protected_changed"], rep
print("ok  image cells ignored")

# 7. Notes tab: collaborator adds a row (no id) and ticks done on another
s, last = fresh()
session = next(x for x in s["sessions"] if x["id"] == "sess_1610pm")
v = layout.plain_values(layout.notes_tab(s, session))
v[layout.NOTES_HEADER_ROWS + 1][v[0].index("done")] = True
v.append(["", "Tide Line", "Strobe hit late on drop", "05:01:30:00", "MP", "Lighting", False])
rep, writes = sync_logic.diff_notes_tab(s, session, last, v)
assert len(rep["new_notes"]) == 1 and len(writes) == 1 and writes[0][0] == len(v) - 1
new = session["notes"][-1]
assert new["song_id"] == "s_tide" and new["text"] == "Strobe hit late on drop"
assert session["notes"][1]["done"] is True and len(rep["accepted"]) == 1
print("ok  notes: new row + done tick")

# 8. Comment inference from quoted text
tabs = {"SHOW SHEET": sheet_values(show)}
hits = sync_logic.infer_comment_cells(tabs, "Portrait framing. Long lens on the singer")
assert hits and hits[0]["row_id"] == "s_tide" and hits[0]["col_id"] == "cam_dir"
print("ok  comment cell inference")

# 9. Slides: valid unique ids, text ranges inside their text, republish keeps slides and redraws
import re
import slides_layout

urls = {s["hero"]: "https://x.invalid/i.jpg" for s in show["songs"].values() if s.get("hero")}
reqs = slides_layout.build(show, 1, urls, "https://x.invalid/logo.png", {"s_lights": "vid"}, {"p": []}, today="T")
ids, text_len = [], {}
for r in reqs:
    body = next(iter(r.values()))
    if "objectId" in body and next(iter(r)) in ("createSlide", "createShape", "createImage", "createVideo"):
        ids.append(body["objectId"])
    if "insertText" in r:
        text_len[body["objectId"]] = slides_layout.utf16_len(body["text"])
    if "updateTextStyle" in r and body["textRange"]["type"] == "FIXED_RANGE":
        assert 0 <= body["textRange"]["startIndex"] < body["textRange"]["endIndex"] <= text_len[body["objectId"]], body
assert len(ids) == len(set(ids)), "duplicate object ids"
assert all(5 <= len(i) <= 50 and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_\-:]*", i) for i in ids), ids
assert {"deleteObject": {"objectId": "p"}} in reqs, "default slide removed"
assert sum("createVideo" in r for r in reqs) == 1
existing = {sid: [f"pm1_{sid[len(slides_layout.SLIDE_PREFIX):]}_1"] for sid, _, _ in slides_layout.slide_order(show)}
again = slides_layout.build(show, 2, urls, None, {}, existing, today="T")
assert not any("createSlide" in r for r in again), "republish must keep existing slides"
assert sum("deleteObject" in r for r in again) == len(existing), "old elements deleted"
print("ok  slides")

print("\nall selftests passed")

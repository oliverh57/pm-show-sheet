"""Turns a show into Google Sheets API requests. Pure functions: no network access here."""
from __future__ import annotations

from dataclasses import dataclass, field

import model

SHOW_TAB = "SHOW SHEET"
SHOW_HEADER_ROWS = 4   # 0: column ids (hidden) · 1: banner · 2: department band · 3: labels
NOTES_HEADER_ROWS = 3  # 0: column ids (hidden) · 1: banner · 2: labels
SPARE_ROWS = 100

# House style
FONT_HEAD = "Lexend"  # accent font
FONT_BODY = "Roboto"
FONT_MONO = "Roboto Mono"
BLACK, WHITE, GREY = "#000000", "#FFFFFF", "#8C8C8C"
LABEL_BG = "#1A1A1A"
EDITABLE_LABEL_BG = "#FFD84D"
EDITABLE_CELL_BG = "#FFF8DC"
ARCHIVE_DIVIDER_BG = "#111111"
ARCHIVE_ROW_BG = "#F2F2F2"
DEPT_COLOURS = {
    "CORE": "#000000", "STATUS": "#262626", "COLOUR": "#3A3A3A", "CONTENT": "#5B3FD9",
    "LX": "#D9881E", "VIDEO": "#1E9C8A", "CAMERAS": "#C8323A", "STAGING": "#3A6FD9",
    "SFX": "#7A7A7A", "MD": "#9C3FA6",
}
NOTE_COLUMNS = [  # (field, label, width)
    ("song", "SONG", 200), ("note", "NOTE", 420), ("tc", "TC", 110),
    ("from", "FROM", 80), ("assignee", "ASSIGNED TO", 120), ("done", "DONE", 60),
]


def rgb(hex_: str) -> dict:
    h = hex_.lstrip("#")
    return {"red": int(h[0:2], 16) / 255, "green": int(h[2:4], 16) / 255, "blue": int(h[4:6], 16) / 255}


def text_on(hex_: str) -> str:
    c = rgb(hex_)
    return BLACK if 0.299 * c["red"] + 0.587 * c["green"] + 0.114 * c["blue"] > 0.6 else WHITE


@dataclass
class Cell:
    value: str | bool | None = None
    formula: str | None = None
    bg: str | None = None
    fg: str | None = None
    bold: bool = False
    size: int | None = None
    font: str | None = None
    wrap: bool = False
    halign: str | None = None

    def plain(self):
        """What a values.get(UNFORMATTED_VALUE) read returns for this cell."""
        if self.formula:
            return ""
        return "" if self.value is None else self.value

    def api(self) -> dict:
        d = {}
        if self.formula:
            d["userEnteredValue"] = {"formulaValue": self.formula}
        elif isinstance(self.value, bool):
            d["userEnteredValue"] = {"boolValue": self.value}
        elif self.value not in (None, ""):
            d["userEnteredValue"] = {"stringValue": str(self.value)}
        tf = {"fontFamily": self.font or FONT_BODY}
        if self.fg:
            tf["foregroundColor"] = rgb(self.fg)
        if self.bold:
            tf["bold"] = True
        if self.size:
            tf["fontSize"] = self.size
        fmt = {"verticalAlignment": "MIDDLE", "textFormat": tf, "wrapStrategy": "WRAP" if self.wrap else "CLIP"}
        if self.bg:
            fmt["backgroundColor"] = rgb(self.bg)
        if self.halign:
            fmt["horizontalAlignment"] = self.halign
        d["userEnteredFormat"] = fmt
        return d


@dataclass
class TabGrid:
    title: str
    col_ids: list[str]               # col 0 is the hidden "__id" column
    header_rows: list[list[Cell]]
    row_ids: list[str]               # data row ids, top to bottom
    data_rows: list[list[Cell]]
    col_widths: list[int]
    frozen_cols: int
    tab_colour: str
    merges: list[tuple[int, int, int, int]] = field(default_factory=list)  # header merges: r0, r1, c0, c1 (end-exclusive)
    tick_cols: list[int] = field(default_factory=list)
    list_validations: dict[int, list[str]] = field(default_factory=dict)
    editable_cols: list[int] = field(default_factory=list)
    unbounded_validation: bool = False  # notes tabs: collaborators add rows below the data
    data_row_height: int | None = None
    row_heights: dict[str, int] = field(default_factory=dict)

    @property
    def header_count(self) -> int:
        return len(self.header_rows)


def _runs(keys: list, start: int, split_at: int | None = None):
    """Yield (start, end, key) for runs of equal keys, never crossing split_at."""
    i = 0
    while i < len(keys):
        j = i
        while j + 1 < len(keys) and keys[j + 1] == keys[i] and (split_at is None or start + j + 1 != split_at):
            j += 1
        yield start + i, start + j + 1, keys[i]
        i = j + 1


def _id_cell(v: str) -> Cell:
    return Cell(v, fg=GREY, size=7)


def show_tab(show: dict, image_urls: dict[str, str], logo_url: str | None) -> TabGrid:
    cols = show["columns"]
    col_ids = ["__id"] + [c["id"] for c in cols]
    n = len(col_ids)
    name_ci = col_ids.index("name")
    frozen = name_ci + 1

    ids_row = [_id_cell(c) for c in col_ids]

    banner = [Cell(bg=BLACK) for _ in range(n)]
    if logo_url:
        banner[1] = Cell(formula=f'=IMAGE("{logo_url}")', bg=BLACK)
    else:
        banner[1] = Cell("PIXELMAPPERS", bg=BLACK, fg=WHITE, bold=True, font=FONT_HEAD, size=16)
    banner[frozen] = Cell(f"{show['name']}  |  SHOW SHEET", bg=BLACK, fg=WHITE, bold=True, font=FONT_HEAD, size=18)
    merges = [(1, 2, 1, frozen), (1, 2, frozen, n)]

    depts = [c.get("dept", "CORE") for c in cols]
    dept_row = [Cell(bg=BLACK)] + [Cell(bg=DEPT_COLOURS.get(d, BLACK)) for d in depts]
    for c0, c1, d in _runs(depts, 1, split_at=frozen):
        dept_row[c0] = Cell("" if d == "CORE" else d, bg=DEPT_COLOURS.get(d, BLACK), fg=WHITE, bold=True, font=FONT_HEAD, size=10, halign="CENTER")
        if c1 - c0 > 1:
            merges.append((2, 3, c0, c1))

    label_row = [Cell(bg=LABEL_BG)]
    for c in cols:
        if c.get("editable"):
            label_row.append(Cell(f"✎ {c['label']}", bg=EDITABLE_LABEL_BG, fg=BLACK, bold=True, font=FONT_HEAD, size=9, wrap=True, halign="CENTER"))
        else:
            label_row.append(Cell(c["label"], bg=LABEL_BG, fg=WHITE, bold=True, font=FONT_HEAD, size=9, wrap=True, halign="CENTER"))
    labels = [c["label"] for c in cols]
    for c0, c1, _ in _runs(labels, 1, split_at=frozen):
        if c1 - c0 > 1:
            merges.append((3, 4, c0, c1))

    def song_row(song: dict, prev: dict | None, archived: bool) -> list[Cell]:
        row = [_id_cell(song["id"])]
        for c in cols:
            v = model.song_value(c, song, prev)
            base_bg = ARCHIVE_ROW_BG if archived else (EDITABLE_CELL_BG if c.get("editable") else None)
            kind = c.get("type", "text")
            if kind == "tick":
                row.append(Cell(v, bg=base_bg, halign="CENTER"))
            elif kind == "colour":
                swatches = song.get("colours", [])
                i = c.get("index", 0)
                if i < len(swatches):
                    hx = swatches[i]["hex"]
                    row.append(Cell(v, bg=hx, fg=text_on(hx), size=7, halign="CENTER"))
                else:
                    row.append(Cell("", bg=base_bg))
            elif kind == "image":
                url = image_urls.get(song.get("hero", ""))
                row.append(Cell(formula=f'=IMAGE("{url}")', bg=base_bg) if url else Cell("", bg=base_bg))
            elif kind == "tc":
                row.append(Cell(v, bg=base_bg, font=FONT_MONO, size=9, halign="CENTER"))
            elif c["id"] == "name":
                row.append(Cell(v, bg=base_bg, bold=True, wrap=True))
            else:
                row.append(Cell(v, bg=base_bg, wrap=kind == "longtext", size=9 if kind == "longtext" else None))
        return row

    row_ids, data_rows = [], []
    for ids, archived in ((show["set_order"], False), (show["archive"], True)):
        if archived:
            divider = [_id_cell(model.ARCHIVE_ROW_ID)] + [Cell(bg=ARCHIVE_DIVIDER_BG) for _ in cols]
            divider[name_ci] = Cell("SONG ARCHIVE", bg=ARCHIVE_DIVIDER_BG, fg=WHITE, bold=True, font=FONT_HEAD)
            row_ids.append(model.ARCHIVE_ROW_ID)
            data_rows.append(divider)
        prev = None
        for sid in ids:
            song = show["songs"][sid]
            row_ids.append(sid)
            data_rows.append(song_row(song, prev, archived))
            prev = song

    has_images = any(c.get("type") == "image" for c in cols)
    return TabGrid(
        title=SHOW_TAB,
        col_ids=col_ids,
        header_rows=[ids_row, banner, dept_row, label_row],
        row_ids=row_ids,
        data_rows=data_rows,
        col_widths=[60] + [c.get("width", 120) for c in cols],
        frozen_cols=frozen,
        tab_colour=BLACK,
        merges=merges,
        tick_cols=[i for i, c in enumerate(cols, start=1) if c.get("type") == "tick"],
        editable_cols=[i for i, c in enumerate(cols, start=1) if c.get("editable")],
        data_row_height=110 if has_images else 48,
        row_heights={model.ARCHIVE_ROW_ID: 28},
    )


def notes_tab(show: dict, session: dict) -> TabGrid:
    col_ids = ["__id"] + [f for f, _, _ in NOTE_COLUMNS]
    n = len(col_ids)
    ids_row = [_id_cell(c) for c in col_ids]
    banner = [Cell(bg=BLACK) for _ in range(n)]
    banner[1] = Cell(f"{show['name']}  |  {session['label']}", bg=BLACK, fg=WHITE, bold=True, font=FONT_HEAD, size=16)
    label_row = [Cell(bg=LABEL_BG)] + [
        Cell(f"✎ {label}", bg=EDITABLE_LABEL_BG, fg=BLACK, bold=True, font=FONT_HEAD, size=9, halign="CENTER")
        for _, label, _ in NOTE_COLUMNS
    ]
    rows = []
    for note in session["notes"]:
        row = [_id_cell(note["id"])]
        for f, _, _ in NOTE_COLUMNS:
            v = model.note_value(show, note, f)
            if f == "done":
                row.append(Cell(v, halign="CENTER"))
            elif f == "tc":
                row.append(Cell(v, font=FONT_MONO, size=9))
            else:
                row.append(Cell(v, wrap=f == "note"))
        rows.append(row)
    song_names = [show["songs"][sid]["fields"]["name"] for sid in show["set_order"] + show["archive"]]
    return TabGrid(
        title=session["label"],
        col_ids=col_ids,
        header_rows=[ids_row, banner, label_row],
        row_ids=[nt["id"] for nt in session["notes"]],
        data_rows=rows,
        col_widths=[60] + [w for _, _, w in NOTE_COLUMNS],
        frozen_cols=0,
        tab_colour="#FFD84D",
        merges=[(1, 2, 1, n)],
        tick_cols=[col_ids.index("done")],
        list_validations={col_ids.index("song"): song_names},
        editable_cols=list(range(1, n)),
        unbounded_validation=True,
    )


def plain_values(grid: TabGrid) -> list[list]:
    return [[c.plain() for c in row] for row in grid.header_rows + grid.data_rows]


# --- requests ----------------------------------------------------------------

def _range(sid, r0=None, r1=None, c0=None, c1=None) -> dict:
    gr = {"sheetId": sid}
    for k, v in (("startRowIndex", r0), ("endRowIndex", r1), ("startColumnIndex", c0), ("endColumnIndex", c1)):
        if v is not None:
            gr[k] = v
    return gr


def _dim(sid, dimension, start, end, props, fields) -> dict:
    return {"updateDimensionProperties": {
        "range": {"sheetId": sid, "dimension": dimension, "startIndex": start, "endIndex": end},
        "properties": props, "fields": fields}}


def _update_cells(sid, row_index, rows: list[list[Cell]]) -> dict:
    return {"updateCells": {
        "start": {"sheetId": sid, "rowIndex": row_index, "columnIndex": 0},
        "rows": [{"values": [c.api() for c in row]} for row in rows],
        "fields": "userEnteredValue,userEnteredFormat"}}


def structure_requests(g: TabGrid, sid: int, owner_email: str) -> list[dict]:
    """One-off requests for a brand-new tab: create, merge, size, hide, protect."""
    n = len(g.col_ids)
    reqs = [{"addSheet": {"properties": {
        "sheetId": sid, "title": g.title, "tabColor": rgb(g.tab_colour),
        "gridProperties": {
            "rowCount": g.header_count + len(g.data_rows) + SPARE_ROWS, "columnCount": n,
            "frozenRowCount": g.header_count, "frozenColumnCount": g.frozen_cols}}}}]
    for r0, r1, c0, c1 in g.merges:
        reqs.append({"mergeCells": {"range": _range(sid, r0, r1, c0, c1), "mergeType": "MERGE_ALL"}})
    for i, w in enumerate(g.col_widths):
        reqs.append(_dim(sid, "COLUMNS", i, i + 1, {"pixelSize": w}, "pixelSize"))
    reqs.append(_dim(sid, "COLUMNS", 0, 1, {"hiddenByUser": True}, "hiddenByUser"))
    reqs.append(_dim(sid, "ROWS", 0, 1, {"hiddenByUser": True}, "hiddenByUser"))
    reqs.append(_dim(sid, "ROWS", 1, 2, {"pixelSize": 64}, "pixelSize"))
    reqs.append({"addProtectedRange": {"protectedRange": {
        "range": {"sheetId": sid},
        "description": "Managed by PM Show Sheet. Only the ✎ columns are editable.",
        "warningOnly": False,
        "editors": {"users": [owner_email]},
        "unprotectedRanges": [_range(sid, g.header_count, None, c, c + 1) for c in g.editable_cols],
    }}})
    return reqs


def content_requests(g: TabGrid, sid: int) -> list[dict]:
    """Requests sent on every publish: header text, every data row, validation, row heights."""
    reqs = [_update_cells(sid, 0, g.header_rows)]
    if g.data_rows:
        reqs.append(_update_cells(sid, g.header_count, g.data_rows))
    end = None if g.unbounded_validation else g.header_count + len(g.data_rows)
    for ci in g.tick_cols:
        reqs.append({"setDataValidation": {
            "range": _range(sid, g.header_count, end, ci, ci + 1),
            "rule": {"condition": {"type": "BOOLEAN"}}}})
    for ci, options in g.list_validations.items():
        reqs.append({"setDataValidation": {
            "range": _range(sid, g.header_count, end, ci, ci + 1),
            "rule": {"condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": o} for o in options]},
                     "showCustomUi": True, "strict": False}}})
    if g.data_rows and g.data_row_height:
        reqs.append(_dim(sid, "ROWS", g.header_count, g.header_count + len(g.data_rows), {"pixelSize": g.data_row_height}, "pixelSize"))
    for rid, px in g.row_heights.items():
        if rid in g.row_ids:
            r = g.header_count + g.row_ids.index(rid)
            reqs.append(_dim(sid, "ROWS", r, r + 1, {"pixelSize": px}, "pixelSize"))
    return reqs


def reconcile_requests(ops: list[tuple], sid: int, header: int) -> list[dict]:
    """Turn sync_logic.reconcile_rows ops into row insert/move/delete requests."""
    reqs = []
    for op in ops:
        if op[0] == "move":
            _, p, i = op
            reqs.append({"moveDimension": {
                "source": {"sheetId": sid, "dimension": "ROWS", "startIndex": header + p, "endIndex": header + p + 1},
                "destinationIndex": header + i}})
        elif op[0] == "insert":
            _, i = op
            reqs.append({"insertDimension": {
                "range": {"sheetId": sid, "dimension": "ROWS", "startIndex": header + i, "endIndex": header + i + 1},
                "inheritFromBefore": True}})
        elif op[0] == "delete":
            _, j = op
            reqs.append({"deleteDimension": {
                "range": {"sheetId": sid, "dimension": "ROWS", "startIndex": header + j, "endIndex": header + j + 1}}})
    return reqs

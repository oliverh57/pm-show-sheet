"""Turns a show into Google Slides API requests: cover, running order, one slide per song. Pure."""
from __future__ import annotations

import datetime as dt
import math

import layout
import model
from layout import BLACK, DEPT_COLOURS, FONT_BODY, FONT_HEAD, FONT_MONO, WHITE

W, H = 720, 405  # default 16:9 page, points
MUTED = "#9A9A9A"
SLIDE_PREFIX = "pm_slide_"


def utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def style(font=FONT_BODY, size=10, colour=WHITE, bold=False) -> dict:
    return {"font": font, "size": size, "colour": colour, "bold": bold}


def _colour(hex_: str) -> dict:
    return {"rgbColor": layout.rgb(hex_)}


def _element(page: str, x, y, w, h) -> dict:
    return {"pageObjectId": page,
            "size": {"width": {"magnitude": w, "unit": "PT"}, "height": {"magnitude": h, "unit": "PT"}},
            "transform": {"scaleX": 1, "scaleY": 1, "translateX": x, "translateY": y, "unit": "PT"}}


class SlideBuilder:
    """Collects the requests that draw one slide. Element ids are prefixed per publish so a
    republish can delete the old elements and draw new ones in the same batch."""

    def __init__(self, page_id: str, prefix: str):
        self.page, self.prefix, self.n, self.reqs = page_id, prefix, 0, []

    def _id(self) -> str:
        self.n += 1
        return f"{self.prefix}_{self.n}"

    def background(self, hex_: str):
        self.reqs.append({"updatePageProperties": {
            "objectId": self.page,
            "pageProperties": {"pageBackgroundFill": {"solidFill": {"color": _colour(hex_)}}},
            "fields": "pageBackgroundFill.solidFill.color"}})

    def text(self, x, y, w, h, runs: list[tuple[str, dict]], align: str | None = None):
        runs = [(t, s) for t, s in runs if t]
        if not runs:
            return
        oid = self._id()
        self.reqs.append({"createShape": {"objectId": oid, "shapeType": "TEXT_BOX", "elementProperties": _element(self.page, x, y, w, h)}})
        self.reqs.append({"insertText": {"objectId": oid, "text": "".join(t for t, _ in runs), "insertionIndex": 0}})
        pos = 0
        for t, s in runs:
            n = utf16_len(t)
            self.reqs.append({"updateTextStyle": {
                "objectId": oid,
                "textRange": {"type": "FIXED_RANGE", "startIndex": pos, "endIndex": pos + n},
                "style": {"fontFamily": s["font"], "fontSize": {"magnitude": s["size"], "unit": "PT"},
                          "foregroundColor": {"opaqueColor": _colour(s["colour"])}, "bold": s["bold"]},
                "fields": "fontFamily,fontSize,foregroundColor,bold"}})
            pos += n
        if align:
            self.reqs.append({"updateParagraphStyle": {"objectId": oid, "textRange": {"type": "ALL"},
                                                       "style": {"alignment": align}, "fields": "alignment"}})

    def rect(self, x, y, w, h, fill: str):
        oid = self._id()
        self.reqs.append({"createShape": {"objectId": oid, "shapeType": "RECTANGLE", "elementProperties": _element(self.page, x, y, w, h)}})
        self.reqs.append({"updateShapeProperties": {
            "objectId": oid,
            "shapeProperties": {"shapeBackgroundFill": {"solidFill": {"color": _colour(fill)}},
                                "outline": {"propertyState": "NOT_RENDERED"}},
            "fields": "shapeBackgroundFill.solidFill.color,outline.propertyState"}})

    def image(self, x, y, w, h, url: str):
        self.reqs.append({"createImage": {"objectId": self._id(), "url": url, "elementProperties": _element(self.page, x, y, w, h)}})

    def video(self, x, y, w, h, drive_file_id: str):
        self.reqs.append({"createVideo": {"objectId": self._id(), "source": "DRIVE", "id": drive_file_id,
                                          "elementProperties": _element(self.page, x, y, w, h)}})


def slide_order(show: dict) -> list[tuple[str, str, str | None]]:
    """(slide object id, kind, song id). Song slides follow the running order; archived songs get none."""
    out = [(f"{SLIDE_PREFIX}cover", "cover", None), (f"{SLIDE_PREFIX}setlist", "setlist", None)]
    out += [(f"{SLIDE_PREFIX}{sid}", "song", sid) for sid in show["set_order"]]
    return out


def cover_slide(show: dict, b: SlideBuilder, logo_url: str | None, today: str):
    b.background(BLACK)
    if logo_url:
        b.image(210, 110, 300, 110, logo_url)
    b.text(40, 245, W - 80, 44, [(show["name"], style(FONT_HEAD, 24, WHITE, True))], align="CENTER")
    b.text(40, 292, W - 80, 20, [(f"SHOW DECK  ·  {today}", style(FONT_MONO, 10, MUTED))], align="CENTER")


def setlist_slide(show: dict, b: SlideBuilder, logo_url: str | None):
    b.background(BLACK)
    b.text(28, 18, 500, 34, [("RUNNING ORDER", style(FONT_HEAD, 22, WHITE, True))])
    tc_col = next((c for c in show["columns"] if c.get("type") == "tc"), None)
    rows = []
    prev = None
    for sid in show["set_order"]:
        song = show["songs"][sid]
        tc = model.song_value(tc_col, song, prev) if tc_col else ""
        rows.append((song["fields"].get("num", ""), song["fields"].get("name", ""), tc, song.get("segues_into_next")))
        prev = song
    half = math.ceil(len(rows) / 2)
    for ci, chunk in enumerate((rows[:half], rows[half:])):
        runs = []
        for num, name, tc, segue in chunk:
            runs += [(f"{num:>3}  ", style(FONT_MONO, 10, MUTED)), (name, style(FONT_HEAD, 11, WHITE, True)),
                     (f"   {tc}" + ("  →" if segue else "") + "\n", style(FONT_MONO, 9, MUTED))]
        if runs:
            t, s = runs[-1]
            runs[-1] = (t.rstrip("\n"), s)
        b.text(28 + ci * 340, 64, 330, 310, runs)
    if logo_url:
        b.image(28, 383, 64, 12, logo_url)


def song_slide(show: dict, song: dict, prev: dict | None, b: SlideBuilder,
               image_url: str | None, video_id: str | None, logo_url: str | None):
    f = song.get("fields", {})
    b.background(BLACK)
    b.text(28, 16, 330, 20, [(f"#{f.get('num', '')}", style(FONT_HEAD, 13, MUTED, True))])
    name = f.get("name", "")
    size = 26 if len(name) <= 16 else 20 if len(name) <= 24 else 16  # Lexend runs wide: keep names on one line
    b.text(28, 34, 336, 66, [(name, style(FONT_HEAD, size, WHITE, True))])

    tc_col = next((c for c in show["columns"] if c.get("type") == "tc"), None)
    tc = model.song_value(tc_col, song, prev) if tc_col else ""
    meta = [x for x in (f"AUDIO {f['audio']}" if f.get("audio") else "", f"TC {tc}" if tc else "",
                        "SEGUES INTO NEXT" if song.get("segues_into_next") else "") if x]
    b.text(28, 100, 336, 16, [("  ·  ".join(meta), style(FONT_MONO, 9, MUTED))])

    y = 122
    swatches = song.get("colours", [])[:4]
    for i, sw in enumerate(swatches):
        x = 28 + i * 48
        b.rect(x, y, 40, 22, sw["hex"])
        b.text(x - 6, y + 22, 52, 14, [(sw.get("label", ""), style(FONT_BODY, 7, MUTED))], align="CENTER")
    if f.get("colref"):
        b.text(28 + len(swatches) * 48, y + 2, 336 - len(swatches) * 48, 20, [(f["colref"], style(FONT_BODY, 9, WHITE))])
    if swatches or f.get("colref"):
        y += 44

    runs = []
    for col in show["columns"]:
        v = f.get(col["id"]) if col.get("on_slide") else None
        if v:
            runs += [(col["label"] + "\n", style(FONT_HEAD, 8, DEPT_COLOURS.get(col.get("dept"), MUTED), True)),
                     (v + "\n\n", style(FONT_BODY, 9, WHITE))]
    if runs:
        t, s = runs[-1]
        runs[-1] = (t.rstrip("\n"), s)
        b.text(28, y, 336, 376 - y, runs)

    if image_url:
        b.image(374, 22, 320, 180, image_url)
    if video_id:
        b.video(374, 212, 320, 180, video_id)
    if logo_url:
        b.image(28, 383, 64, 12, logo_url)


def build(show: dict, rev: int, image_urls: dict[str, str], logo_url: str | None, video_ids: dict[str, str],
          existing: dict[str, list[str]], today: str | None = None) -> list[dict]:
    """Requests to bring the deck in line with the show.

    `existing` maps each current slide id to its element ids. App slides are kept (so comments
    on them survive) and redrawn; slides the app doesn't want are deleted; order is enforced.
    """
    today = today or dt.date.today().strftime("%d %b %Y").upper()
    desired = slide_order(show)
    ids = [sid for sid, _, _ in desired]
    reqs = []
    for sid in ids:
        if sid not in existing:
            reqs.append({"createSlide": {"objectId": sid, "slideLayoutReference": {"predefinedLayout": "BLANK"}}})
        else:
            reqs += [{"deleteObject": {"objectId": el}} for el in existing[sid]]
    reqs += [{"deleteObject": {"objectId": sid}} for sid in existing if sid not in ids]
    reqs += [{"updateSlidesPosition": {"slideObjectIds": [sid], "insertionIndex": i}} for i, sid in enumerate(ids)]

    for sid, kind, song_id in desired:
        b = SlideBuilder(sid, f"pm{rev}_{sid[len(SLIDE_PREFIX):]}")
        if kind == "cover":
            cover_slide(show, b, logo_url, today)
        elif kind == "setlist":
            setlist_slide(show, b, logo_url)
        else:
            song = show["songs"][song_id]
            song_slide(show, song, model.prev_song(show, song_id), b,
                       image_urls.get(song.get("hero", "")), video_ids.get(song_id), logo_url)
        reqs += b.reqs
    return reqs

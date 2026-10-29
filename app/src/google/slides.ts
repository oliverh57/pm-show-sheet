// The SHOW DECK: cover, running order, one slide per song. Show → Slides API requests.
// Ported from prototypes/google-sheets/slides_layout.py. Pure: no network here.
import { cellValue, clipLabel, columnClips, deptColour as customColour, fieldSwatches, onSlide, songImage } from "../model/ops";
import type { ColourSwatch, ColumnDef, Show, Song } from "../model/types";
import { DEPT_COLOURS, LOGO_URL, rgb } from "./sheet";

const W = 720; // default 16:9 page, points
const FONT_HEAD = "Lexend", FONT_BODY = "Roboto", FONT_MONO = "Roboto Mono";
const BLACK = "#000000", WHITE = "#FFFFFF", MUTED = "#9A9A9A";
export const SLIDE_PREFIX = "pm_slide_";
const LAYOUT = 6; // bump when the slide layout changes, so open decks redraw on the next sync

interface Style { font: string; size: number; colour: string; bold: boolean; link?: string }
const style = (font = FONT_BODY, size = 10, colour = WHITE, bold = false, link?: string): Style => ({ font, size, colour, bold, link });
const colour = (hex: string) => ({ rgbColor: rgb(hex) });
const utf16Len = (s: string) => s.length; // JS strings are UTF-16 already
/** Where a Drive file plays in the browser. */
export const playUrl = (fileId: string) => `https://drive.google.com/file/d/${fileId}/view`;
const LOGO_ASPECT = 512 / 188;

function element(page: string, x: number, y: number, w: number, h: number) {
  return { pageObjectId: page, size: { width: { magnitude: w, unit: "PT" }, height: { magnitude: h, unit: "PT" } },
    transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "PT" } };
}

/** Collects the requests that draw one slide. Element ids are prefixed per push so a redraw can delete the old ones in the same batch. */
class SlideBuilder {
  n = 0;
  reqs: object[] = [];
  constructor(private page: string, private prefix: string) {}
  private id() { return `${this.prefix}_${++this.n}`; }

  background(hex: string) {
    this.reqs.push({ updatePageProperties: { objectId: this.page, pageProperties: { pageBackgroundFill: { solidFill: { color: colour(hex) } } }, fields: "pageBackgroundFill.solidFill.color" } });
  }

  text(x: number, y: number, w: number, h: number, runsIn: [string, Style][], align?: "CENTER") {
    const runs = runsIn.filter(([t]) => t);
    if (!runs.length) return;
    const oid = this.id();
    this.reqs.push({ createShape: { objectId: oid, shapeType: "TEXT_BOX", elementProperties: element(this.page, x, y, w, h) } });
    this.reqs.push({ insertText: { objectId: oid, text: runs.map(([t]) => t).join(""), insertionIndex: 0 } });
    let pos = 0;
    for (const [t, s] of runs) {
      const n = utf16Len(t);
      this.reqs.push({ updateTextStyle: { objectId: oid, textRange: { type: "FIXED_RANGE", startIndex: pos, endIndex: pos + n },
        style: { fontFamily: s.font, fontSize: { magnitude: s.size, unit: "PT" }, foregroundColor: { opaqueColor: colour(s.colour) }, bold: s.bold,
          ...(s.link ? { link: { url: s.link }, underline: true } : {}) },
        fields: `fontFamily,fontSize,foregroundColor,bold${s.link ? ",link,underline" : ""}` } });
      pos += n;
    }
    if (align) this.reqs.push({ updateParagraphStyle: { objectId: oid, textRange: { type: "ALL" }, style: { alignment: align }, fields: "alignment" } });
  }

  rect(x: number, y: number, w: number, h: number, fill: string) {
    const oid = this.id();
    this.reqs.push({ createShape: { objectId: oid, shapeType: "RECTANGLE", elementProperties: element(this.page, x, y, w, h) } });
    this.reqs.push({ updateShapeProperties: { objectId: oid,
      shapeProperties: { shapeBackgroundFill: { solidFill: { color: colour(fill) } }, outline: { propertyState: "NOT_RENDERED" } },
      fields: "shapeBackgroundFill.solidFill.color,outline.propertyState" } });
  }

  image(x: number, y: number, w: number, h: number, url: string) {
    this.reqs.push({ createImage: { objectId: this.id(), url, elementProperties: element(this.page, x, y, w, h) } });
  }

  /** A Drive video, played in the deck. Whoever plays it needs to be able to see the file on Drive. */
  video(x: number, y: number, w: number, h: number, fileId: string) {
    this.reqs.push({ createVideo: { objectId: this.id(), source: "DRIVE", id: fileId, elementProperties: element(this.page, x, y, w, h) } });
  }
}

type SlideKind = ["cover" | "setlist", null] | ["song", string];

export function slideOrder(show: Show): [string, ...SlideKind][] {
  return [
    [`${SLIDE_PREFIX}cover`, "cover", null],
    [`${SLIDE_PREFIX}setlist`, "setlist", null],
    ...show.set_order.map((id): [string, "song", string] => [`${SLIDE_PREFIX}${id}`, "song", id]),
  ];
}

// Slides pads every text box by 0.1" and the API can't change it, so shapes drawn beside text step in by this much to line up.
const INSET = 7.2;
const CHIP_W = 48, CHIP_H = 22, CHIP_STEP = 56;

// Slides can't shrink text to fit from the API, so text is measured here. Rough average glyph widths, in ems.
const EM: Record<string, number> = { [FONT_HEAD]: 0.68, [FONT_BODY]: 0.48, [FONT_MONO]: 0.6 };
const LINE = 1.2; // line height, in ems

/** About how tall runs of text wrap to across `w` points (inside the box's padding). */
export function textHeight(runs: [string, Style][], w: number): number {
  let h = 0, x = 0, line = 0; // line: the biggest size on the line being laid out
  const wrap = () => { h += line * LINE; x = 0; line = 0; };
  for (const [t, s] of runs) {
    const em = (EM[s.font] ?? 0.5) * s.size;
    t.split("\n").forEach((para, i) => {
      if (i) wrap();
      line = Math.max(line, s.size);
      for (const word of para.split(/(\s+)/)) {
        const ww = word.length * em;
        if (!/^\s*$/.test(word) && x > 0 && x + ww > w) { wrap(); line = s.size; }
        x += ww;
        while (x > w) { h += line * LINE; x -= w; } // a word wider than the box breaks
      }
    });
  }
  return h + line * LINE;
}

/** The runs, drawn smaller (down to two-thirds size) until they fit a w × h text box. */
function fitted(runs: [string, Style][], w: number, h: number): [string, Style][] {
  for (let k = 1; ; k -= 0.05) {
    const scaled = runs.map(([t, s]): [string, Style] => [t, { ...s, size: Math.round(s.size * k * 2) / 2 }]);
    if (k < 0.7 || textHeight(scaled, w - 2 * INSET) <= h - 2 * INSET) return scaled;
  }
}

/** `text` cut short with "…" to at most `max` characters. */
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

type Tile = { col: ColumnDef; name?: string } & ({ image: string; video?: undefined } | { video: string; image?: undefined });

/**
 * Pictures and videos down the right of a song slide, as big as fit above `bottom`: one a row, or two or three across,
 * each under its column's name. A lone picture fills the 16:9 frame. Returns the y below them.
 */
function mediaTiles(b: SlideBuilder, show: Show, tiles: Tile[], bottom: number): number {
  const X = 374, Y = 22, AREA_W = 320, LABEL = 12, GAP = 8;
  if (!tiles.length) return Y;
  if (tiles.length === 1 && tiles[0].image) {
    b.image(X, Y, AREA_W, 180, tiles[0].image);
    return Y + 186;
  }
  let across = 1, w = 0;
  for (let n = 1; n <= 3; n++) {
    const rows = Math.ceil(tiles.length / n);
    const h = (bottom - Y - rows * LABEL - (rows - 1) * GAP) / rows;
    const fit = Math.min((AREA_W - (n - 1) * GAP) / n, (h * 16) / 9);
    if (fit > w + 1) { across = n; w = fit; }
  }
  const h = (w * 9) / 16;
  tiles.forEach((t, i) => {
    const x = X + (i % across) * (w + GAP), y = Y + Math.floor(i / across) * (LABEL + h + GAP);
    const head = style(FONT_HEAD, 8, deptColour(show, t.col), true), name = style(FONT_MONO, 7, WHITE);
    const room = Math.floor((w - t.col.label.length * EM[FONT_HEAD] * 8) / (EM[FONT_MONO] * 7)) - 2;
    b.text(x - INSET, y - 4, w + 2 * INSET, 16, [[t.col.label, head], ...(t.name && room > 3 ? [[`  ${cut(t.name, room)}`, name] as [string, Style]] : [])]);
    if (t.image) b.image(x, y + LABEL, w, h, t.image);
    else b.video(x, y + LABEL, w, h, t.video!);
  });
  return Y + Math.ceil(tiles.length / across) * (LABEL + h + GAP);
}

const LEFT = 28, LEFT_END = 364; // the left column of a song slide

interface ColourSection { heading: string; headingColour: string; swatches: ColourSwatch[]; aside?: string }

/** How wide a colour section is. With `aside` text it takes the rest of the row. */
const sectionWidth = (sec: ColourSection, x: number) =>
  sec.aside ? LEFT_END - x : Math.max(sec.heading.length * EM[FONT_HEAD] * 8 + 2 * INSET, sec.swatches.length * CHIP_STEP) + 16;

/**
 * A heading with a row of colour chips under it, each named underneath; `aside` is text after the chips.
 * Slides can't draw a pie, so a multi-colour swatch draws as stripes. Returns the y below it.
 */
function colourSection(b: SlideBuilder, x0: number, y: number, { heading, headingColour, swatches, aside }: ColourSection): number {
  b.text(x0, y, sectionWidth({ heading, headingColour, swatches, aside }, x0), 20, [[heading, style(FONT_HEAD, 8, headingColour, true)]]);
  const top = y + 22;
  swatches.forEach((sw, i) => {
    const x = x0 + INSET + i * CHIP_STEP;
    if (sw.pie?.length) sw.pie.forEach((c, j, all) => b.rect(x + (j * CHIP_W) / all.length, top, CHIP_W / all.length, CHIP_H, c));
    else b.rect(x, top, CHIP_W, CHIP_H, sw.hex);
    b.text(x - (CHIP_STEP - CHIP_W) / 2, top + CHIP_H, CHIP_STEP, 22, [[sw.label ?? "", style(FONT_BODY, 7, WHITE)]], "CENTER");
  });
  const asideX = x0 + swatches.length * CHIP_STEP;
  if (aside) b.text(asideX, top - 2, Math.max(80, LEFT_END - asideX), CHIP_H + 4, [[aside, style(FONT_BODY, 9, WHITE)]]);
  return top + CHIP_H + (swatches.length ? 30 : 4);
}

/** Colour sections side by side while they fit across the left column, then on the next row. Returns the y below them. */
function colourSections(b: SlideBuilder, y: number, sections: ColourSection[]): number {
  let x = LEFT, top = y, bottom = y;
  for (const sec of sections) {
    if (x > LEFT && x + sectionWidth(sec, x) > LEFT_END + 16) { x = LEFT; top = bottom; }
    bottom = Math.max(bottom, colourSection(b, x, top, sec));
    x += sectionWidth(sec, x);
  }
  return bottom;
}

const deptColour = (show: Show, col: ColumnDef) => customColour(show, col.dept) ?? (col.dept === "CORE" ? MUTED : DEPT_COLOURS[col.dept] ?? MUTED);

const tcText = (show: Show, song: Song) => {
  const col = show.columns.find((c) => c.type === "tc");
  return col ? String(cellValue(show, col, song)) : "";
};

function cover(show: Show, b: SlideBuilder, today: string) {
  b.background(BLACK);
  b.image((W - 200) / 2, 140, 200, 200 / LOGO_ASPECT, LOGO_URL);
  b.text(40, 245, W - 80, 44, [[show.name, style(FONT_HEAD, 24, WHITE, true)]], "CENTER");
  const sub = [show.venue, show.date].filter(Boolean).join("  ·  ");
  b.text(40, 292, W - 80, 20, [[`SHOW DECK  ·  ${sub ? `${sub}  ·  ` : ""}${today}`, style(FONT_MONO, 10, MUTED)]], "CENTER");
}

function setlist(show: Show, b: SlideBuilder) {
  b.background(BLACK);
  b.text(28, 18, 500, 34, [["RUNNING ORDER", style(FONT_HEAD, 22, WHITE, true)]]);
  const rows = show.set_order.map((id, i) => {
    const s = show.songs[id];
    return { n: String(i + 1).padStart(2, "0"), name: s.fields.name ?? "", tc: tcText(show, s), segue: s.segues_into_next };
  });
  const half = Math.ceil(rows.length / 2);
  [rows.slice(0, half), rows.slice(half)].forEach((chunk, ci) => {
    const runs: [string, Style][] = chunk.flatMap((r) => [
      [`${r.n}  `, style(FONT_MONO, 10, MUTED)] as [string, Style],
      [r.name, style(FONT_HEAD, 11, WHITE, true)] as [string, Style],
      [`   ${r.tc}${r.segue ? "  →" : ""}\n`, style(FONT_MONO, 9, MUTED)] as [string, Style],
    ]);
    if (runs.length) runs[runs.length - 1] = [runs[runs.length - 1][0].replace(/\n$/, ""), runs[runs.length - 1][1]];
    b.text(28 + ci * 340, 64, 330, 310, runs);
  });
}

function songSlide(show: Show, song: Song, position: number, b: SlideBuilder, imageUrls: Record<string, string>, clips: Record<string, string>, embed: boolean) {
  const f = song.fields;
  const cols = show.columns.filter(onSlide);
  const shown = (id: string) => cols.some((c) => c.id === id);
  const tcCol = show.columns.find((c) => c.type === "tc");
  b.background(BLACK);
  if (shown("num")) b.text(28, 16, 330, 20, [[String(position).padStart(2, "0"), style(FONT_HEAD, 13, MUTED, true)]]);
  const name = shown("name") ? f.name ?? "" : "";
  const size = name.length <= 16 ? 26 : name.length <= 24 ? 20 : 16; // Lexend runs wide: keep names on one line
  b.text(28, 34, 336, 66, [[name, style(FONT_HEAD, size, WHITE, true)]]);
  const tc = tcCol && onSlide(tcCol) ? tcText(show, song) : "";
  const meta = [shown("audio") && f.audio ? `AUDIO ${f.audio}` : "", tc ? `TC ${tc}` : "", shown("bpm") && f.bpm ? `${f.bpm} BPM` : "",
    song.segues_into_next ? "SEGUES INTO NEXT" : ""].filter(Boolean);
  let y = 100;
  if (meta.length) { b.text(28, y, 336, 16, [[meta.join("  ·  "), style(FONT_MONO, 9, MUTED)]]); y += 16; }
  const ticks: [string, Style][] = cols.filter((c) => c.type === "tick").map((c, i) => song.statuses[c.id]
    ? [`${i ? "   " : ""}✓ ${c.label}`, style(FONT_MONO, 9, WHITE)]
    : [`${i ? "   " : ""}○ ${c.label}`, style(FONT_MONO, 9, MUTED)]);
  if (ticks.length) { b.text(28, y, 336, 16, ticks); y += 16; }
  y += 8;

  // Only the swatches the song has: two colours draw two, not four.
  const colourCols = cols.filter((c) => c.type === "colour");
  const swatches = colourCols.map((c) => song.colours[c.index ?? 0]).filter(Boolean).slice(0, 6);
  const colref = shown("colref") ? f.colref ?? "" : "";
  const sections: ColourSection[] = swatches.length || colref
    ? [{ heading: "SONG COLOUR", headingColour: colourCols[0] ? deptColour(show, colourCols[0]) : MUTED, swatches, aside: colref }] : [];
  // Colour fields (Laser colour…) the same way, under their own label.
  for (const col of cols.filter((c) => c.type === "palette")) {
    const sws = fieldSwatches(song, col.id);
    if (sws.length) sections.push({ heading: col.label, headingColour: deptColour(show, col), swatches: sws });
  }
  y = colourSections(b, y, sections);

  // Everything else switched on: notes, lists, colours, extra text fields.
  const HEADER = new Set(["num", "name", "audio", "bpm", "colref", tcCol?.id]);
  const runs: [string, Style][] = cols.flatMap((col) => {
    if (HEADER.has(col.id) || ["tick", "colour", "palette", "image", "clip"].includes(col.type)) return [];
    const v = String(cellValue(show, col, song));
    return v ? [[`${col.label}\n`, style(FONT_HEAD, 8, deptColour(show, col), true)], [`${v}\n\n`, style(FONT_BODY, 9, WHITE)]] as [string, Style][] : [];
  });
  if (runs.length) {
    runs[runs.length - 1] = [runs[runs.length - 1][0].replace(/\n+$/, ""), runs[runs.length - 1][1]];
    const h = Math.max(40, 376 - y);
    b.text(28, y, 336, h, fitted(runs, 336, h));
  }
  // Down the right: each picture column's image, then each clip column's clips (SONG CLIP, LX CLIP…) on Drive as videos.
  const tiles: Tile[] = cols.filter((c) => c.type === "image").flatMap((c) => {
    const path = songImage(song, c.id);
    return path && imageUrls[path] ? [{ col: c, image: imageUrls[path] }] : [];
  });
  const clipRows = cols.filter((c) => c.type === "clip").map((col) => ({ col, links: columnClips(show, col, song).filter((c) => clips[c.path]) })).filter((r) => r.links.length);
  if (embed) for (const { col, links } of clipRows) tiles.push(...links.map((c) => ({ col, name: clipLabel(show, c), video: clips[c.path] })));
  let cy = mediaTiles(b, show, tiles, embed ? 376 : 370 - 34 * clipRows.length);
  // Without videos, links to play the clips on Drive under the images, a row per clip column: "LX CLIP  ▶ NYC T5   ▶ LDN".
  if (!embed) clipRows.forEach(({ col, links }, row) => {
    b.text(367, cy, 334, 14, [[col.label, style(FONT_HEAD, 8, deptColour(show, col), true)]]);
    b.text(367, cy + 14, 334, row === clipRows.length - 1 ? 40 : 20, links.flatMap((c, i): [string, Style][] => [
      ...(i ? [["   ", style(FONT_MONO, 9, WHITE)] as [string, Style]] : []),
      [`▶ ${clipLabel(show, c)}`, style(FONT_MONO, 9, WHITE, false, playUrl(clips[c.path]))],
    ]));
    cy += 34;
  });
  b.image(28 + INSET, 385, 40, 40 / LOGO_ASPECT, LOGO_URL);
}

/**
 * Requests to bring the deck in line with the show. `existing` maps each current slide to its element ids.
 * App slides are kept (so comments on them survive) and redrawn; slides the app doesn't want are deleted.
 * `clips` maps clip paths to their Drive file ids; they're embedded as videos, or with `embed` off, linked.
 */
export function deckRequests(show: Show, rev: number, imageUrls: Record<string, string>, existing: Record<string, string[]>, today: string,
  clips: Record<string, string> = {}, embed = true): object[] {
  const desired = slideOrder(show);
  const ids = desired.map(([id]) => id);
  const reqs: object[] = [];
  for (const id of ids) {
    if (!(id in existing)) reqs.push({ createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    else reqs.push(...existing[id].map((el) => ({ deleteObject: { objectId: el } })));
  }
  for (const id of Object.keys(existing)) if (!ids.includes(id)) reqs.push({ deleteObject: { objectId: id } });
  ids.forEach((id, i) => reqs.push({ updateSlidesPosition: { slideObjectIds: [id], insertionIndex: i } }));
  desired.forEach(([id, kind, songId], i) => {
    const b = new SlideBuilder(id, `pm${rev}_${id.slice(SLIDE_PREFIX.length)}`.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (kind === "cover") cover(show, b, today);
    else if (kind === "setlist") setlist(show, b);
    else {
      const song = show.songs[songId!];
      songSlide(show, song, i - 1, b, imageUrls, clips, embed);
    }
    reqs.push(...b.reqs);
  });
  return reqs;
}

/**
 * What the deck shows, so it's only redrawn when something on it changed: the running order's names and timecodes,
 * and each song's values in the columns on its slide. Edits to columns that aren't on the slides leave it alone.
 */
export function deckFingerprint(show: Show): string {
  const clips = show.google?.clips ?? {};
  const cols = show.columns.filter(onSlide);
  const drawn = (col: ColumnDef, song: Song) =>
    col.type === "colour" ? song.colours[col.index ?? 0] ?? null
    : col.type === "palette" ? fieldSwatches(song, col.id)
    : col.type === "image" ? songImage(song, col.id) ?? null
    : col.type === "clip" ? columnClips(show, col, song).map((c) => [c.path, clipLabel(show, c), clips[c.path]])
    : cellValue(show, col, song);
  return JSON.stringify([LAYOUT, show.name, show.venue, show.date, show.columns.filter((c) => onSlide(c) || c.type === "tc").map((c) => [c.id, c.label, c.dept, customColour(show, c.dept), onSlide(c)]),
    show.set_order.map((id) => { const s = show.songs[id]; return [id, s.fields.name, tcText(show, s), s.segues_into_next, cols.map((c) => drawn(c, s))]; })]);
}

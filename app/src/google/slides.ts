// The SHOW DECK: cover, running order, one slide per song. Show → Slides API requests.
// Ported from prototypes/google-sheets/slides_layout.py. Pure: no network here.
import { cellValue, clipLabel, deptColour as customColour, fieldSwatches, onSlide, songImage } from "../model/ops";
import type { ColourSwatch, ColumnDef, Show, Song } from "../model/types";
import { DEPT_COLOURS, rgb } from "./sheet";

const W = 720; // default 16:9 page, points
const FONT_HEAD = "Lexend", FONT_BODY = "Roboto", FONT_MONO = "Roboto Mono";
const BLACK = "#000000", WHITE = "#FFFFFF", MUTED = "#9A9A9A";
export const SLIDE_PREFIX = "pm_slide_";
const LAYOUT = 4; // bump when the slide layout changes, so open decks redraw on the next sync

interface Style { font: string; size: number; colour: string; bold: boolean; link?: string }
const style = (font = FONT_BODY, size = 10, colour = WHITE, bold = false, link?: string): Style => ({ font, size, colour, bold, link });
const colour = (hex: string) => ({ rgbColor: rgb(hex) });
const utf16Len = (s: string) => s.length; // JS strings are UTF-16 already

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

/**
 * A heading with a row of colour chips under it, each named underneath; `aside` is text after the chips.
 * Slides can't draw a pie, so a multi-colour swatch draws as stripes. Returns the y below it.
 */
function colourSection(b: SlideBuilder, y: number, heading: string, headingColour: string, swatches: ColourSwatch[], aside = ""): number {
  b.text(28, y, 336, 20, [[heading, style(FONT_HEAD, 8, headingColour, true)]]);
  const top = y + 22;
  swatches.forEach((sw, i) => {
    const x = 28 + INSET + i * CHIP_STEP;
    if (sw.pie?.length) sw.pie.forEach((c, j, all) => b.rect(x + (j * CHIP_W) / all.length, top, CHIP_W / all.length, CHIP_H, c));
    else b.rect(x, top, CHIP_W, CHIP_H, sw.hex);
    b.text(x - (CHIP_STEP - CHIP_W) / 2, top + CHIP_H, CHIP_STEP, 22, [[sw.label ?? "", style(FONT_BODY, 7, WHITE)]], "CENTER");
  });
  const asideX = 28 + swatches.length * CHIP_STEP;
  if (aside) b.text(asideX, top - 2, Math.max(80, 364 - asideX), CHIP_H + 4, [[aside, style(FONT_BODY, 9, WHITE)]]);
  return top + CHIP_H + (swatches.length ? 30 : 4);
}

const deptColour = (show: Show, col: ColumnDef) => customColour(show, col.dept) ?? (col.dept === "CORE" ? MUTED : DEPT_COLOURS[col.dept] ?? MUTED);

const tcText = (show: Show, song: Song) => {
  const col = show.columns.find((c) => c.type === "tc");
  return col ? String(cellValue(show, col, song)) : "";
};

function cover(show: Show, b: SlideBuilder, today: string) {
  b.background(BLACK);
  b.text(40, 150, W - 80, 40, [["PIXELMAPPERS", style(FONT_HEAD, 28, WHITE, true)]], "CENTER");
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

function songSlide(show: Show, song: Song, position: number, b: SlideBuilder, imageUrls: Record<string, string>, clipUrls: Record<string, string>) {
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
  if (swatches.length || colref) y = colourSection(b, y, "SONG COLOUR", colourCols[0] ? deptColour(show, colourCols[0]) : MUTED, swatches, colref);

  // Colour fields (Laser colour…) the same way, under their own label.
  for (const col of cols.filter((c) => c.type === "palette")) {
    const sws = fieldSwatches(song, col.id);
    if (sws.length) y = colourSection(b, y, col.label, deptColour(show, col), sws);
  }

  // Everything else switched on: notes, lists, colours, extra text fields.
  const HEADER = new Set(["num", "name", "audio", "bpm", "colref", tcCol?.id]);
  const runs: [string, Style][] = cols.flatMap((col) => {
    if (HEADER.has(col.id) || ["tick", "colour", "palette", "image", "clip"].includes(col.type)) return [];
    const v = String(cellValue(show, col, song));
    return v ? [[`${col.label}\n`, style(FONT_HEAD, 8, deptColour(show, col), true)], [`${v}\n\n`, style(FONT_BODY, 9, WHITE)]] as [string, Style][] : [];
  });
  if (runs.length) {
    runs[runs.length - 1] = [runs[runs.length - 1][0].replace(/\n+$/, ""), runs[runs.length - 1][1]];
    b.text(28, y, 336, Math.max(40, 376 - y), runs);
  }
  // The images down the right: one fills the 16:9 frame; several stack smaller, each under its column's name.
  const clipCol = cols.find((c) => c.type === "clip");
  const links = clipCol ? (song.clips ?? []).filter((c) => clipUrls[c.path]) : [];
  const images = cols.filter((c) => c.type === "image").flatMap((c) => {
    const path = songImage(song, c.id);
    return path && imageUrls[path] ? [{ col: c, url: imageUrls[path] }] : [];
  });
  let iy = 22;
  if (images.length === 1) {
    b.image(374, iy, 320, 180, images[0].url);
    iy += 186;
  } else if (images.length) {
    const room = 376 - iy - (links.length ? 56 : 0);
    const h = Math.min(180, room / images.length - 18);
    for (const { col, url } of images) {
      b.text(367, iy - 4, 334, 16, [[col.label, style(FONT_HEAD, 8, deptColour(show, col), true)]]);
      b.image(374, iy + 12, (h * 16) / 9, h, url);
      iy += h + 18;
    }
    iy += 4;
  }
  // Links to play the song's clips on Drive, under the images: "▶ NYC T5   ▶ LDN".
  if (clipCol && links.length) {
    const y = iy;
    b.text(367, y, 334, 14, [[clipCol.label, style(FONT_HEAD, 8, deptColour(show, clipCol), true)]]);
    b.text(367, y + 14, 334, 40, links.flatMap((c, i): [string, Style][] => [
      ...(i ? [["   ", style(FONT_MONO, 9, WHITE)] as [string, Style]] : []),
      [`▶ ${clipLabel(show, c)}`, style(FONT_MONO, 9, WHITE, false, clipUrls[c.path])],
    ]));
  }
  b.text(28, 383, 120, 12, [["PIXELMAPPERS", style(FONT_HEAD, 7, MUTED, true)]]);
}

/**
 * Requests to bring the deck in line with the show. `existing` maps each current slide to its element ids.
 * App slides are kept (so comments on them survive) and redrawn; slides the app doesn't want are deleted.
 */
export function deckRequests(show: Show, rev: number, imageUrls: Record<string, string>, existing: Record<string, string[]>, today: string,
  clipUrls: Record<string, string> = {}): object[] {
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
      songSlide(show, song, i - 1, b, imageUrls, clipUrls);
    }
    reqs.push(...b.reqs);
  });
  return reqs;
}

/** What the deck shows, so it's only redrawn when something on it changed. */
export function deckFingerprint(show: Show): string {
  return JSON.stringify([LAYOUT, show.name, show.venue, show.date, show.columns.filter((c) => onSlide(c) || c.type === "tc").map((c) => [c.id, c.label, c.dept, customColour(show, c.dept), onSlide(c)]),
    show.set_order.map((id) => { const s = show.songs[id]; return [id, s.fields, s.statuses, s.colours, s.swatches, s.hero, s.images, s.segues_into_next, s.clips]; }),
    show.google?.clips]);
}

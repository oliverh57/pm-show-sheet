// The SHOW SHEET tab (the running order) and the ARCHIVED SONGS tab: show → cells → Sheets API requests, and
// reading collaborator edits back. Both tabs have the same columns.
// Ported from prototypes/google-sheets (layout.py, sync_logic.py, model.py). Pure: no network here.
import { cellValue, clipLabel, deptColour, deptLabel, sheetEditable, songImage } from "../model/ops";
import type { ColumnDef, Show, Song } from "../model/types";

export const SHOW_TAB = "SHOW SHEET";
export const ARCHIVE_TAB = "ARCHIVED SONGS";
export const HEADER_ROWS = 4; // 0: column ids (hidden) · 1: banner · 2: department band · 3: labels
const SPARE_ROWS = 100;

// House style
const FONT_HEAD = "Lexend";
const FONT_BODY = "Roboto";
const FONT_MONO = "Roboto Mono";
const BLACK = "#000000", WHITE = "#FFFFFF", GREY = "#8C8C8C";
const LABEL_BG = "#1A1A1A";
const EDITABLE_LABEL_BG = "#FFD84D";
const EDITABLE_CELL_BG = "#FFF8DC";
export const DEPT_COLOURS: Record<string, string> = {
  CORE: "#000000", STATUS: "#262626", COLOUR: "#3A3A3A", CONTENT: "#5B3FD9", CHOREO: "#D23F8A", LX: "#D9881E",
  VIDEO: "#1E9C8A", CAMERAS: "#C8323A", STAGING: "#3A6FD9", SFX: "#7A7A7A", MD: "#9C3FA6",
};

export function rgb(hex: string) {
  const h = hex.replace("#", "");
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
}

export function textOn(hex: string): string {
  const c = rgb(hex);
  return 0.299 * c.red + 0.587 * c.green + 0.114 * c.blue > 0.6 ? BLACK : WHITE;
}

export interface Cell {
  value?: string | boolean | null;
  formula?: string;
  bg?: string;
  fg?: string;
  bold?: boolean;
  size?: number;
  font?: string;
  wrap?: boolean;
  halign?: "LEFT" | "CENTER" | "RIGHT";
  links?: { text: string; url?: string }[]; // one line each; a line with a url is a link
}

function cellApi(c: Cell) {
  const d: Record<string, unknown> = {};
  if (c.links?.length) {
    // One string, with a run per line: linked lines carry their url, the others reset to plain.
    let at = 0;
    d.textFormatRuns = c.links.map((l, i) => {
      const run = { startIndex: at, format: l.url ? { link: { uri: l.url }, underline: true } : {} };
      at += l.text.length + (i < c.links!.length - 1 ? 1 : 0);
      return run;
    });
    d.userEnteredValue = { stringValue: c.links.map((l) => l.text).join("\n") };
  } else if (c.formula) d.userEnteredValue = { formulaValue: c.formula };
  else if (typeof c.value === "boolean") d.userEnteredValue = { boolValue: c.value };
  else if (c.value !== undefined && c.value !== null && c.value !== "") d.userEnteredValue = { stringValue: String(c.value) };
  const tf: Record<string, unknown> = { fontFamily: c.font ?? FONT_BODY };
  if (c.fg) tf.foregroundColor = rgb(c.fg);
  if (c.bold) tf.bold = true;
  if (c.size) tf.fontSize = c.size;
  const fmt: Record<string, unknown> = { verticalAlignment: "MIDDLE", textFormat: tf, wrapStrategy: c.wrap ? "WRAP" : "CLIP" };
  if (c.bg) fmt.backgroundColor = rgb(c.bg);
  if (c.halign) fmt.horizontalAlignment = c.halign;
  d.userEnteredFormat = fmt;
  return d;
}

export interface TabGrid {
  title: string;
  tabColour: string;
  colIds: string[]; // col 0 is the hidden "__id" column
  headerRows: Cell[][];
  rowIds: string[];
  dataRows: Cell[][];
  colWidths: number[];
  frozenCols: number;
  merges: [number, number, number, number][]; // r0, r1, c0, c1 (end-exclusive)
  tickCols: number[];
  choiceCols: [number, string[]][]; // column, its options (a dropdown in the Sheet)
  editableCols: number[];
  dataRowHeight: number;
}

/** Runs of equal keys as [start, end, key], never crossing `splitAt`. */
function runs<T>(keys: T[], start: number, splitAt?: number): [number, number, T][] {
  const out: [number, number, T][] = [];
  let i = 0;
  while (i < keys.length) {
    let j = i;
    while (j + 1 < keys.length && keys[j + 1] === keys[i] && (splitAt === undefined || start + j + 1 !== splitAt)) j++;
    out.push([start + i, start + j + 1, keys[i]]);
    i = j + 1;
  }
  return out;
}

const idCell = (v: string): Cell => ({ value: v, fg: GREY, size: 7 });

/** What a cell holds for the Sheet, comparable with what the Sheet reads back. */
export function sheetValue(show: Show, col: ColumnDef, song: Song): string | boolean {
  if (col.type === "image" || col.type === "clip") return "";
  return normalize(cellValue(show, col, song));
}

export function normalize(v: unknown): string | boolean {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

export function asBool(v: unknown): boolean {
  return v === true || String(v).trim().toUpperCase() === "TRUE";
}

/**
 * The SHOW SHEET tab for a show (its running order), or with `archived` the ARCHIVED SONGS tab (its archive).
 * `imageUrls` maps bundle-relative image paths to =IMAGE() URLs; `clipUrls` clip paths to where they play.
 */
export function showTab(show: Show, imageUrls: Record<string, string>, clipUrls: Record<string, string> = {}, archived = false): TabGrid {
  const title = archived ? ARCHIVE_TAB : SHOW_TAB;
  const cols = show.columns;
  const colIds = ["__id", ...cols.map((c) => c.id)];
  const n = colIds.length;
  const nameCi = colIds.indexOf("name");
  const frozen = nameCi + 1;

  const banner: Cell[] = Array.from({ length: n }, () => ({ bg: BLACK }));
  banner[1] = { value: "PIXELMAPPERS", bg: BLACK, fg: WHITE, bold: true, font: FONT_HEAD, size: 16 };
  banner[frozen] = { value: `${show.name}  |  ${title}`, bg: BLACK, fg: WHITE, bold: true, font: FONT_HEAD, size: 18 };
  const merges: TabGrid["merges"] = [[1, 2, 1, frozen], [1, 2, frozen, n]];

  const depts = cols.map((c) => c.dept ?? "CORE");
  const bandColour = (d: string) => deptColour(show, d) ?? DEPT_COLOURS[d] ?? BLACK;
  const deptRow: Cell[] = [{ bg: BLACK }, ...depts.map((d) => ({ bg: bandColour(d) }))];
  for (const [c0, c1, d] of runs(depts, 1, frozen)) {
    deptRow[c0] = { value: d === "CORE" && deptLabel(show, d) === d ? "" : deptLabel(show, d), bg: bandColour(d), fg: WHITE, bold: true, font: FONT_HEAD, size: 10, halign: "CENTER" };
    if (c1 - c0 > 1) merges.push([2, 3, c0, c1]);
  }

  const labelRow: Cell[] = [{ bg: LABEL_BG }, ...cols.map((c): Cell => sheetEditable(c)
    ? { value: `✎ ${c.label}`, bg: EDITABLE_LABEL_BG, fg: BLACK, bold: true, font: FONT_HEAD, size: 9, wrap: true, halign: "CENTER" }
    : { value: c.label, bg: LABEL_BG, fg: WHITE, bold: true, font: FONT_HEAD, size: 9, wrap: true, halign: "CENTER" })];
  for (const [c0, c1] of runs(cols.map((c) => c.label), 1, frozen)) if (c1 - c0 > 1) merges.push([3, 4, c0, c1]);

  const songRow = (song: Song): Cell[] => [idCell(song.id), ...cols.map((c): Cell => {
    const v = sheetValue(show, c, song);
    const bg = sheetEditable(c) ? EDITABLE_CELL_BG : undefined;
    switch (c.type) {
      case "tick": return { value: v, bg, halign: "CENTER" };
      case "colour": {
        const sw = song.colours[c.index ?? 0];
        return sw ? { value: v, bg: sw.hex, fg: textOn(sw.hex), size: 7, halign: "CENTER" } : { value: "", bg };
      }
      case "image": {
        const img = songImage(song, c.id);
        const url = img ? imageUrls[img] : undefined;
        return url ? { formula: `=IMAGE("${url}")`, bg } : { value: "", bg };
      }
      case "clip": {
        const links = (song.clips ?? []).map((cl) => ({ text: `▶ ${clipLabel(show, cl)}`, url: clipUrls[cl.path] }));
        return links.length ? { links, bg, size: 9, wrap: true } : { value: "", bg };
      }
      case "tc": return { value: v, bg, font: FONT_MONO, size: 9, halign: "CENTER", wrap: true }; // "(Cont.)" wraps rather than clipping
      case "palette": {
        const sw = song.swatches?.[c.id]?.[0]; // a cell takes one fill: the first colour's
        return sw ? { value: v, bg: sw.hex, fg: textOn(sw.hex), size: 7, halign: "CENTER", wrap: true } : { value: "", bg };
      }
      case "choice": return { value: v, bg, halign: "CENTER" };
      default:
        return c.id === "name" ? { value: v, bg, bold: true, wrap: true } : { value: v, bg, wrap: c.type === "longtext", size: c.type === "longtext" ? 9 : undefined };
    }
  })];

  const rowIds = archived ? show.archive : show.set_order;

  return {
    title,
    tabColour: archived ? GREY : BLACK,
    colIds,
    headerRows: [colIds.map(idCell), banner, deptRow, labelRow],
    rowIds: [...rowIds],
    dataRows: rowIds.map((id) => songRow(show.songs[id])),
    colWidths: [60, ...cols.map((c) => c.width ?? 120)],
    frozenCols: frozen,
    merges,
    tickCols: cols.flatMap((c, i) => (c.type === "tick" ? [i + 1] : [])),
    choiceCols: cols.flatMap((c, i): [number, string[]][] => (c.type === "choice" ? [[i + 1, c.options ?? []]] : [])),
    editableCols: cols.flatMap((c, i) => (sheetEditable(c) ? [i + 1] : [])),
    dataRowHeight: cols.some((c) => c.type === "image") ? 110 : 48,
  };
}

// --- requests ----------------------------------------------------------------

const range = (sheetId: number, r0?: number, r1?: number, c0?: number, c1?: number) => ({
  sheetId,
  ...(r0 !== undefined && { startRowIndex: r0 }), ...(r1 !== undefined && { endRowIndex: r1 }),
  ...(c0 !== undefined && { startColumnIndex: c0 }), ...(c1 !== undefined && { endColumnIndex: c1 }),
});

const dim = (sheetId: number, dimension: "ROWS" | "COLUMNS", startIndex: number, endIndex: number, properties: object, fields: string) =>
  ({ updateDimensionProperties: { range: { sheetId, dimension, startIndex, endIndex }, properties, fields } });

const updateCells = (sheetId: number, rowIndex: number, rows: Cell[][]) =>
  ({ updateCells: { start: { sheetId, rowIndex, columnIndex: 0 }, rows: rows.map((r) => ({ values: r.map(cellApi) })), fields: "userEnteredValue,userEnteredFormat,textFormatRuns" } });

/** One-off requests for a brand-new tab: create, merge, size, hide the id row/column. (It's locked by protectionUpdateRequests.) */
export function structureRequests(g: TabGrid, sheetId: number): object[] {
  const n = g.colIds.length;
  const reqs: object[] = [{ addSheet: { properties: {
    sheetId, title: g.title, tabColor: rgb(g.tabColour),
    gridProperties: { rowCount: HEADER_ROWS + g.dataRows.length + SPARE_ROWS, columnCount: n, frozenRowCount: HEADER_ROWS, frozenColumnCount: g.frozenCols },
  } } }];
  reqs.push(...layoutRequests(g, sheetId));
  return reqs;
}

/**
 * Lock everything but the ✎ columns. Collaborators can't edit it (the tab's one sheet protection); `editors` can:
 * everyone who uses the show in the app, whose sync writes every column. They (and the owner, whom Google never locks
 * out) are warned first by warning-only ranges over the locked columns: anything typed there is replaced on the next
 * sync. (A tab takes only one sheet protection, so the warnings are ranges.)
 */
function protectionRequests(g: TabGrid, sheetId: number, editors: string[]): object[] {
  return [
    { addProtectedRange: { protectedRange: {
      range: { sheetId }, description: "Managed by PM Show Sheet. Only the ✎ columns are editable.", warningOnly: false,
      editors: { users: editors }, unprotectedRanges: g.editableCols.map((c) => range(sheetId, HEADER_ROWS, undefined, c, c + 1)),
    } } },
    ...lockedRuns(g).map(([c0, c1]) => ({ addProtectedRange: { protectedRange: {
      range: range(sheetId, undefined, undefined, c0, c1), warningOnly: true,
      description: "Managed by PM Show Sheet. Edit this in the app: changes here are replaced on the next sync.",
    } } })),
  ];
}

/** The runs of columns that aren't ✎, as [first, end) column indexes. */
function lockedRuns(g: TabGrid): [number, number][] {
  const open = new Set(g.editableCols);
  const runs: [number, number][] = [];
  g.colIds.forEach((_, i) => {
    if (open.has(i)) return;
    const last = runs[runs.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else runs.push([i, i + 1]);
  });
  return runs;
}

/** A protected range on the tab, as the Sheets API lists it. */
export interface SheetProtection {
  protectedRangeId: number;
  warningOnly?: boolean;
  range?: { startColumnIndex?: number; endColumnIndex?: number };
  unprotectedRanges?: { startColumnIndex?: number }[];
  editors?: { users?: string[] };
}

/**
 * Whether the tab is locked as protectionRequests locks it: the sheet protection leaving just the ✎ columns open to
 * collaborators (and every one of `editors` able to edit the rest), and a warning over each run of the rest.
 */
export function protectionCurrent(g: TabGrid, ranges: SheetProtection[], editors: string[]): boolean {
  const sorted = (xs: string[]) => [...xs].sort().join("|");
  const open = (p: SheetProtection) => sorted((p.unprotectedRanges ?? []).map((r) => String(r.startColumnIndex ?? 0)));
  const strict = ranges.filter((p) => !p.warningOnly);
  const warnings = ranges.filter((p) => p.warningOnly).map((p) => `${p.range?.startColumnIndex ?? 0}-${p.range?.endColumnIndex ?? ""}`);
  // Google may list more editors than were set (the owner), so only check everyone needed is there.
  const can = new Set((strict[0]?.editors?.users ?? []).map((e) => e.toLowerCase()));
  return strict.length === 1 && open(strict[0]) === sorted(g.editableCols.map(String)) && editors.every((e) => can.has(e.toLowerCase()))
    && sorted(warnings) === sorted(lockedRuns(g).map(([c0, c1]) => `${c0}-${c1}`));
}

/**
 * Lock the tab again when the ✎ columns changed (a field became editable, or columns were added, removed or
 * moved), someone new uses the show in the app, or it was locked before the owner was warned too. Nothing when it's
 * already right. A new tab has no ranges.
 */
export function protectionUpdateRequests(g: TabGrid, sheetId: number, ranges: SheetProtection[], editors: string[], columnsChanged = false): object[] {
  if (!columnsChanged && protectionCurrent(g, ranges, editors)) return [];
  return [...ranges.map((p) => ({ deleteProtectedRange: { protectedRangeId: p.protectedRangeId } })), ...protectionRequests(g, sheetId, editors)];
}

/** Merges, widths and hidden id row/column. Sent for a new tab and again when the columns change. */
function layoutRequests(g: TabGrid, sheetId: number): object[] {
  const reqs: object[] = g.merges.map(([r0, r1, c0, c1]) => ({ mergeCells: { range: range(sheetId, r0, r1, c0, c1), mergeType: "MERGE_ALL" } }));
  g.colWidths.forEach((w, i) => reqs.push(dim(sheetId, "COLUMNS", i, i + 1, { pixelSize: w }, "pixelSize")));
  reqs.push(dim(sheetId, "COLUMNS", 0, 1, { hiddenByUser: true }, "hiddenByUser"));
  reqs.push(dim(sheetId, "ROWS", 0, 1, { hiddenByUser: true }, "hiddenByUser"));
  reqs.push(dim(sheetId, "ROWS", 1, 2, { pixelSize: 64 }, "pixelSize"));
  return reqs;
}

/**
 * The columns changed since the tab was made (one added, removed or moved): unmerge the header, fix the
 * column count, then lay it out again. Cells are rewritten by contentRequests straight after, and the lock by
 * protectionUpdateRequests.
 */
export function columnChangeRequests(g: TabGrid, sheetId: number, currentCols: number): object[] {
  const n = g.colIds.length;
  const reqs: object[] = [{ unmergeCells: { range: range(sheetId, 0, HEADER_ROWS) } }];
  if (n > currentCols) reqs.push({ appendDimension: { sheetId, dimension: "COLUMNS", length: n - currentCols } });
  if (n < currentCols) reqs.push({ deleteDimension: { range: { sheetId, dimension: "COLUMNS", startIndex: n, endIndex: currentCols } } });
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenColumnCount: g.frozenCols } }, fields: "gridProperties.frozenColumnCount" } });
  reqs.push(...layoutRequests(g, sheetId));
  return reqs;
}

/** Sent on every push: header text, every data row, tick and dropdown validation, row heights. */
export function contentRequests(g: TabGrid, sheetId: number): object[] {
  const reqs: object[] = [updateCells(sheetId, 0, g.headerRows)];
  if (g.dataRows.length) reqs.push(updateCells(sheetId, HEADER_ROWS, g.dataRows));
  const end = HEADER_ROWS + g.dataRows.length;
  // Rules stay on the cells they were set on, so after a column is added, removed or moved an old tick or
  // dropdown rule sits on whatever column took its place: clear them all, then set the current ones.
  reqs.push({ setDataValidation: { range: range(sheetId, HEADER_ROWS) } });
  for (const ci of g.tickCols) reqs.push({ setDataValidation: { range: range(sheetId, HEADER_ROWS, end, ci, ci + 1), rule: { condition: { type: "BOOLEAN" } } } });
  for (const [ci, options] of g.choiceCols) {
    const rule = options.length ? { condition: { type: "ONE_OF_LIST", values: options.map((o) => ({ userEnteredValue: o })) }, strict: true, showCustomUi: true } : undefined;
    reqs.push({ setDataValidation: { range: range(sheetId, HEADER_ROWS, end, ci, ci + 1), ...(rule && { rule }) } });
  }
  if (g.dataRows.length) reqs.push(dim(sheetId, "ROWS", HEADER_ROWS, end, { pixelSize: g.dataRowHeight }, "pixelSize"));
  return reqs;
}

export type RowOp = ["move", number, number] | ["insert", number] | ["delete", number];

/**
 * Ops that turn the Sheet's row ids into the wanted order, moving rows rather than rewriting them so
 * anything attached to a row (comments, collaborator formatting) moves too. Blank ids are left alone.
 */
export function reconcileRows(current: string[], desired: string[]): RowOp[] {
  const ops: RowOp[] = [];
  const cur = [...current];
  desired.forEach((rid, i) => {
    if (cur[i] === rid) return;
    const p = cur.indexOf(rid, i);
    if (p >= 0) {
      ops.push(["move", p, i]);
      cur.splice(i, 0, cur.splice(p, 1)[0]);
    } else {
      ops.push(["insert", i]);
      cur.splice(i, 0, rid);
    }
  });
  const wanted = new Set(desired);
  for (let j = cur.length - 1; j >= desired.length; j--) {
    if (cur[j] && !wanted.has(cur[j])) {
      ops.push(["delete", j]);
      cur.splice(j, 1);
    }
  }
  return ops;
}

export function reconcileRequests(ops: RowOp[], sheetId: number): object[] {
  return ops.map((op) => {
    const h = HEADER_ROWS;
    if (op[0] === "move") return { moveDimension: { source: { sheetId, dimension: "ROWS", startIndex: h + op[1], endIndex: h + op[1] + 1 }, destinationIndex: h + op[2] } };
    if (op[0] === "insert") return { insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: h + op[1], endIndex: h + op[1] + 1 }, inheritFromBefore: true } };
    return { deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: h + op[1], endIndex: h + op[1] + 1 } } };
  });
}

// --- pulling collaborator edits ------------------------------------------------------

/** Every value as pushed, so the next pull can tell who changed what. */
export function snapshot(show: Show): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const rid of [...show.set_order, ...show.archive]) {
    for (const col of show.columns) out[`show|${rid}|${col.id}`] = sheetValue(show, col, show.songs[rid]);
  }
  return out;
}

export interface Edit { songId: string; colId: string; value: string | boolean }
export interface Conflict { songId: string; colId: string; sheet: string | boolean; app: string | boolean; published: string | boolean }

/**
 * Three-way compare of the ✎ (collaborator-editable) cells with what was last pushed:
 * the Sheet changed and the app didn't → take the Sheet's value; both changed → a conflict (the app's value wins
 * on the next push, and the Sheet's value is kept in the conflict so someone can look). Other cells are ignored.
 */
export function diffShowTab(show: Show, published: Record<string, string | boolean>, values: unknown[][]): { edits: Edit[]; conflicts: Conflict[] } {
  const edits: Edit[] = [];
  const conflicts: Conflict[] = [];
  if (!values.length) return { edits, conflicts };
  const colPos = new Map(values[0].map((cid, i) => [String(cid), i]));
  const editable = show.columns.filter(sheetEditable);
  for (const row of values.slice(HEADER_ROWS)) {
    const rid = String(normalize(row[0]));
    const song = show.songs[rid];
    if (!song) continue;
    for (const col of editable) {
      const pos = colPos.get(col.id);
      if (pos === undefined) continue;
      const raw = row[pos] ?? "";
      const sheet = col.type === "tick" ? asBool(raw) : normalize(raw);
      const key = `show|${rid}|${col.id}`;
      const pushed = published[key];
      if (pushed === undefined || sheet === pushed) continue;
      const app = sheetValue(show, col, song);
      if (app === pushed) edits.push({ songId: rid, colId: col.id, value: sheet });
      else if (app !== sheet) conflicts.push({ songId: rid, colId: col.id, sheet, app, published: pushed });
    }
  }
  return { edits, conflicts };
}

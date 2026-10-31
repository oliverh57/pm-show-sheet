// The SHOW SHEET tab (the running order) and the ARCHIVED SONGS tab: show → cells → Sheets API requests, and
// reading collaborator edits back. Both tabs have the same columns. The REVIEW tab lists the comments on videos.
// Ported from prototypes/google-sheets (layout.py, sync_logic.py, model.py). Pure: no network here.
import {
  addReview, cellValue, clipLabel, clipTimeAt, columnClips, commentDepts, deptColour, deptLabel, deptList, deptName, editReview, findReview, parseTc, placeTc, recordTc, replyToReview, setReviewDone, sheetEditable,
  songByLabel, songImage, songNumber,
} from "../model/ops";
import { GELS } from "../model/gels";
import type { ColumnDef, ReviewComment, Show, Song } from "../model/types";

export const SHOW_TAB = "SHOW SHEET";
export const ARCHIVE_TAB = "ARCHIVED SONGS";
export const REVIEW_TAB = "REVIEW";
export const HEADER_ROWS = 4; // 0: column ids (hidden) · 1: banner · 2: department band · 3: labels
const SPARE_ROWS = 100;
const SPARE_COLS = 1; // an empty column after the last, so a dropdown in the last column isn't cut off at the edge
const SPARE_COL_WIDTH = 30;

// House style
const FONT_HEAD = "Lexend";
const FONT_BODY = "Roboto";
const FONT_MONO = "Roboto Mono";
const BLACK = "#000000", WHITE = "#FFFFFF", GREY = "#8C8C8C";
/**
 * The Pixelmappers logo (white, 512 × 188) where Google can fetch it: Slides copies it in, and the Sheet's =IMAGE()
 * loads it every time the Sheet opens, so it must stay at this path on main.
 */
export const LOGO_URL = "https://raw.githubusercontent.com/oliverh57/pm-show-sheet/main/app/src/assets/logo.png";
const logoCell = (): Cell => ({ formula: `=IMAGE("${LOGO_URL}", 4, 44, 120)`, bg: BLACK }); // 44 px high, in the 64 px banner
/** The banner's title, with a link to the show's Slides deck after it once there is one. */
const titleCell = (show: Show, tab: string): Cell => {
  const title = `${show.name}  |  ${tab}`;
  const deck = show.google?.slides_url;
  return { bg: BLACK, fg: WHITE, bold: true, font: FONT_HEAD, size: 18, ...(deck ? { links: [{ text: title }, { text: "▶ SLIDES DECK", url: deck }], linkSep: "      " } : { value: title }) };
};
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
  overflow?: boolean; // runs on into the empty cells to its right
  halign?: "LEFT" | "CENTER" | "RIGHT";
  links?: { text: string; url?: string }[]; // one line each; a line with a url is a link
  linkSep?: string; // what goes between `links` instead of a blank line (spaces keep them on one line)
}

function cellApi(c: Cell) {
  const d: Record<string, unknown> = {};
  if (c.links?.length) {
    // One string, with a run per line: linked lines carry their url, the others reset to plain.
    // A blank line between them keeps several clips in one cell visibly apart.
    const SEP = c.linkSep ?? "\n\n";
    let at = 0;
    d.textFormatRuns = c.links.map((l) => {
      const run = { startIndex: at, format: l.url ? { link: { uri: l.url }, underline: true } : {} };
      at += l.text.length + SEP.length;
      return run;
    });
    d.userEnteredValue = { stringValue: c.links.map((l) => l.text).join(SEP) };
  } else if (c.formula) d.userEnteredValue = { formulaValue: c.formula };
  else if (typeof c.value === "boolean") d.userEnteredValue = { boolValue: c.value };
  else if (c.value !== undefined && c.value !== null && c.value !== "") d.userEnteredValue = { stringValue: String(c.value) };
  const tf: Record<string, unknown> = { fontFamily: c.font ?? FONT_BODY };
  if (c.fg) tf.foregroundColor = rgb(c.fg);
  if (c.bold) tf.bold = true;
  if (c.size) tf.fontSize = c.size;
  const fmt: Record<string, unknown> = { verticalAlignment: "MIDDLE", textFormat: tf, wrapStrategy: c.wrap ? "WRAP" : c.overflow ? "OVERFLOW_CELL" : "CLIP" };
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
  rowHeights?: number[]; // per data row, when they differ (the REVIEW tab's song headings are short)
  plainRows?: number[]; // data rows with no tick boxes or dropdowns (the REVIEW tab's song headings)
  noChoiceRows?: number[]; // data rows with tick boxes but no dropdowns (the REVIEW tab's replies: their song and department are their comment's)
  choicesBelow?: boolean; // the dropdowns go on down the empty rows below the data too, for rows typed there (REVIEW's new comments)
  greyWhenTicked?: number; // a tick column: a ticked row turns grey and struck through, straight away in the Sheet (REVIEW's RESOLVED)
  colourPickCols?: number[]; // colour cells and colour fields: a dropdown of `colours` to search as you type (other names, and lists, allowed with a warning)
  colourFillCols?: number[]; // the same columns: filled straight away in the Sheet when they name one of `colours` (a list, its first)
  colours?: { label: string; hex: string }[];
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
  banner[1] = logoCell();
  banner[frozen] = titleCell(show, title);
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
        const links = columnClips(show, c, song).map((cl) => ({ text: `▶ ${clipLabel(show, cl)}`, url: clipUrls[cl.path] }));
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
    colourPickCols: cols.flatMap((c, i) => (c.type === "colour" || c.type === "palette" ? [i + 1] : [])),
    colourFillCols: cols.flatMap((c, i) => (c.type === "colour" || c.type === "palette" ? [i + 1] : [])),
    colours: sheetColours(show),
  };
}

const MAX_DROPDOWN = 500; // the most options a Sheets dropdown takes

/** What the Sheet's colour cells offer and fill: the gel library, then names of the show's own that aren't in it. */
export function sheetColours(show: Show): { label: string; hex: string }[] {
  const out = new Map<string, { label: string; hex: string }>();
  const add = (label: string | undefined, hex: string) => {
    const name = label?.trim();
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { label: name, hex: hex.toUpperCase() });
  };
  for (const g of GELS) add(g.label, g.hex);
  for (const song of Object.values(show.songs)) {
    for (const sw of [...song.colours, ...Object.values(song.swatches ?? {}).flat()]) add(sw.label, sw.hex);
  }
  return [...out.values()];
}

// --- requests ----------------------------------------------------------------

const range = (sheetId: number, r0?: number, r1?: number, c0?: number, c1?: number) => ({
  sheetId,
  ...(r0 !== undefined && { startRowIndex: r0 }), ...(r1 !== undefined && { endRowIndex: r1 }),
  ...(c0 !== undefined && { startColumnIndex: c0 }), ...(c1 !== undefined && { endColumnIndex: c1 }),
});

const dim = (sheetId: number, dimension: "ROWS" | "COLUMNS", startIndex: number, endIndex: number, properties: object, fields: string) =>
  ({ updateDimensionProperties: { range: { sheetId, dimension, startIndex, endIndex }, properties, fields } });

const updateCells = (sheetId: number, rowIndex: number, rows: Cell[][], fields = "userEnteredValue,userEnteredFormat,textFormatRuns", columnIndex = 0) =>
  ({ updateCells: { start: { sheetId, rowIndex, columnIndex }, rows: rows.map((r) => ({ values: r.map(cellApi) })), fields } });

/** One-off requests for a brand-new tab: create, merge, size, hide the id row/column. (It's locked by protectionUpdateRequests.) */
export function structureRequests(g: TabGrid, sheetId: number): object[] {
  const n = g.colIds.length;
  const reqs: object[] = [{ addSheet: { properties: {
    sheetId, title: g.title, tabColor: rgb(g.tabColour),
    gridProperties: { rowCount: HEADER_ROWS + g.dataRows.length + SPARE_ROWS, columnCount: n + SPARE_COLS, frozenRowCount: HEADER_ROWS, frozenColumnCount: g.frozenCols },
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

/** An email as one key per Google account: case doesn't matter, and @googlemail.com is the same account as @gmail.com. */
export const emailKey = (email: string) => email.trim().toLowerCase().replace(/@googlemail\.com$/, "@gmail.com");

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
  const can = new Set((strict[0]?.editors?.users ?? []).map(emailKey));
  return strict.length === 1 && open(strict[0]) === sorted(g.editableCols.map(String)) && editors.every((e) => can.has(emailKey(e)))
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

/** A merge as the Sheets API lists it. */
export interface SheetMerge { startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }

/** Merge the header again when its merges aren't the grid's (the layout changed: REVIEW's counter took a banner cell, say). */
export function mergeUpdateRequests(g: TabGrid, sheetId: number, current: SheetMerge[]): object[] {
  const key = (m: [number, number, number, number]) => m.join(",");
  const have = current.filter((m) => (m.startRowIndex ?? 0) < HEADER_ROWS)
    .map((m) => key([m.startRowIndex ?? 0, m.endRowIndex ?? 0, m.startColumnIndex ?? 0, m.endColumnIndex ?? 0])).sort().join("|");
  const want = g.merges.filter(([r0, r1, c0, c1]) => (r1 - r0) * (c1 - c0) > 1); // Sheets doesn't list a one-cell merge
  if (have === want.map(key).sort().join("|")) return [];
  return [{ unmergeCells: { range: range(sheetId, 0, HEADER_ROWS) } }, ...g.merges.map(([r0, r1, c0, c1]) => ({ mergeCells: { range: range(sheetId, r0, r1, c0, c1), mergeType: "MERGE_ALL" } }))];
}

/** A conditional format as the Sheets API lists it. */
export interface SheetFormatRule { booleanRule?: { condition?: { values?: { userEnteredValue?: string }[] } } }

const TICKED_RULE = "PMSS"; // in the rule's formula, so it's told apart from rules people added themselves
const COLOUR_RULE = "PMSS colour"; // the same, for the colour fills

/**
 * The colour fills: a rule for each colour, filling a colour cell (any case, spaces around it) that names it, or whose
 * list ("Red, Blue") starts with it, as the app fills it, down to the bottom of the tab. The colour and the columns are in the formula, so the rules are only made again when one changes.
 */
function colourRules(g: TabGrid, sheetId: number): { formula: string; rule: object }[] {
  const cols = g.colourFillCols ?? [];
  if (!cols.length || !g.colours?.length) return [];
  const cell = `${colLetter(cols[0])}${HEADER_ROWS + 1}`; // relative: each cell tests itself
  const where = cols.map(colLetter).join(",");
  return g.colours.map(({ label, hex }) => {
    const first = `LEFT(${cell},FIND(",",${cell}&",")-1)`;
    const formula = `=AND(LOWER(TRIM(${first}))="${label.toLowerCase().replace(/"/g, '""')}",N("${COLOUR_RULE} ${where} ${hex}")=0)`;
    return { formula, rule: {
      ranges: cols.map((c) => range(sheetId, HEADER_ROWS, undefined, c, c + 1)),
      booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
                     format: { backgroundColor: rgb(hex), textFormat: { foregroundColor: rgb(textOn(hex)) } } },
    } };
  });
}

/**
 * The app's own conditional formats: the grey-when-ticked rule, set afresh on every push (it covers the rows there are
 * now), and the colour fills, made again only when they've changed. Conditional formats people added stay.
 */
export function formatRuleRequests(g: TabGrid, sheetId: number, current: SheetFormatRule[]): object[] {
  const formulaOf = (r: SheetFormatRule) => r.booleanRule?.condition?.values?.[0]?.userEnteredValue ?? "";
  const loose = (f: string) => f.replace(/\s+/g, "").toLowerCase();
  const colours = colourRules(g, sheetId);
  const haveColours = current.filter((r) => formulaOf(r).includes(COLOUR_RULE)).map((r) => loose(formulaOf(r)));
  const coloursSame = haveColours.length === colours.length && colours.every((c, i) => loose(c.formula) === haveColours[i]);
  const drop = current.flatMap((r, i) => {
    const f = formulaOf(r);
    return f.includes(COLOUR_RULE) ? (coloursSame ? [] : [i]) : f.includes(TICKED_RULE) ? [i] : [];
  });
  const reqs: object[] = drop.reverse().map((index) => ({ deleteConditionalFormatRule: { sheetId, index } }));
  if (!coloursSame) {
    // Added in reverse at the top, so they end up in the library's order, after the app's other rules.
    for (const c of [...colours].reverse()) reqs.push({ addConditionalFormatRule: { index: 0, rule: c.rule } });
  }
  if (g.greyWhenTicked === undefined) return reqs;
  const cell = `$${colLetter(g.greyWhenTicked)}${HEADER_ROWS + 1}`;
  reqs.push({ addConditionalFormatRule: { index: 0, rule: {
    ranges: [range(sheetId, HEADER_ROWS, undefined, 1, g.colIds.length)], // to the bottom of the tab, however many rows it has
    booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=AND(${cell}=TRUE,N("${TICKED_RULE}")=0)` }] },
                   format: { textFormat: { foregroundColor: rgb(GREY), strikethrough: true } } },
  } } });
  return reqs;
}

/** "A", "B" … "AA": a column's letter. */
export const colLetter = (i: number): string => (i >= 26 ? colLetter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

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
  const n = g.colIds.length + SPARE_COLS;
  const reqs: object[] = [{ unmergeCells: { range: range(sheetId, 0, HEADER_ROWS) } }];
  if (n > currentCols) reqs.push({ appendDimension: { sheetId, dimension: "COLUMNS", length: n - currentCols } });
  if (n < currentCols) reqs.push({ deleteDimension: { range: { sheetId, dimension: "COLUMNS", startIndex: n, endIndex: currentCols } } });
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenColumnCount: g.frozenCols } }, fields: "gridProperties.frozenColumnCount" } });
  reqs.push(...layoutRequests(g, sheetId));
  return reqs;
}

/** The spare column, for a tab made before it had one (the columns otherwise unchanged). */
export function spareColumnRequests(g: TabGrid, sheetId: number, currentCols: number): object[] {
  const n = g.colIds.length + SPARE_COLS;
  return currentCols < n ? [{ appendDimension: { sheetId, dimension: "COLUMNS", length: n - currentCols } }] : [];
}

/**
 * The ✎ cells a push leaves as they are in the Sheet: those the app hasn't changed since the last push. The Sheet has
 * the same there, or an edit someone typed after the pull read it (while the sync uploaded images, say), which writing
 * the whole row would wipe without anyone knowing; the next pull brings it in. Every cell of a row the push is adding
 * (not in `inSheet`) is written. `now` is the snapshot of the show being pushed.
 */
export function keptCells(g: TabGrid, kind: "show" | "review", now: Record<string, string | boolean>, published: Record<string, string | boolean>,
  inSheet: Set<string>): (row: number, col: number) => boolean {
  const editable = new Set(g.editableCols);
  return (row, col) => {
    const rid = g.rowIds[row];
    if (!editable.has(col) || !inSheet.has(rid)) return false;
    // REPLY is pushed empty and the pull empties it once it's read, so a reply in it is one typed since.
    if (kind === "review" && g.colIds[col] === "reply") return `review|${rid}|done` in now;
    const key = `${kind}|${rid}|${g.colIds[col]}`;
    return key in now && published[key] === now[key];
  };
}

/**
 * `g` with the `keep` cells' values as they are in the Sheet (`sheet`: the tab read just before the push, its id row
 * first), found by the row's id rather than where it is, to be written with the rest. Another Mac pushing at the same time
 * can move rows between that read and this push's write; a cell left as it is would then end up beside another row's id
 * (and the next pull would read it as an edit to that row), where a row written whole stays its own.
 */
export function withSheetValues(g: TabGrid, keep: (row: number, col: number) => boolean, sheet: unknown[][]): TabGrid {
  const colPos = new Map((sheet[0] ?? []).map((cid, i) => [String(cid), i]));
  const byId = new Map<string, unknown[]>();
  for (const row of sheet.slice(HEADER_ROWS)) {
    const id = String(normalize(row?.[0]));
    if (id && !byId.has(id)) byId.set(id, row);
  }
  const dataRows = g.dataRows.map((r, ri) => r.map((cell, ci) => {
    if (!keep(ri, ci)) return cell;
    const p = colPos.get(g.colIds[ci]);
    const v = p === undefined ? undefined : byId.get(g.rowIds[ri])?.[p];
    return { ...cell, value: typeof cell.value === "boolean" ? asBool(v) : normalize(v), formula: undefined, links: undefined };
  }));
  return { ...g, dataRows };
}

/** The data rows, leaving the values of `keep` cells alone (their format is still set). */
function dataRequests(g: TabGrid, sheetId: number, keep?: (row: number, col: number) => boolean): object[] {
  const rows = g.dataRows;
  if (!keep || !rows.some((r, ri) => r.some((_, ci) => keep(ri, ci)))) return [updateCells(sheetId, HEADER_ROWS, rows)];
  // A field mask covers every cell it's sent with, so: formats for all, then the values a column at a time, in runs of rows.
  const reqs: object[] = [updateCells(sheetId, HEADER_ROWS, rows, "userEnteredFormat")];
  g.colIds.forEach((_, ci) => {
    for (const [r0, r1, kept] of runs(rows.map((_, ri) => keep(ri, ci)), 0)) {
      if (!kept) reqs.push(updateCells(sheetId, HEADER_ROWS + r0, rows.slice(r0, r1).map((r) => [r[ci]]), "userEnteredValue,textFormatRuns", ci));
    }
  });
  return reqs;
}

/**
 * Sent on every push: header text, every data row (but the `keep` cells' values: see keptCells), tick and dropdown
 * validation, row heights.
 */
export function contentRequests(g: TabGrid, sheetId: number, keep?: (row: number, col: number) => boolean): object[] {
  const reqs: object[] = [updateCells(sheetId, 0, g.headerRows)];
  if (g.dataRows.length) reqs.push(...dataRequests(g, sheetId, keep));
  const end = HEADER_ROWS + g.dataRows.length;
  // The spare column stays blank, white and narrow: Sheets gives an added column the format and width of the one before it.
  const spare = g.colIds.length;
  reqs.push({ repeatCell: { range: range(sheetId, 0, undefined, spare, spare + SPARE_COLS), cell: { userEnteredFormat: { backgroundColor: rgb(WHITE) } }, fields: "userEnteredValue,userEnteredFormat" } });
  reqs.push(dim(sheetId, "COLUMNS", spare, spare + SPARE_COLS, { pixelSize: SPARE_COL_WIDTH }, "pixelSize"));
  // Rules stay on the cells they were set on, so after a column is added, removed or moved an old tick or
  // dropdown rule sits on whatever column took its place: clear them all, then set the current ones.
  reqs.push({ setDataValidation: { range: range(sheetId, HEADER_ROWS) } });
  // Rules go on the runs of data rows between the rows that skip them. A run that's open-ended goes to the bottom of the tab
  // (however many rows it has: a range past the last row would fail the whole push).
  const spans = (skip: Set<number>, below: boolean) => {
    const out: [number, number | undefined][] = [];
    for (let i = 0, start = 0; i <= g.dataRows.length; i++) {
      if (i < g.dataRows.length && !skip.has(i)) continue;
      if (i === g.dataRows.length && below) out.push([HEADER_ROWS + start, undefined]);
      else if (i > start) out.push([HEADER_ROWS + start, HEADER_ROWS + i]);
      start = i + 1;
    }
    return out;
  };
  const plain = new Set(g.plainRows ?? []);
  for (const [r0, r1] of spans(plain, false)) {
    for (const ci of g.tickCols) reqs.push({ setDataValidation: { range: range(sheetId, r0, r1, ci, ci + 1), rule: { condition: { type: "BOOLEAN" } } } });
  }
  for (const [r0, r1] of spans(new Set([...plain, ...(g.noChoiceRows ?? [])]), Boolean(g.choicesBelow))) {
    for (const [ci, options] of g.choiceCols) {
      if (!options.length) continue;
      const rule = { condition: { type: "ONE_OF_LIST", values: options.map((o) => ({ userEnteredValue: o })) }, strict: true, showCustomUi: true };
      reqs.push({ setDataValidation: { range: range(sheetId, r0, r1, ci, ci + 1), rule } });
    }
  }
  if (g.colours?.length) {
    for (const [r0, r1] of spans(plain, false)) {
      for (const ci of g.colourPickCols ?? []) {
        const values = g.colours.slice(0, MAX_DROPDOWN).map((c) => ({ userEnteredValue: c.label }));
        reqs.push({ setDataValidation: { range: range(sheetId, r0, r1, ci, ci + 1), rule: { condition: { type: "ONE_OF_LIST", values }, strict: false, showCustomUi: true } } });
      }
    }
  }
  if (g.rowHeights) {
    runs(g.rowHeights, HEADER_ROWS).forEach(([r0, r1, px]) => reqs.push(dim(sheetId, "ROWS", r0, r1, { pixelSize: px }, "pixelSize")));
  } else if (g.dataRows.length) reqs.push(dim(sheetId, "ROWS", HEADER_ROWS, end, { pixelSize: g.dataRowHeight }, "pixelSize"));
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
  // Below the wanted rows, a row with an id is one no longer wanted, or a second copy of one (left by two Macs pushing at once).
  for (let j = cur.length - 1; j >= desired.length; j--) {
    if (cur[j]) {
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
  for (const row of reviewRows(show)) {
    for (const col of REVIEW_EDITABLE) out[`review|${row.id}|${col}`] = row.values[col];
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
  const seen = new Set<string>();
  for (const row of values.slice(HEADER_ROWS)) {
    const rid = String(normalize(row[0]));
    const song = show.songs[rid];
    if (!song || seen.has(rid)) continue; // a second copy of a row: the next push deletes it
    seen.add(rid);
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

// --- the REVIEW tab ---------------------------------------------------------------------
// One row per comment, each followed by its replies: open comments under a heading row per song, in running order then
// timecode, and resolved ones under RESOLVED at the bottom (a comment resolved in the Sheet greys out at once and moves
// down on the next sync). The banner counts the open comments live. Collaborators can edit the ✎ cells: a comment's song, TC, department, text or author; tick RESOLVED (on
// any row of the thread); type in REPLY to reply (the app moves it onto its own row); or add a row of their own
// (song, TC, comment) for a new comment, which the app gives an id.

type ReviewCol = "frame" | "song" | "tc" | "dept" | "comment" | "from" | "at" | "reply" | "done" | "clip";
const REVIEW_COLS: { id: ReviewCol; label: string; width: number; editable?: boolean }[] = [
  { id: "frame", label: "FRAME", width: 150 },
  { id: "song", label: "SONG", width: 160, editable: true },
  { id: "tc", label: "TC", width: 120, editable: true },
  { id: "dept", label: "DEPT", width: 100, editable: true },
  { id: "comment", label: "COMMENT", width: 340, editable: true },
  { id: "from", label: "FROM", width: 120, editable: true },
  { id: "at", label: "WRITTEN", width: 110 },
  { id: "reply", label: "REPLY", width: 220, editable: true },
  { id: "done", label: "RESOLVED", width: 84, editable: true },
  { id: "clip", label: "CLIP", width: 160 },
];
/** The ✎ cells that are compared with what was pushed (REPLY is always pushed empty, so anything in it is new). */
const REVIEW_EDITABLE = ["song", "tc", "dept", "comment", "from", "done"] as const;
type ReviewValue = (typeof REVIEW_EDITABLE)[number];
const REPLY_MARK = "↳ reply";
export const REPLY_FROM = "Google Sheet"; // who a Sheet comment or reply is from when no one can be named

interface ReviewRow {
  id: string; // the comment's id, or "<comment id>/<reply id>"
  comment: ReviewComment;
  reply?: ReviewComment["replies"][number];
  values: Record<ReviewValue, string | boolean>;
}

const songLabel = (show: Show, songId: string | null) => {
  const song = songId ? show.songs[songId] : undefined;
  return song ? `${songNumber(show, song.id)} ${song.fields.name ?? ""}`.trim() : "";
};
const reviewTc = (c: ReviewComment) => (c.tc ? (c.tc_out ? `${c.tc} → ${c.tc_out}` : c.tc) : "");
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const written = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The REVIEW tab's rows in order, with the ✎ values each shows. */
export function reviewRows(show: Show): ReviewRow[] {
  const order = new Map([...show.set_order, ...show.archive].map((id, i) => [id, i]));
  const place = (c: ReviewComment) => order.get(c.song_id ?? "") ?? Infinity;
  const comments = [...(show.reviews ?? [])]
    .sort((a, b) => Number(a.done) - Number(b.done) || place(a) - place(b) || Number(!a.record_id) - Number(!b.record_id) || a.t - b.t || a.at.localeCompare(b.at));
  return comments.flatMap((c) => {
    const values = { song: songLabel(show, c.song_id), tc: reviewTc(c), dept: c.dept ? deptName(c.dept, show) : "", comment: c.text, from: c.from, done: c.done };
    return [
      { id: c.id, comment: c, values },
      ...c.replies.map((r) => ({ id: `${c.id}/${r.id}`, comment: c, reply: r, values: { song: REPLY_MARK, tc: "", dept: "", comment: r.text, from: r.from, done: c.done } })),
    ];
  });
}

/** The REVIEW tab. `imageUrls` maps stills (bundle-relative) to =IMAGE() URLs; `clipUrls` clip paths to where they play. */
export function reviewTab(show: Show, imageUrls: Record<string, string>, clipUrls: Record<string, string> = {}): TabGrid {
  const colIds = ["__id", ...REVIEW_COLS.map((c) => c.id)];
  const n = colIds.length;
  const frozen = colIds.indexOf("song") + 1;
  const banner: Cell[] = Array.from({ length: n }, () => ({ bg: BLACK }));
  banner[1] = logoCell();
  banner[frozen] = titleCell(show, REVIEW_TAB);
  const band = DEPT_COLOURS.VIDEO;
  // The open-comment count, worked out by the Sheet so ticking RESOLVED there changes it at once: rows with a comment
  // that aren't ticked or replies (heading rows have no comment).
  const counterAt = n - 2;
  const col = (id: ReviewCol) => colLetter(colIds.indexOf(id));
  const rowsFrom = (id: ReviewCol) => `${col(id)}${HEADER_ROWS + 1}:${col(id)}`;
  banner[counterAt] = {
    formula: `=SUMPRODUCT((LEN(${rowsFrom("comment")})>0)*(${rowsFrom("done")}<>TRUE)*(${rowsFrom("song")}<>"${REPLY_MARK}"))&" OPEN COMMENTS"`,
    bg: band, fg: WHITE, bold: true, font: FONT_HEAD, size: 14, halign: "CENTER",
  };
  const deptRow: Cell[] = [{ bg: BLACK }, ...REVIEW_COLS.map(() => ({ bg: band }))];
  deptRow[1] = { value: "COMMENTS ON VIDEOS", bg: band, fg: WHITE, bold: true, font: FONT_HEAD, size: 10, halign: "CENTER" };
  deptRow[frozen] = { value: "", bg: band };
  const labelRow: Cell[] = [{ bg: LABEL_BG }, ...REVIEW_COLS.map((c): Cell => c.editable
    ? { value: `✎ ${c.label}`, bg: EDITABLE_LABEL_BG, fg: BLACK, bold: true, font: FONT_HEAD, size: 9, wrap: true, halign: "CENTER" }
    : { value: c.label, bg: LABEL_BG, fg: WHITE, bold: true, font: FONT_HEAD, size: 9, wrap: true, halign: "CENTER" })];

  const rows = reviewRows(show);
  const hasStill = (row: ReviewRow) => Boolean(!row.reply && row.comment.still && imageUrls[row.comment.still]);
  const rowIds: string[] = [];
  const dataRows: Cell[][] = [];
  const rowHeights: number[] = [];
  const plainRows: number[] = [];
  const replyRows: number[] = [];
  const heading = (id: string, title: string, note: string, bg: string) => {
    const cells: Cell[] = colIds.map(() => ({ bg }));
    cells[0] = { ...idCell(id), bg };
    cells[1] = { value: title, bg, fg: WHITE, bold: true, font: FONT_HEAD, size: 11, overflow: true };
    cells[colIds.indexOf("tc")] = { value: note, bg, fg: WHITE, font: FONT_HEAD, size: 9, overflow: true };
    plainRows.push(dataRows.length);
    rowIds.push(id); dataRows.push(cells); rowHeights.push(30);
  };
  let group: string | undefined;
  rows.forEach((row) => {
    const c = row.comment;
    const g = c.done ? "resolved" : `song|${c.song_id ?? ""}`;
    if (!row.reply && g !== group) {
      group = g;
      const inGroup = rows.filter((r) => !r.reply && (c.done ? r.comment.done : !r.comment.done && r.comment.song_id === c.song_id)).length;
      const count = `${inGroup} ${c.done ? "resolved" : "open"}`;
      if (c.done) heading(g, "RESOLVED", count, GREY);
      else heading(g, songLabel(show, c.song_id).toUpperCase() || "NO SONG", count, LABEL_BG);
    }
    if (row.reply) replyRows.push(dataRows.length);
    rowIds.push(row.id);
    dataRows.push(reviewCells(row));
    rowHeights.push(hasStill(row) ? 90 : row.reply ? 36 : 48);
  });
  function reviewCells(row: ReviewRow): Cell[] {
    const c = row.comment;
    const fg = c.done ? GREY : undefined;
    const ed = (cell: Cell): Cell => ({ bg: EDITABLE_CELL_BG, fg, ...cell });
    const clip = !row.reply && c.record_id ? (show.songs[c.song_id ?? ""]?.clips ?? []).find((cl) => cl.record_id === c.record_id && c.t >= cl.in && c.t <= cl.out) : undefined;
    const still = !row.reply && c.still ? imageUrls[c.still] : undefined;
    const cells: Record<ReviewCol, Cell> = {
      frame: still ? { formula: `=IMAGE("${still}")` } : { value: "" },
      song: row.reply ? ed({ value: REPLY_MARK, fg: GREY, size: 9 }) : ed({ value: row.values.song, bold: true, wrap: true }),
      tc: ed({ value: row.values.tc, font: FONT_MONO, size: 9, halign: "CENTER", wrap: true }),
      dept: ed({ value: row.values.dept, halign: "CENTER" }),
      comment: ed({ value: row.values.comment, wrap: true, size: row.reply ? 9 : undefined }),
      from: ed({ value: row.values.from, size: 9 }),
      at: { value: written((row.reply ?? c).at), fg: GREY, size: 9 },
      reply: ed({ value: "" }),
      done: ed({ value: c.done, halign: "CENTER" }),
      clip: clip ? { links: [{ text: `▶ ${clipLabel(show, clip)} @ ${mmss(clipTimeAt(clip, c.t))}`, url: clipUrls[clip.path] }], size: 9, wrap: true } : { value: "" },
    };
    return [idCell(row.id), ...REVIEW_COLS.map((col) => cells[col.id])];
  }
  const depts = commentDepts(show).map((d) => deptName(d, show));
  return {
    title: REVIEW_TAB,
    tabColour: band,
    colIds,
    headerRows: [colIds.map(idCell), banner, deptRow, labelRow],
    rowIds,
    dataRows,
    colWidths: [60, ...REVIEW_COLS.map((c) => c.width)],
    frozenCols: frozen,
    // Sheets won't merge across the frozen columns' edge
    merges: [[1, 2, 1, frozen], [1, 2, frozen, counterAt], [1, 2, counterAt, n], [2, 3, 1, frozen], [2, 3, frozen, n]],
    tickCols: [colIds.indexOf("done")],
    // SONG picks from the songs, as "07 Name" (archived ones by name), as songByLabel reads them back
    choiceCols: [[colIds.indexOf("song"), [...show.set_order, ...show.archive].map((id) => songLabel(show, id)).filter(Boolean)], [colIds.indexOf("dept"), depts]],
    editableCols: REVIEW_COLS.flatMap((c, i) => (c.editable ? [i + 1] : [])),
    dataRowHeight: 48,
    rowHeights,
    plainRows,
    noChoiceRows: replyRows,
    choicesBelow: true,
    greyWhenTicked: colIds.indexOf("done"),
  };
}

export type ReviewEdit =
  | { kind: "set"; id: string; col: ReviewValue; value: string | boolean } // id: a comment's, or "<comment>/<reply>"
  | { kind: "reply"; id: string; text: string; from: string }
  | { kind: "new"; row: number; song: string; tc: string; dept: string; comment: string; from: string }; // row: index in the values read

/**
 * What collaborators changed on the REVIEW tab, compared three ways like the show tab: a ✎ cell the Sheet changed
 * and the app didn't is taken; both changed, the app wins. Text in REPLY is a new reply; a row with no id and a comment
 * is a new comment (for the song whose heading it's under, if its SONG is left blank).
 */
export function diffReviewTab(show: Show, published: Record<string, string | boolean>, values: unknown[][]): ReviewEdit[] {
  const edits: ReviewEdit[] = [];
  if (!values.length) return edits;
  const colPos = new Map(values[0].map((cid, i) => [String(cid), i]));
  const cell = (row: unknown[], col: string) => { const p = colPos.get(col); return p === undefined ? "" : row[p] ?? ""; };
  const app = new Map(reviewRows(show).map((r) => [r.id, r]));
  let under = ""; // the song heading the rows are under
  values.forEach((row, i) => {
    if (i < HEADER_ROWS) return;
    const id = String(normalize(row[0]));
    if (id === "resolved" || id.startsWith("song|")) { under = id.startsWith("song|") ? songLabel(show, id.slice(5) || null) : ""; return; }
    if (!id) {
      const comment = String(normalize(cell(row, "comment")));
      if (comment) edits.push({ kind: "new", row: i, comment, song: String(normalize(cell(row, "song"))) || under, tc: String(normalize(cell(row, "tc"))),
                                dept: String(normalize(cell(row, "dept"))), from: String(normalize(cell(row, "from"))) });
      return;
    }
    const mine = app.get(id);
    if (!mine) return; // deleted in the app (or a second copy of a row): the next push takes the row out
    app.delete(id);
    for (const col of REVIEW_EDITABLE) {
      if (!colPos.has(col)) continue;
      const sheet = col === "done" ? asBool(cell(row, col)) : normalize(cell(row, col));
      const pushed = published[`review|${id}|${col}`];
      if (pushed === undefined || sheet === pushed) continue;
      if (mine.values[col] === pushed) edits.push({ kind: "set", id, col, value: sheet });
    }
    const reply = String(normalize(cell(row, "reply")));
    if (reply) {
      const named = reply.match(/^([^:\n]{1,40}):\s+([\s\S]+)$/); // "Sam: sounds good"
      edits.push({ kind: "reply", id: mine.comment.id, text: named ? named[2] : reply, from: named ? named[1].trim() : REPLY_FROM });
    }
  });
  return edits;
}

/** Re-place a comment at a TC typed in the Sheet ("04:31:23:10", or "A → B" for a range). */
function retime(show: Show, c: ReviewComment, text: string) {
  const [a, b] = text.split(/→|->/).map((x) => parseTc(x.trim()));
  if (!a) return;
  const at = placeTc(show, c.song_id, a);
  const record = (show.records ?? []).find((r) => r.id === at?.record_id);
  delete c.t_out; delete c.tc_out;
  if (at) {
    Object.assign(c, { record_id: at.record_id, t: at.t, tc: recordTc(record, at.t) ?? a });
    const end = b ? placeTc(show, c.song_id, b) : null;
    if (end && end.record_id === at.record_id && end.t > at.t) Object.assign(c, { t_out: end.t, tc_out: recordTc(record, end.t) ?? b });
  } else {
    delete c.record_id;
    Object.assign(c, { t: 0, tc: a });
  }
}

const deptFrom = (show: Show, name: string) => deptList(show).find((d) => deptName(d, show).toLowerCase() === name.toLowerCase() || d === name.toUpperCase());

/** A version of the Sheet in its Drive revision history: when, and who made it. */
export interface SheetRevision {
  modifiedTime: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string; me?: boolean };
}

export interface SheetAuthor { name: string; email?: string }

/**
 * Who typed what a pull found new in the Sheet (a comment or reply with no name), from who edited the Sheet since the
 * pull before it: Google doesn't say who edited a cell. The one person besides you; else you, when you're the only one
 * (rows the app hasn't seen yet are never its own); with several, the one who doesn't use the app (whose only way to
 * edit is the Sheet). Null when it can't tell.
 */
export function sheetAuthor(revisions: SheetRevision[], since: number, appEditors: string[]): SheetAuthor | null {
  const people = new Map<string, SheetAuthor & { me: boolean }>();
  for (const r of revisions) {
    const u = r.lastModifyingUser;
    const key = u?.emailAddress ? emailKey(u.emailAddress) : (u?.displayName ?? "").toLowerCase();
    if (!u || !key || !(Date.parse(r.modifiedTime) > since)) continue;
    people.set(key, { name: u.displayName || u.emailAddress!, ...(u.emailAddress && { email: u.emailAddress }), me: Boolean(u.me) });
  }
  const named = ({ name, email }: SheetAuthor) => ({ name, ...(email && { email }) });
  const all = [...people.values()];
  const others = all.filter((p) => !p.me);
  if (others.length === 1) return named(others[0]);
  if (!others.length) return all.length ? named(all[0]) : null;
  const app = new Set(appEditors.map(emailKey));
  const outside = others.filter((p) => !p.email || !app.has(emailKey(p.email)));
  return outside.length === 1 ? named(outside[0]) : null;
}

/**
 * Apply what diffReviewTab found. `ids` gives each new comment its id, by the row it was typed on (already written back).
 * `author` (from sheetAuthor) is who a new comment or reply is from when it doesn't say.
 */
export function applyReviewEdits(show: Show, edits: ReviewEdit[], ids: Map<number, string>, author: SheetAuthor | null = null) {
  const unnamed = author ? { from: author.name, ...(author.email && { email: author.email }) } : { from: REPLY_FROM };
  for (const e of edits) {
    if (e.kind === "new") {
      const songId = songByLabel(show, e.song);
      const tc = parseTc(e.tc);
      const at = tc ? placeTc(show, songId, tc) : null;
      const dept = deptFrom(show, e.dept);
      addReview(show, {
        id: ids.get(e.row), song_id: songId, t: at?.t ?? 0, text: e.comment, ...(e.from ? { from: e.from } : unnamed), source: "sheet",
        ...(at && { record_id: at.record_id }), ...(tc && { tc }), ...(dept && { dept }),
      });
      continue;
    }
    const [cid, rid] = e.id.split("/");
    const c = findReview(show, cid);
    if (!c) continue;
    if (e.kind === "reply") { replyToReview(show, c.id, e.from === REPLY_FROM ? { ...unnamed, text: e.text } : { from: e.from, text: e.text }); continue; }
    if (e.col === "done") { setReviewDone(show, c.id, e.value === true); continue; }
    const value = String(e.value);
    const reply = rid ? c.replies.find((r) => r.id === rid) : undefined;
    if (rid) {
      if (!reply) continue;
      if (e.col === "comment" && value) reply.text = value;
      else if (e.col === "from") reply.from = value || REPLY_FROM;
      continue; // a reply row's song, TC and department are its comment's
    }
    if (e.col === "comment" && value) editReview(show, c.id, value);
    else if (e.col === "from") c.from = value || REPLY_FROM;
    else if (e.col === "dept") { const d = deptFrom(show, value); if (d) c.dept = d; else if (!value) delete c.dept; }
    else if (e.col === "song") { const sid = songByLabel(show, value); if (sid) c.song_id = sid; }
    else if (e.col === "tc" && !c.image) retime(show, c, value); // an image comment has no time
  }
}

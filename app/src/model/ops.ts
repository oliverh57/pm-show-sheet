// Pure operations on a show. Each mutates the show it's given; the store clones first.
import { GELS, gelLabelFor } from "./gels";
import type { AudioFile, Clip, ColourSwatch, ColumnDef, CropRect, Dept, ListName, Note, Show, Song, SongMark, SourceRecord, TcBlock } from "./types";

export const DEPTS = ["CORE", "STATUS", "COLOUR", "CONTENT", "CHOREO", "LX", "VIDEO", "CAMERAS", "STAGING", "SFX", "MD"] as const;
export const MAX_SWATCHES = 4;
export const CORE_COLUMN_IDS = ["num", "name", "bpm"]; // can't be deleted

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The value a cell shows. A song after a segue keeps its TC start, marked "(Cont.)", or shows "Cont." if it has none. */
export function cellValue(show: Show, col: ColumnDef, song: Song): string | boolean {
  if (col.id === "num") return songNumber(show, song.id);
  switch (col.type) {
    case "tick":
      return Boolean(song.statuses[col.id]);
    case "colour":
      return song.colours[col.index ?? 0]?.label ?? "";
    case "image":
      return songImage(song, col.id) ?? "";
    case "clip":
      return (song.clips ?? []).map((c) => clipLabel(show, c)).join(", ");
    case "palette":
      return fieldSwatches(song, col.id).map((sw) => sw.label || sw.hex).join(", ");
    case "tc": {
      const tc = song.fields[col.id] ?? "";
      if (!continuesFromPrev(show, song.id)) return tc;
      return tc ? `${tc} (Cont.)` : "Cont.";
    }
    default:
      return song.fields[col.id] ?? "";
  }
}

/** Columns the slide shows unless they're switched off: its header, swatches, colour ref and render. */
const SLIDE_BY_DEFAULT = ["num", "name", "audio", "bpm", "colref"];

/** Whether the column is shown on each song's slide. */
export function onSlide(col: ColumnDef): boolean {
  return col.on_slide ?? (SLIDE_BY_DEFAULT.includes(col.id) || ["tc", "colour", "palette", "image", "clip"].includes(col.type));
}

/** Whether the song before this one segues into it. */
export function continuesFromPrev(show: Show, songId: string): boolean {
  return Boolean(prevSong(show, songId)?.segues_into_next);
}

export function isTextColumn(col: ColumnDef): boolean {
  return col.type === "text" || col.type === "longtext" || col.type === "tc";
}

/** Columns whose value lives in song.fields: the text columns and choices. (# is the running order, not a field.) */
export function isFieldColumn(col: ColumnDef): boolean {
  return (isTextColumn(col) || col.type === "choice") && col.id !== "num";
}

/** A song's # : its place in the running order ("01"), blank in the archive. */
export function songNumber(show: Show, songId: string): string {
  const i = show.set_order.indexOf(songId);
  return i >= 0 ? String(i + 1).padStart(2, "0") : "";
}

/** A colour field's swatches on a song. */
export function fieldSwatches(song: Song, colId: string): ColourSwatch[] {
  return song.swatches?.[colId] ?? [];
}

/** "#f80", "FF8800", "ff8800" → "#FF8800"; anything else → null. */
export function parseHex(text: string): string | null {
  const h = text.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) return `#${h.split("").map((c) => c + c).join("")}`.toUpperCase();
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h}`.toUpperCase() : null;
}

/** A swatch for a colour typed by name ("Steel Blue", "CTB", "L201") or hex; any other text labels a swatch of `hex`. */
export function swatchFor(text: string, hex = "#808080"): ColourSwatch {
  const lower = text.trim().toLowerCase();
  const gel = GELS.find((g) => g.label.toLowerCase() === lower) ?? GELS.find((g) => g.name.toLowerCase() === lower || g.code.toLowerCase() === lower);
  if (gel) return { hex: gel.hex, label: gel.label, ...(gel.pie && { pie: gel.pie }) };
  const parsed = parseHex(text);
  return parsed ? { hex: parsed, label: parsed } : { hex, label: text.trim() };
}

/** What a typed value becomes in a field, or null if the field can't take it: a choice field takes one of its options, in any case. */
export function fieldValue(col: ColumnDef, text: string): string | null {
  const t = text.trim();
  if (col.type === "choice") {
    if (!t) return "";
    return (col.options ?? []).find((o) => o.toLowerCase() === t.toLowerCase()) ?? null;
  }
  return text;
}

/** Columns only the app edits: the running order's own fields. */
const SHEET_LOCKED = new Set(["num", "name", "tc", "audio"]);

/** Whether people can edit a column in the Google Sheet (its ✎ columns): every data and custom field, BPM, the colours and the status ticks. */
export function sheetEditable(col: ColumnDef): boolean {
  return col.type === "colour" || col.type === "palette" || col.type === "tick" || (isFieldColumn(col) && !SHEET_LOCKED.has(col.id));
}

/**
 * Put a value typed in the Sheet into the show. A colour cell takes a colour's name ("Steel Blue", "CTB"); clearing it removes the swatch.
 * A colour field takes a list of names ("CTB, Steel Blue"); a swatch whose name is unchanged keeps its colour.
 * A value a choice field can't take is ignored, so the app's value goes back on the next push.
 */
export function applySheetValue(show: Show, songId: string, col: ColumnDef, value: string | boolean) {
  const song = show.songs[songId];
  if (!song) return;
  if (col.type === "tick") song.statuses[col.id] = Boolean(value);
  else if (col.type === "colour") {
    const i = col.index ?? 0;
    const text = String(value).trim();
    if (!text) { if (i < song.colours.length) song.colours.splice(i, 1); return; }
    const swatch = swatchFor(text, song.colours[i]?.hex);
    if (i < song.colours.length) song.colours[i] = swatch;
    else song.colours.push(swatch);
  } else if (col.type === "palette") {
    const was = fieldSwatches(song, col.id);
    const names = String(value).split(",").map((x) => x.trim()).filter(Boolean).slice(0, MAX_SWATCHES);
    (song.swatches ??= {})[col.id] = names.map((name, i) => (was[i] && (was[i].label || was[i].hex) === name ? was[i] : swatchFor(name, was[i]?.hex)));
  } else {
    const v = fieldValue(col, String(value));
    if (v !== null) song.fields[col.id] = v;
  }
}

export function listOf(show: Show, songId: string): ListName | null {
  if (show.set_order.includes(songId)) return "set_order";
  if (show.archive.includes(songId)) return "archive";
  return null;
}

export function prevSong(show: Show, songId: string): Song | null {
  const list = listOf(show, songId);
  if (!list) return null;
  const ids = show[list];
  const i = ids.indexOf(songId);
  return i > 0 ? show.songs[ids[i - 1]] : null;
}

export function setField(show: Show, songId: string, colId: string, value: string) {
  show.songs[songId].fields[colId] = value;
}

export function toggleStatus(show: Show, songId: string, colId: string) {
  const s = show.songs[songId];
  s.statuses[colId] = !s.statuses[colId];
}

export function addSong(show: Show, list: ListName, index?: number, name = ""): string {
  const id = newId("s");
  show.songs[id] = { id, fields: { name }, statuses: {}, colours: [] };
  const ids = show[list];
  ids.splice(index ?? ids.length, 0, id);
  return id;
}

export function deleteSong(show: Show, songId: string) {
  show.set_order = show.set_order.filter((x) => x !== songId);
  show.archive = show.archive.filter((x) => x !== songId);
  delete show.songs[songId];
  for (const session of show.sessions) {
    for (const note of session.notes) {
      if (note.song_id === songId) note.song_id = null;
    }
  }
}

/** Move a song to `index` in `list` (index counted after the song is removed from where it was). */
export function moveSong(show: Show, songId: string, list: ListName, index: number) {
  show.set_order = show.set_order.filter((x) => x !== songId);
  show.archive = show.archive.filter((x) => x !== songId);
  const ids = show[list];
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, songId);
}

export function archiveSong(show: Show, songId: string) {
  moveSong(show, songId, "archive", 0);
}

export function restoreSong(show: Show, songId: string) {
  moveSong(show, songId, "set_order", show.set_order.length);
}

// --- columns ------------------------------------------------------------------

export function addColumn(show: Show, label: string, dept: ColumnDef["dept"], type: ColumnDef["type"], options: string[] = []): string {
  const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "col"}_${Math.random().toString(36).slice(2, 5)}`;
  const col: ColumnDef = { id, label: label.toUpperCase(), dept, type, width: type === "longtext" ? 240 : type === "palette" ? 130 : 120 };
  if (type === "colour") col.index = show.columns.filter((c) => c.type === "colour").length;
  if (type === "choice") col.options = cleanOptions(options);
  insertInDept(show, col);
  return id;
}

/** Put a column after the last of its category's fields (the end of the Sheet if the category has none). */
function insertInDept(show: Show, col: ColumnDef) {
  const last = show.columns.map((c) => c.dept).lastIndexOf(col.dept);
  show.columns.splice(last >= 0 ? last + 1 : show.columns.length, 0, col);
}

/**
 * Add a field to a category. A Media field is where images show: the category's first is its media field, the one
 * its media goes in (General's in CORE); more are categories of their own, named by label.
 */
export function addField(show: Show, label: string, dept: Dept, type: ColumnDef["type"]): string {
  if (type !== "image") return addColumn(show, label, dept, type);
  const own = dept === "CORE" ? GENERAL : categoryDept(deptCategory(dept), show) ? deptCategory(dept) : null;
  if (own && !show.columns.some((c) => c.id === own)) {
    ensureCategory(show, own);
    if (label.trim()) show.columns.find((c) => c.id === own)!.label = label.trim().toUpperCase();
    return own;
  }
  return placeInDept(show, addColumn(show, label, dept, "image"));
}

/** Whether a column is a category's own media field (General's SONG IMAGE, CONTENT's…): it stays in its category. */
export const isCategoryMedia = (show: Show, col: ColumnDef) => col.type === "image" && (col.id === GENERAL || Boolean(categoryDept(col.id, show)));

/** The media in an image column: songs with an image in it, and records whose stills are filed in it. */
export function mediaIn(show: Show, colId: string): { songs: number; records: number } {
  return {
    songs: Object.values(show.songs).filter((s) => songImage(s, colId)).length,
    records: (show.records ?? []).filter((r) => r.image_col === colId).length,
  };
}

export function removeColumn(show: Show, colId: string) {
  if (CORE_COLUMN_IDS.includes(colId)) return;
  const col = show.columns.find((c) => c.id === colId);
  show.columns = show.columns.filter((c) => c.id !== colId);
  if (col) keepDept(show, col.dept);
  for (const song of Object.values(show.songs)) {
    delete song.fields[colId];
    delete song.statuses[colId];
    delete song.swatches?.[colId];
    delete song.images?.[colId];
  }
}

// --- categories (departments) ---------------------------------------------------------
// The Sheet's bands: CORE, STATUS, COLOUR, CONTENT… Every field is in one, and each one's fields sit together, in the
// order the categories come in the Sheet. A show can add its own ("LASERS", with a colour of its own). One that has no
// fields stays (in Show.departments) until it's deleted.

/** Band colours for the categories a show adds, in turn. */
const NEW_DEPT_COLOURS = ["#2E8B57", "#B8860B", "#4682B4", "#C71585", "#6A5ACD", "#008B8B", "#8B4513", "#556B2F"];

export const isBuiltInDept = (dept: Dept) => (DEPTS as readonly string[]).includes(dept);

/** The show's categories in Sheet order: those with fields, as they come, then those with none yet. */
export function deptList(show: Show): Dept[] {
  const out: Dept[] = [];
  for (const c of show.columns) if (!out.includes(c.dept)) out.push(c.dept);
  for (const d of show.departments ?? []) if (!out.includes(d.id)) out.push(d.id);
  return out;
}

/** A category's band colour, if the show set one: every category the show added has one; a built-in one has its own
 * (in the Sheet and the app's styles) unless it's been changed. */
export const deptColour = (show: Show, dept: Dept) => show.departments?.find((d) => d.id === dept)?.colour;

/** A category's name in the Sheet's band: its id ("CONTENT", "LASERS") unless it's been renamed. */
export const deptLabel = (show: Show, dept: Dept) => show.departments?.find((d) => d.id === dept)?.label ?? dept;

/** A category's name: "Content", "Choreography", "Lasers"; given the show, what it's been renamed to. */
export const deptName = (dept: Dept, show?: Show) => {
  const label = show?.departments?.find((d) => d.id === dept)?.label;
  return label ? label.charAt(0) + label.slice(1).toLowerCase() : DEPT_CATEGORIES[dept] ?? dept.charAt(0) + dept.slice(1).toLowerCase();
};

/** A category's id from its name or id ("Choreography", "choreo" → CHOREO; "Lasers" → LASERS). */
const deptId = (name: string) => {
  const n = name.trim().toUpperCase();
  return Object.keys(DEPT_CATEGORIES).find((d) => DEPT_CATEGORIES[d]!.toUpperCase() === n) ?? n;
};

/** Add a category (or bring back a built-in one: "Choreography", "SFX"). It has no fields yet. Returns its id. */
export function addDept(show: Show, name: string): Dept {
  const renamed = deptList(show).find((d) => deptLabel(show, d) === name.trim().toUpperCase());
  if (renamed) return renamed;
  const id = deptId(name);
  if (!id || deptList(show).includes(id)) return id;
  const used = new Set((show.departments ?? []).map((d) => d.colour));
  const colour = NEW_DEPT_COLOURS.find((c) => !used.has(c)) ?? NEW_DEPT_COLOURS[(show.departments?.length ?? 0) % NEW_DEPT_COLOURS.length];
  (show.departments ??= []).push(isBuiltInDept(id) ? { id } : { id, colour });
  return id;
}

/** Keep a category that's just lost its last field, so it can be filled again or deleted. */
function keepDept(show: Show, dept: Dept) {
  if (!show.columns.some((c) => c.dept === dept) && !show.departments?.some((d) => d.id === dept)) (show.departments ??= []).push({ id: dept });
}

/** Delete a category. Only an empty one: its fields are deleted or moved first. */
export function removeDept(show: Show, dept: Dept) {
  if (show.columns.some((c) => c.dept === dept)) return;
  show.departments = (show.departments ?? []).filter((d) => d.id !== dept);
}

/**
 * Rename a category (its band, and its media field if that still has its name). Its id stays, so its fields, media
 * and colour go with it. A name another category has is ignored.
 */
export function renameDept(show: Show, dept: Dept, name: string) {
  const label = name.trim().toUpperCase();
  if (!label || deptList(show).some((d) => d !== dept && (d === label || deptLabel(show, d) === label))) return;
  const media = show.columns.find((c) => c.id === deptCategory(dept) && c.type === "image");
  if (media?.label === deptName(dept, show).toUpperCase()) media.label = label;
  let d = show.departments?.find((x) => x.id === dept);
  if (!d) (show.departments ??= []).push((d = { id: dept }));
  if (label === dept) delete d.label;
  else d.label = label;
}

/** Set a category's band colour; null puts a built-in one back to its own. */
export function setDeptColour(show: Show, dept: Dept, colour: string | null) {
  let d = show.departments?.find((x) => x.id === dept);
  if (!d) (show.departments ??= []).push((d = { id: dept }));
  if (colour) d.colour = colour;
  else if (isBuiltInDept(dept)) delete d.colour;
}

/** Move a category's fields to before another category's (null: to the end). CORE stays first. */
export function moveDeptTo(show: Show, dept: Dept, before: Dept | null) {
  if (dept === "CORE" || before === "CORE" || dept === before) return;
  const order = deptList(show).filter((d) => d !== dept && show.columns.some((c) => c.dept === d));
  const at = before ? order.indexOf(before) : -1;
  order.splice(at >= 0 ? at : order.length, 0, dept);
  show.columns = order.flatMap((d) => show.columns.filter((c) => c.dept === d));
  pairClip(show);
}

/**
 * Move a field into a category, before one of its fields (null: after them). A category's media field only moves
 * within its own.
 */
export function placeColumn(show: Show, colId: string, dept: Dept, before: string | null) {
  const col = show.columns.find((c) => c.id === colId);
  if (!col || colId === before || (dept !== col.dept && isCategoryMedia(show, col))) return;
  const from = col.dept;
  show.columns = show.columns.filter((c) => c !== col);
  col.dept = dept;
  const at = before ? show.columns.findIndex((c) => c.id === before && c.dept === dept) : -1;
  if (at >= 0) show.columns.splice(at, 0, col);
  else insertInDept(show, col);
  keepDept(show, from);
  pairClip(show); // the clip column goes with its picture, wherever either is dragged
}

/** Keep each category's fields together, in the order the categories first come. */
export function groupColumns(show: Show) {
  const order = deptList(show);
  show.columns = order.flatMap((d) => show.columns.filter((c) => c.dept === d));
}

/**
 * The image column a show's clips come from: the category most of their records are filed in (General unless
 * named), else the one most records are. Undefined while there are none.
 */
export function clipSource(show: Show): string | undefined {
  const records = show.records ?? [];
  const category = (id: string) => { const r = records.find((x) => x.id === id); return r && (r.image_col ?? GENERAL); };
  let from = Object.values(show.songs).flatMap((s) => (s.clips ?? []).map((c) => category(c.record_id))).filter((c): c is string => Boolean(c));
  if (!from.length) from = records.map((r) => r.image_col ?? GENERAL);
  const count = new Map<string, number>();
  for (const c of from) if (show.columns.some((col) => col.id === c && col.type === "image")) count.set(c, (count.get(c) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Keep the clip column right after the picture its clips come from, in that picture's category: they're a pair. */
export function pairClip(show: Show) {
  const clip = show.columns.find((c) => c.type === "clip");
  const src = show.columns.find((c) => c.id === clipSource(show));
  if (!clip || !src) return;
  const from = clip.dept;
  show.columns = show.columns.filter((c) => c !== clip);
  clip.dept = src.dept;
  show.columns.splice(show.columns.indexOf(src) + 1, 0, clip);
  keepDept(show, from);
}

/** The category a tag names ("Lasers" → a LASERS column, made if there isn't one; "Video" → the Video category). Returns its id. */
export function imageColumnFor(show: Show, tag: string): string {
  const name = tag.trim().toUpperCase();
  if (name === "GENERAL" || name === "SONG IMAGE") return ensureCategory(show, GENERAL);
  if (name === "RENDER") return ensureCategory(show, deptCategory("CONTENT"));
  const dept = Object.keys(DEPT_CATEGORIES).find((d) => d === name || DEPT_CATEGORIES[d]!.toUpperCase() === name);
  if (dept) return ensureCategory(show, deptCategory(dept));
  const have = show.columns.find((c) => c.type === "image" && (c.label === name || categoryName(c, show).toUpperCase() === name));
  if (have) return have.id;
  return placeInDept(show, addColumn(show, name, deptFor(name), "image"));
}

/** Give an image column a picture's width and put it first in its department (after its other pictures), else at the end. */
function placeInDept(show: Show, id: string): string {
  const col = show.columns.find((c) => c.id === id)!;
  col.width = 210;
  show.columns = show.columns.filter((c) => c !== col);
  const inDept = show.columns.map((c, i) => [c, i] as const).filter(([c]) => c.dept === col.dept);
  const firstOther = inDept.find(([c]) => c.type !== "image");
  const at = firstOther ? firstOther[1] : inDept.length ? inDept[inDept.length - 1][1] + 1 : show.columns.length;
  show.columns.splice(at, 0, col);
  return id;
}

// --- categories -------------------------------------------------------------------
// A category is an image column: where a record's thumbnails (and any song image put in it) show, in the Sheet and on
// the slide. There's one per department the show has (Content, Choreography, LX, Video…), in that department's part of the Sheet,
// made the first time something goes in it; more can be added by name ("Lasers"). General is the song's main image
// (`hero`: the SONG IMAGE column, next to its name and BPM), also its card and slide picture. Neither kind can be
// renamed or removed here.

/** The General category: the song's main image. */
export const GENERAL = "hero";

/** The departments that are categories, by name. Each is offered when the show has the department (in Fields). */
const DEPT_CATEGORIES: Record<Dept, string | undefined> = {
  CONTENT: "Content", CHOREO: "Choreography", LX: "LX", VIDEO: "Video", CAMERAS: "Cameras", STAGING: "Staging", SFX: "SFX", MD: "MD",
};

/** A department's category (image column) id. */
export const deptCategory = (dept: Dept) => `img_${dept.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
/** The department whose category (image column) this is: a built-in one's, or (given the show) one the show added. */
const categoryDept = (id: string, show?: Show) =>
  Object.keys(DEPT_CATEGORIES).find((d) => deptCategory(d) === id) ?? (show && deptList(show).find((d) => !isBuiltInDept(d) && deptCategory(d) === id));

export interface Category { id: string; name: string; column: string; fixed: boolean }

/** Every category: General, the show's departments (built-in, then its own), then any added by name. */
export function categories(show: Show): Category[] {
  const images = show.columns.filter((c) => c.type === "image");
  const column = (id: string, label: string) => images.find((c) => c.id === id)?.label ?? label;
  const have = deptList(show);
  const depts = [...DEPTS.filter((d) => DEPT_CATEGORIES[d] && have.includes(d)), ...have.filter((d) => !isBuiltInDept(d))];
  return [
    { id: GENERAL, name: "General", column: column(GENERAL, "SONG IMAGE"), fixed: true },
    ...depts.map((d) => ({ id: deptCategory(d), name: deptName(d, show), column: column(deptCategory(d), deptName(d, show).toUpperCase()), fixed: true })),
    ...images.filter((c) => c.id !== GENERAL && !categoryDept(c.id, show)).map((c) => ({ id: c.id, name: categoryName(c, show), column: c.label, fixed: false })),
  ];
}

/**
 * A category added by name: one the show has ("Video", "Lasers"), else a new department, whose media field is made
 * when media first goes in it. Returns its id.
 */
export function addCategory(show: Show, name: string): string {
  const n = name.trim().toUpperCase();
  const have = categories(show).find((c) => c.name.toUpperCase() === n || c.column === n);
  if (have) return have.id;
  const id = deptId(n);
  if (n === "RENDER" || (isBuiltInDept(id) && !DEPT_CATEGORIES[id])) return imageColumnFor(show, n); // CORE, STATUS, COLOUR: a column of its own
  return deptCategory(addDept(show, n));
}

/** Make sure a category's column exists (General and the departments are made on first use). Returns its id. */
export function ensureCategory(show: Show, id: string): string {
  if (show.columns.some((c) => c.id === id)) return id;
  if (id === GENERAL) {
    const at = show.columns.findIndex((c) => c.dept !== "CORE"); // the end of the CORE columns
    show.columns.splice(at >= 0 ? at : show.columns.length, 0, { id, label: "SONG IMAGE", dept: "CORE", type: "image", width: 210 });
    return id;
  }
  const dept = categoryDept(id, show);
  if (!dept) return id;
  show.columns.push({ id, label: deptName(dept, show).toUpperCase(), dept, type: "image" });
  return placeInDept(show, id);
}

/** Rename a category (and its column). General and the departments keep their names. */
export function renameCategory(show: Show, id: string, name: string) {
  const col = show.columns.find((c) => c.id === id);
  if (col && id !== GENERAL && !categoryDept(id, show) && name.trim()) col.label = name.trim().toUpperCase();
}

/** Delete a category: its column leaves the Sheet and slides; its images stay in each song's gallery. Records filed under it lose their category. */
export function deleteCategory(show: Show, id: string) {
  if (id === GENERAL || categoryDept(id, show)) return;
  removeColumn(show, id);
  for (const r of show.records ?? []) if (r.image_col === id) delete r.image_col;
}

/** Options trimmed, blanks and repeats (in any case) dropped. */
export function cleanOptions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.map((o) => o.trim()).filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
}

/** Add an option to a choice column. */
export function addChoiceOption(show: Show, colId: string, option: string) {
  const col = show.columns.find((c) => c.id === colId);
  if (col?.type === "choice") col.options = cleanOptions([...(col.options ?? []), option]);
}

/** Rename an option, and every song that picked it. Renaming onto another option merges the two. */
export function renameChoiceOption(show: Show, colId: string, from: string, to: string) {
  const col = show.columns.find((c) => c.id === colId);
  const name = to.trim();
  if (col?.type !== "choice" || !name || name === from) return;
  col.options = cleanOptions((col.options ?? []).map((o) => (o === from ? name : o)));
  const canonical = col.options.find((o) => o.toLowerCase() === name.toLowerCase())!;
  for (const song of Object.values(show.songs)) if (song.fields[colId] === from) song.fields[colId] = canonical;
}

/** Take an option off a choice column; songs that picked it are cleared. */
export function removeChoiceOption(show: Show, colId: string, option: string) {
  const col = show.columns.find((c) => c.id === colId);
  if (col?.type !== "choice") return;
  col.options = (col.options ?? []).filter((o) => o !== option);
  for (const song of Object.values(show.songs)) if (song.fields[colId] === option) delete song.fields[colId];
}

/** Move an option up (-1) or down (1) the list. */
export function moveChoiceOption(show: Show, colId: string, option: string, delta: number) {
  const opts = show.columns.find((c) => c.id === colId)?.options;
  const i = opts?.indexOf(option) ?? -1;
  if (!opts || i < 0 || i + delta < 0 || i + delta >= opts.length) return;
  [opts[i], opts[i + delta]] = [opts[i + delta], opts[i]];
}

export function moveColumn(show: Show, colId: string, delta: number) {
  const i = show.columns.findIndex((c) => c.id === colId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= show.columns.length) return;
  const [col] = show.columns.splice(i, 1);
  show.columns.splice(j, 0, col);
}

// --- notes --------------------------------------------------------------------

export function addSession(show: Show, label: string): string {
  const id = newId("sess");
  show.sessions.push({ id, label: label.toUpperCase(), notes: [] });
  return id;
}

export function addNote(show: Show, sessionId: string, songId: string | null, text: string): string {
  const session = show.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  const note: Note = { id: newId("note"), song_id: songId, text, tc: "", from: "", assignee: "", done: false, source: "app" };
  session.notes.push(note);
  return note.id;
}

export function findNote(show: Show, noteId: string): Note | undefined {
  for (const s of show.sessions) {
    const n = s.notes.find((x) => x.id === noteId);
    if (n) return n;
  }
  return undefined;
}

export function deleteNote(show: Show, noteId: string) {
  for (const s of show.sessions) s.notes = s.notes.filter((n) => n.id !== noteId);
}

// --- new show -----------------------------------------------------------------

/** The Pixelmappers default columns (taken from past Pixelmappers show sheets). */
export function defaultColumns(): ColumnDef[] {
  const c = (id: string, label: string, dept: ColumnDef["dept"], type: ColumnDef["type"], width: number, extra: Partial<ColumnDef> = {}): ColumnDef =>
    ({ id, label, dept, type, width, ...extra });
  return [
    c("num", "#", "CORE", "text", 44),
    c("name", "NAME", "CORE", "text", 210),
    c("audio", "AUDIO VERSION", "CORE", "text", 92),
    c("tc", "TC START", "CORE", "tc", 108),
    c("bpm", "BPM", "CORE", "text", 56),
    c("hero", "SONG IMAGE", "CORE", "image", 210),
    c("st_lx_prog", "LX PROG", "STATUS", "tick", 70),
    c("st_vid_prog", "VID PROG", "STATUS", "tick", 74),
    c("st_content_made", "CONTENT MADE", "STATUS", "tick", 104),
    ...[0, 1, 2, 3].map((i) => c(`colour_${i + 1}`, "COLOUR", "COLOUR", "colour", 52, { index: i })),
    c("colref", "COLOUR REF", "COLOUR", "text", 130),
    c("img_content", "CONTENT", "CONTENT", "image", 210),
    c("clip", "CLIP", "CONTENT", "clip", 130),
    c("content_notes", "CONTENT NOTES", "CONTENT", "longtext", 260, { editable: true, on_slide: true }),
    c("lx_notes", "LIGHTING NOTES", "LX", "longtext", 220, { on_slide: true, on_card: true }),
    c("video_notes", "VIDEO DESIGN NOTES", "VIDEO", "longtext", 240, { on_slide: true }),
    c("cam_dir", "CAMERA DIRECTION", "CAMERAS", "longtext", 300, { editable: true, on_slide: true, on_card: true }),
  ];
}

export function newShow(name: string): Show {
  return {
    id: newId("show"),
    name: name.toUpperCase(),
    branding: {},
    columns: defaultColumns(),
    added_columns: ["clip"],
    migrations: ["dept_categories", "general_in_core", "hero_default"],
    set_order: [],
    archive: [],
    songs: {},
    sessions: [{ id: "global", label: "GLOBAL NOTES", notes: [] }],
    setup: { step: 1, done: false },
  };
}

/** Bring shows saved by older versions up to date. Mutates and returns the show. */
export function migrate(show: Show): Show {
  for (const song of Object.values(show.songs)) for (const sw of song.colours) sw.label = gelLabelFor(sw.label);
  if (!show.columns.some((c) => c.id === "bpm")) {
    const at = show.columns.findIndex((c) => c.id === "tc");
    show.columns.splice(at >= 0 ? at + 1 : show.columns.length, 0, { id: "bpm", label: "BPM", dept: "CORE", type: "text", width: 56 });
  }
  // The previous default statuses become the current ones, but only while nothing has been ticked yet.
  const OLD_STATUSES: Record<string, [string, string, string, number]> = {
    st_programmed: ["PROGRAMMED", "st_lx_prog", "LX PROG", 70],
    st_approved: ["APPROVED", "st_vid_prog", "VID PROG", 74],
    st_video: ["VIDEO", "st_content_made", "CONTENT MADE", 104],
  };
  const old = show.columns.filter((c) => OLD_STATUSES[c.id]?.[0] === c.label);
  if (old.length === 3 && !Object.values(show.songs).some((s) => old.some((c) => s.fields[c.id]))) {
    for (const c of old) {
      const [, id, label, width] = OLD_STATUSES[c.id];
      for (const s of Object.values(show.songs)) delete s.fields[c.id];
      Object.assign(c, { id, label, width });
    }
  }
  // Categories became the departments (once). RENDER, the main image, was in CONTENT: it becomes the Content category,
  // and General (SONG IMAGE, in CORE) the main image.
  if (!show.migrations?.includes("dept_categories")) {
    const content = deptCategory("CONTENT");
    const render = show.columns.find((c) => c.id === "hero" && (c.dept === "CONTENT" || c.label === "RENDER"));
    // General had no fixed id at first: an image column labelled SONG IMAGE is it.
    const general = show.columns.find((c) => c.type === "image" && c.id !== "hero" && (c.id === "song_image" || c.label === "SONG IMAGE"));
    // A Content category made by name (when RENDER stopped being one) is the department's.
    const named = show.columns.find((c) => c.type === "image" && c.id !== "hero" && c.id !== content && c.label === "CONTENT");
    if (named && !show.columns.some((c) => c.id === content)) {
      for (const s of Object.values(show.songs)) if (s.images?.[named.id]) { s.images[content] = s.images[named.id]; delete s.images[named.id]; }
      for (const r of show.records ?? []) if (r.image_col === named.id) r.image_col = content;
      Object.assign(named, { id: content, dept: "CONTENT" });
    }
    if (render) {
      // Records filed in RENDER (or before categories) are Content's, and so is each song's render, unless it's another record's still.
      for (const r of show.records ?? []) if (!r.image_col || r.image_col === "hero") r.image_col = content;
      const others = new Set((show.records ?? []).filter((r) => r.image_col !== content).flatMap((r) => recordMedia(show, r.id).stills));
      if (!show.columns.some((c) => c.id === content)) show.columns.splice(show.columns.indexOf(render), 0, { id: content, label: "CONTENT", dept: "CONTENT", type: "image", width: render.width ?? 210 });
      for (const s of Object.values(show.songs)) {
        const r = s.hero_crop?.src ?? s.hero;
        if (r && !others.has(r) && r !== (general && s.images?.[general.id]) && !s.images?.[content]) (s.images ??= {})[content] = r;
      }
      show.columns = show.columns.filter((c) => c !== render);
    }
    if (general) {
      for (const s of Object.values(show.songs)) {
        const g = s.images?.[general.id];
        if (g) { setHero(show, s.id, g); delete s.images![general.id]; }
      }
      for (const r of show.records ?? []) if (r.image_col === general.id) r.image_col = GENERAL;
      show.columns = show.columns.filter((c) => c !== general);
    }
    if (general || render) ensureCategory(show, GENERAL); // with the CORE columns
    (show.migrations ??= []).push("dept_categories", "general_in_core");
  }
  // A first try at the above left SONG IMAGE where the old column was: it goes with the CORE columns (once, so moving it sticks).
  if (!show.migrations?.includes("general_in_core")) {
    const main = show.columns.find((c) => c.id === GENERAL);
    if (main) {
      show.columns = show.columns.filter((c) => c !== main);
      const at = show.columns.findIndex((c) => c.dept !== "CORE");
      show.columns.splice(at >= 0 ? at : show.columns.length, 0, main);
    }
    (show.migrations ??= []).push("general_in_core");
  }
  // The clip column: added once, after the Content picture, so deleting it sticks.
  if (!show.added_columns?.includes("clip")) {
    if (!show.columns.some((c) => c.type === "clip")) {
      const at = show.columns.findIndex((c) => c.dept === "CONTENT");
      show.columns.splice(at >= 0 ? at + 1 : show.columns.length, 0, { id: "clip", label: "CLIP", dept: "CONTENT", type: "clip", width: 130 });
    }
    (show.added_columns ??= []).push("clip");
  }
  if (!show.columns.some((c) => c.on_card)) {
    for (const c of show.columns) if (c.id === "lx_notes" || c.id === "cam_dir") c.on_card = true;
  }
  // Colour fields used to hold one hex in song.fields; they now hold swatches like the lighting colours.
  for (const c of show.columns as { id: string; type: string }[]) {
    if (c.type !== "hex") continue;
    c.type = "palette";
    for (const s of Object.values(show.songs)) {
      const hex = s.fields[c.id];
      delete s.fields[c.id];
      if (hex) (s.swatches ??= {})[c.id] = [swatchFor(hex)];
    }
  }
  // Images filed in a category used to leave the hero empty: songs with images but no hero take one, once.
  if (!show.migrations?.includes("hero_default")) {
    for (const s of Object.values(show.songs)) {
      const first = Object.values(s.images ?? {})[0] ?? s.gallery?.[0];
      if (!s.hero && first) setHero(show, s.id, first);
    }
    (show.migrations ??= []).push("hero_default");
  }
  groupColumns(show); // each category's fields together, as the Fields dialog lists them
  pairClip(show);
  pruneRecordStills(show); // stills deleted from their song before deleting took them off the record too
  return show;
}

// --- media --------------------------------------------------------------------

/**
 * Add imported images to a song's gallery; the first one fills its category (General unless named) if that's free,
 * and becomes the main image if the song has none, whatever its category.
 */
export function addImages(show: Show, songId: string, paths: string[], colId = GENERAL) {
  const song = show.songs[songId];
  song.gallery = [...(song.gallery ?? []), ...paths.filter((p) => !(song.gallery ?? []).includes(p))];
  if (categoryFree(show, song, colId) && paths.length) setSongImage(show, songId, colId, paths[0]);
  if (!song.hero && paths.length) setHero(show, songId, paths[0]);
}

/** Can a new image go in this category? It's empty, or it's General and the main image is only borrowed from another category. */
export function categoryFree(show: Show, song: Song, colId: string): boolean {
  if (!songImage(song, colId)) return true;
  return colId === GENERAL && imageCategory(show, song, song.hero_crop?.src ?? song.hero!) !== "";
}

/** The image in an image column: General is the main image (`hero`), the others are in `images`. */
export function songImage(song: Song, colId: string): string | undefined {
  return colId === "hero" ? song.hero : song.images?.[colId];
}

export function setSongImage(show: Show, songId: string, colId: string, path: string) {
  if (colId === "hero") return setHero(show, songId, path);
  (show.songs[songId].images ??= {})[colId] = path;
}

/** An image column as a category: SONG IMAGE is "General", a department's by its name ("Choreography"), the rest by label ("Lasers"). */
export const categoryName = (col: ColumnDef, show?: Show) => {
  const dept = categoryDept(col.id) ?? (col.id === deptCategory(col.dept) ? col.dept : undefined);
  return col.id === GENERAL ? "General" : dept ? deptName(dept, show) : col.label.charAt(0) + col.label.slice(1).toLowerCase();
};

/** The category (other than General) a song image is in, "" if it's only in the gallery. Being the main image is separate. */
export function imageCategory(show: Show, song: Song, path: string): string {
  return show.columns.find((c) => c.type === "image" && c.id !== "hero" && song.images?.[c.id] === path)?.id ?? "";
}

/**
 * Put a song image in one category (image column), or none (""), taking it out of the one it was in. An image already
 * in that category drops to the gallery. Being the main image (General) is separate (setHero).
 */
export function setImageCategory(show: Show, songId: string, path: string, colId: string) {
  const song = show.songs[songId];
  const from = imageCategory(show, song, path);
  if (from === colId || colId === "hero") return;
  if (from) delete song.images![from];
  if (colId) setSongImage(show, songId, colId, path);
}

/** Every image a song shows in an image column. */
export function songImagePaths(song: Song): string[] {
  return [...(song.hero ? [song.hero] : []), ...Object.values(song.images ?? {})];
}

export function setHero(show: Show, songId: string, path: string) {
  show.songs[songId].hero = path;
  delete show.songs[songId].hero_crop;
}

/** Make a crop of one of the song's images its hero. */
export function setHeroCrop(show: Show, songId: string, src: string, crop: CropRect, path: string) {
  show.songs[songId].hero = path;
  show.songs[songId].hero_crop = { src, ...crop };
}

/** Is this gallery image the hero (itself, or cropped)? */
export const isHeroImage = (song: Song, path: string) => song.hero === path || song.hero_crop?.src === path;

/** Remove from the song (the file stays in the bundle). */
export function removeImage(show: Show, songId: string, path: string) {
  const song = show.songs[songId];
  song.gallery = (song.gallery ?? []).filter((p) => p !== path);
  if (isHeroImage(song, path)) {
    song.hero = song.gallery[0];
    delete song.hero_crop;
  }
  for (const [col, p] of Object.entries(song.images ?? {})) if (p === path) delete song.images![col];
  for (const c of song.clips ?? []) if (c.still === path) delete c.still;
  pruneRecordStills(show);
}

/** Paths of every image the show's songs use, clip stills included. */
function usedImages(show: Show): Set<string> {
  return new Set(Object.values(show.songs).flatMap((s) => [...(s.gallery ?? []), ...songImagePaths(s), ...(s.clips ?? []).flatMap((c) => (c.still ? [c.still] : []))]));
}

/** Every image the show's songs have, in running order (archived songs last): the choices for the show's main image. */
export function showImages(show: Show): { songId: string; path: string }[] {
  const seen = new Set<string>();
  return show.set_order.concat(show.archive).flatMap((sid) => {
    const s = show.songs[sid];
    if (!s) return [];
    return (s.gallery ?? (s.hero ? [s.hero] : [])).filter((p) => !seen.has(p) && seen.add(p)).map((path) => ({ songId: sid, path }));
  });
}

/** The show's main image: the one picked in Show settings while a song still has it, else the first song's hero. */
export function showCover(show: Show): string | undefined {
  if (show.cover && usedImages(show).has(show.cover)) return show.cover;
  return show.set_order.map((id) => show.songs[id]?.hero).find(Boolean);
}

/** Forget record stills no song uses any more: they were deleted from their song and binned, so they'd show broken. */
export function pruneRecordStills(show: Show) {
  const used = usedImages(show);
  for (const r of show.records ?? []) if (r.stills?.some((p) => !used.has(p))) r.stills = r.stills.filter((p) => used.has(p));
}

// --- records, audio, watch folders --------------------------------------------

export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mxf", "avi", "mkv"];
export const AUDIO_EXTENSIONS = ["wav", "aif", "aiff", "mp3", "m4a", "flac", "aac"];

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extension(path: string): string {
  const name = fileName(path);
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function addRecord(show: Show, rec: Omit<SourceRecord, "id" | "added_at" | "name"> & { name?: string }): string {
  const id = newId("rec");
  (show.records ??= []).push({ ...rec, id, name: rec.name ?? fileName(rec.path), added_at: new Date().toISOString() });
  return id;
}

export function addAudio(show: Show, file: Omit<AudioFile, "id" | "added_at" | "name"> & { name?: string }): string {
  const id = newId("aud");
  (show.audio ??= []).push({ ...file, id, name: file.name ?? fileName(file.path), added_at: new Date().toISOString() });
  return id;
}

/** The clips and stills the app made from a record, bundle-relative. */
export function recordMedia(show: Show, id: string): { clips: string[]; stills: string[] } {
  const clips: string[] = [], stills: string[] = [];
  for (const song of Object.values(show.songs)) {
    for (const c of song.clips ?? []) {
      if (c.record_id !== id) continue;
      clips.push(c.path);
      // Clips from before stills were recorded on them share the still's name: media/clips/01 X.mp4 ↔ media/grabs/01 X.jpg (or 01 X_2.jpg).
      const stem = fileName(c.path).replace(/\.[^.]+$/, "");
      const same = (p: string) => p.startsWith("media/grabs/") && new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d+)?\\.jpg$`).test(fileName(p));
      const images = [...new Set([...(song.gallery ?? []), ...songImagePaths(song)])];
      stills.push(...(c.still ? images.filter((p) => p === c.still) : images.filter(same)));
    }
  }
  const own = (show.records ?? []).find((r) => r.id === id)?.stills ?? [];
  return { clips, stills: [...new Set([...stills, ...own])] };
}

/** Remember a still as made from a record. */
export function addRecordStill(show: Show, recordId: string, path: string) {
  const record = (show.records ?? []).find((r) => r.id === recordId);
  if (record && !(record.stills ??= []).includes(path)) record.stills.push(path);
}

/** Take a record's stills off every song (the files go to the Trash separately); its clips stay. */
export function removeRecordStills(show: Show, recordId: string): string[] {
  const { stills } = recordMedia(show, recordId);
  for (const song of Object.values(show.songs)) {
    for (const p of stills) if ((song.gallery ?? []).includes(p) || songImagePaths(song).includes(p)) removeImage(show, song.id, p);
    for (const c of song.clips ?? []) if (c.record_id === recordId) delete c.still;
  }
  const record = (show.records ?? []).find((r) => r.id === recordId);
  if (record) delete record.stills;
  return stills;
}

/**
 * File a record's stills under another category (an image column id): each song's still moves out of the column it
 * was in (RENDER for a record from before categories) and into the new one, if that's empty. Other images stay put.
 */
export function retagRecord(show: Show, recordId: string, category: string) {
  const record = (show.records ?? []).find((r) => r.id === recordId);
  if (!record || !category) return;
  const from = record.image_col ?? "hero";
  const to = ensureCategory(show, category);
  record.image_col = to;
  pairClip(show);
  if (to === from) return;
  const stills = new Set(recordMedia(show, recordId).stills);
  for (const song of Object.values(show.songs)) {
    const still = from === "hero" ? song.hero_crop?.src ?? song.hero : song.images?.[from]; // a cropped hero counts as its source
    if (!still || !stills.has(still)) continue;
    if (from === "hero") {
      // The hero falls back to an image that isn't one of this record's stills, or none.
      song.hero = (song.gallery ?? []).find((p) => !stills.has(p));
      delete song.hero_crop;
    } else delete song.images![from];
    if (!songImage(song, to)) setSongImage(show, song.id, to, still);
  }
}

/** Records that songs still have clips from, though the record itself is gone. */
export function orphanRecordIds(show: Show): string[] {
  const live = new Set((show.records ?? []).map((r) => r.id));
  return [...new Set(Object.values(show.songs).flatMap((s) => (s.clips ?? []).map((c) => c.record_id)).filter((id) => !live.has(id)))];
}

/** Remove a record, and the clips and stills made from it (the record's own file stays where it is). */
export function removeRecord(show: Show, id: string) {
  const { stills } = recordMedia(show, id);
  for (const song of Object.values(show.songs)) {
    if (song.clips?.some((c) => c.record_id === id)) song.clips = song.clips.filter((c) => c.record_id !== id);
    for (const p of stills) if ((song.gallery ?? []).includes(p) || songImagePaths(song).includes(p)) removeImage(show, song.id, p);
  }
  show.records = (show.records ?? []).filter((r) => r.id !== id);
  pairClip(show);
}

export function removeAudio(show: Show, id: string) {
  show.audio = (show.audio ?? []).filter((a) => a.id !== id);
}

/** A song's audio versions, newest first. */
export function songAudio(show: Show, songId: string): AudioFile[] {
  return (show.audio ?? []).filter((a) => a.scope === "song" && a.song_id === songId).reverse();
}

export function showAudio(show: Show): AudioFile[] {
  return (show.audio ?? []).filter((a) => a.scope === "show").reverse();
}

export function songRecords(show: Show, songId: string): SourceRecord[] {
  return (show.records ?? []).filter((r) => r.scope === "song" && r.song_id === songId);
}

export function showRecords(show: Show): SourceRecord[] {
  return (show.records ?? []).filter((r) => r.scope === "show");
}

/** Keeps the AUDIO VERSION field in step with the newest audio file added for the song. */
export function syncAudioField(show: Show, songId: string) {
  const latest = songAudio(show, songId)[0];
  if (latest) show.songs[songId].fields.audio = latest.version;
}

/** Guess a version label from a filename: V4.1, v20250609b, _012025_… */
export function guessVersion(path: string): string {
  const name = fileName(path).replace(/\.[^.]+$/, "");
  const v = name.match(/(?:^|[^a-z])(v\d+(?:\.\d+)*[a-z]?)(?=$|[^a-z0-9.])/i);
  if (v) return v[1].replace(/^v/, "V");
  const date = name.match(/(?:^|\D)(\d{6}|\d{8})(?=$|\D)/);
  return date ? date[1] : "";
}

/** Suggest the song a file is for when its name contains a song name (longest name wins). */
export function guessSong(show: Show, path: string): string | null {
  const name = fileName(path).toLowerCase().replace(/[_\-.]+/g, " ");
  let best: { id: string; len: number } | null = null;
  for (const [id, song] of Object.entries(show.songs)) {
    const n = (song.fields.name ?? "").toLowerCase().trim();
    if (n.length >= 3 && name.includes(n) && (!best || n.length > best.len)) best = { id, len: n.length };
  }
  return best?.id ?? null;
}

export function addWatchFolder(show: Show, path: string): string {
  const id = newId("watch");
  (show.watch_folders ??= []).push({ id, path, label: fileName(path), added_at: new Date().toISOString() });
  return id;
}

export function removeWatchFolder(show: Show, id: string) {
  show.watch_folders = (show.watch_folders ?? []).filter((w) => w.id !== id);
}

/** Split files (oldest first) into sessions wherever there's a gap longer than `gapMs`. */
export function groupSessions<T extends { modified_ms: number }>(files: T[], gapMs = 60 * 60 * 1000): T[][] {
  const out: T[][] = [];
  for (const f of files) {
    const last = out[out.length - 1];
    if (last && f.modified_ms - last[last.length - 1].modified_ms <= gapMs) last.push(f);
    else out.push([f]);
  }
  return out;
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds && seconds !== 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

// --- note fields --------------------------------------------------------------

/** Long-text columns shown on every song card ("Lighting", "Camera direction", …). */
export function noteFields(show: Show): ColumnDef[] {
  return show.columns.filter((c) => c.type === "longtext" && c.on_card);
}

/** "LIGHTING NOTES" → "Lighting", "CAMERA DIRECTION" → "Camera direction". */
export function fieldLabel(col: ColumnDef): string {
  const words = col.label.replace(/\s+NOTES?$/i, "").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DEPT_WORDS: [RegExp, ColumnDef["dept"]][] = [
  [/light|lx|lamp|laser/i, "LX"], [/automation|trim|fly|hoist/i, "STAGING"], [/cam/i, "CAMERAS"], [/video|notch/i, "VIDEO"], [/content|render/i, "CONTENT"], [/choreo|danc/i, "CHOREO"],
  [/stag|set/i, "STAGING"], [/sfx|pyro|fx/i, "SFX"], [/\bmd\b|music|band/i, "MD"],
];

/** The department a field's name suggests ("Laser colour" → LX), CORE if none. */
function deptFor(label: string): ColumnDef["dept"] {
  return DEPT_WORDS.find(([re]) => re.test(label))?.[1] ?? "CORE";
}

/** The kinds of custom field: notes, a line of text, a picked colour, or one of a list. */
export type FieldKind = "longtext" | "text" | "palette" | "choice";

/** Add a custom field to every song (and the Sheet). Notes go on the cards; the rest are data fields. */
export function addCustomField(show: Show, label: string, kind: FieldKind, options: string[] = []): string {
  if (kind === "longtext") return addNoteField(show, label);
  return addColumn(show, label.trim(), deptFor(label), kind, options);
}

/** Add a note field to every song: a long-text column shown on the cards (and in the Sheet). */
export function addNoteField(show: Show, label: string): string {
  const dept = deptFor(label);
  const name = /notes?$/i.test(label.trim()) ? label.trim() : `${label.trim()} notes`;
  const id = addColumn(show, name, dept, "longtext");
  const col = show.columns.find((c) => c.id === id)!;
  col.on_card = true;
  col.on_slide = true;
  return id;
}

/** Rename a field on every song (and in the Sheet). A "… NOTES" column keeps its suffix, so "Lighting" → "Lighting design" is "LIGHTING DESIGN NOTES". */
export function renameField(show: Show, colId: string, name: string) {
  const col = show.columns.find((c) => c.id === colId);
  const label = name.trim();
  if (!col || !label) return;
  col.label = (/\sNOTES?$/i.test(col.label) && !/notes?$/i.test(label) ? `${label} notes` : label).toUpperCase();
}

/** Take a note field off the cards. The column and its notes stay (delete it from Columns). */
export function hideNoteField(show: Show, colId: string) {
  const col = show.columns.find((c) => c.id === colId);
  if (col) col.on_card = false;
}

// --- set list helpers ------------------------------------------------------------

export type SetListField = "name" | "tc" | "bpm" | "version";
export const SET_LIST_FIELDS: SetListField[] = ["name", "tc", "bpm", "version"];
export const DEFAULT_SET_LIST_FORMAT: SetListField[] = ["name", "tc", "bpm", "version"];

const TOKEN: Record<Exclude<SetListField, "name">, RegExp> = {
  tc: /^\d{1,2}:\d{2}(?::\d{2}[:;]\d{2})?$/,
  bpm: /^\d{2,3}(?:\.\d+)?(?:bpm)?$/i,
  version: /^(?:v\d+(?:\.\d+)*[a-z]?|spotify|\d{6}|\d{8})$/i,
};

function fits(field: Exclude<SetListField, "name">, token: string): boolean {
  if (!TOKEN[field].test(token)) return false;
  if (field === "bpm") { const n = parseFloat(token); return n >= 40 && n <= 300; }
  return true;
}

/**
 * Parse a pasted set list, one song per line, in the given column order (e.g. Name, TC, BPM).
 * Columns can be separated by tabs (pasted from a spreadsheet) or just spaces; a missing column is
 * fine ("GEM LINGO 134" has no TC). List numbers ("1.", "02)") and trailing commas are ignored.
 */
export function parseSetList(text: string, format: SetListField[] = DEFAULT_SET_LIST_FORMAT): { name: string; tc: string; version: string; bpm: string }[] {
  const order = format.includes("name") ? format : ["name" as SetListField, ...format];
  return text.split(/\n/).map((raw) => {
    const line = raw.trim().replace(/[,;|]+\s*$/, "").trim();
    if (!line) return null;
    const out = { name: "", tc: "", bpm: "", version: "" };
    const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
    if (cells.length > 1) {
      // Spreadsheet paste: columns by position.
      order.forEach((f, i) => { if (cells[i] !== undefined) out[f] = cells[i]; });
    } else {
      // Space-separated: take each non-name column from the end (or start) if the token looks right.
      const tokens = line.replace(/(\d)\s+bpm\b/i, "$1bpm").split(/\s+/);
      const at = order.indexOf("name");
      for (const f of order.slice(at + 1).reverse() as Exclude<SetListField, "name">[]) {
        if (tokens.length > 1 && fits(f, tokens[tokens.length - 1])) out[f] = tokens.pop()!;
      }
      for (const f of order.slice(0, at) as Exclude<SetListField, "name">[]) {
        if (tokens.length > 1 && fits(f, tokens[0])) out[f] = tokens.shift()!;
      }
      out.name = tokens.join(" ");
    }
    const name = out.name.replace(/^\s*\d+\s*[.)\-–:]\s*/, "").replace(/[,|\t–-]+\s*$/, "").trim(); // "1. " is a list number; "7 Words" is a name
    if (!name) return null;
    const version = out.version.trim();
    return {
      name,
      tc: out.tc ? parseTc(out.tc) ?? "" : "",
      bpm: out.bpm.replace(/\s*bpm$/i, "").trim(),
      version: /^v/i.test(version) ? version.toUpperCase() : version,
    };
  }).filter((r): r is { name: string; tc: string; version: string; bpm: string } => r !== null);
}

/** "4:00" → "04:00:00:00", "04:00:12:05" stays. Null if there's no timecode in the text. */
export function parseTc(text: string): string | null {
  const m = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}):(\d{2}))?\b/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}:${m[4] ?? "00"}`;
}

export function tcSeconds(tc: string, fps = 25): number | null {
  const m = tc.match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / fps;
}

/** Add a song with a name, TC and audio version to the end of the set. */
export function addSongWith(show: Show, name: string, tc = "", version = "", bpm = ""): string {
  const id = addSong(show, "set_order", undefined, name);
  if (tc) show.songs[id].fields.tc = tc;
  if (version) show.songs[id].fields.audio = version;
  if (bpm) show.songs[id].fields.bpm = bpm;
  return id;
}

// --- timecode matching and clips --------------------------------------------------

/**
 * Pair each TC block with the song whose TC start is within `slack` seconds of the block's start.
 * Each song is used once. Returns song ids (or null) in block order.
 */
export function matchBlocks(show: Show, blocks: TcBlock[], fps = 25, slack = 2): (string | null)[] {
  const used = new Set<string>();
  const songs = [...show.set_order, ...show.archive].map((id) => ({ id, t: tcSeconds(show.songs[id].fields.tc ?? "", fps) }));
  return blocks.map((b) => {
    const t = tcSeconds(b.tc_start, fps);
    if (t === null) return null;
    let best: { id: string; d: number } | null = null;
    for (const s of songs) {
      if (s.t === null || used.has(s.id)) continue;
      const d = Math.abs(s.t - t);
      if (d <= slack && (!best || d < best.d)) best = { id: s.id, d };
    }
    if (best) used.add(best.id);
    return best?.id ?? null;
  });
}

/** Seconds → "HH:MM:SS:FF" at `fps` (wraps at 24 hours). */
export function formatTc(seconds: number, fps = 25): string {
  const nominal = Math.round(fps);
  const totalFrames = Math.round(seconds * nominal);
  const f = ((totalFrames % nominal) + nominal) % nominal;
  const whole = Math.floor(totalFrames / nominal);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(whole / 3600) % 24)}:${p(Math.floor(whole / 60) % 60)}:${p(whole % 60)}:${p(f)}`;
}

/** The TC at file time `t` inside a block, where TC runs on from the block's start. */
export function tcAt(block: TcBlock, t: number, fps = 25): string {
  const start = tcSeconds(block.tc_start, fps) ?? 0;
  return formatTc(start + (t - block.file_start), fps);
}

/** The file time inside a block where TC `tc` falls, or null if it isn't in the block. */
export function timeAtTc(block: TcBlock, tc: string, fps = 25): number | null {
  const start = tcSeconds(block.tc_start, fps);
  const target = tcSeconds(tc, fps);
  if (start === null || target === null) return null;
  const t = block.file_start + (target - start);
  return t > block.file_start && t < block.file_end ? t : null;
}

export function setMarks(show: Show, recordId: string, marks: SongMark[]) {
  const rec = (show.records ?? []).find((r) => r.id === recordId);
  if (rec) rec.song_marks = marks;
}

/** The still a song already has from a record: one of the record's stills still in its gallery or image columns. */
export function recordStillOf(show: Show, recordId: string, songId: string): string | undefined {
  const song = show.songs[songId];
  const stills = (show.records ?? []).find((r) => r.id === recordId)?.stills ?? [];
  if (!song || !stills.length) return undefined;
  const mine = new Set([...(song.gallery ?? []), ...songImagePaths(song)]);
  return stills.find((p) => mine.has(p));
}

/** Whether a song has a clip cut from a record for this mark: the same in and out (a moved mark needs cutting again). */
export function hasClipFor(show: Show, recordId: string, mark: SongMark): boolean {
  return (show.songs[mark.song_id]?.clips ?? []).some((c) => c.record_id === recordId && Math.abs(c.in - mark.in) < 0.5 && Math.abs(c.out - mark.out) < 0.5);
}

/**
 * The marks there's still something to make from, so marking one more song in a record doesn't make every song's
 * clip and thumbnail again: with clips, songs with no clip for their mark yet; thumbnails only, songs with no still
 * from the record yet.
 */
export function marksToMake(show: Show, recordId: string, marks: SongMark[], makeClips: boolean): SongMark[] {
  return marks.filter((m) => (makeClips ? !hasClipFor(show, recordId, m) : !recordStillOf(show, recordId, m.song_id)));
}

/** A manual start mark that isn't a song (a break, crowd, a changeover): it only ends the song before it. */
export const GAP = "__gap";

/**
 * Turn manual start marks (one per song, any order) into in/out marks: each song ends where the next mark starts.
 * `GAP` marks end the song before them and make no mark of their own.
 */
export function marksFromStarts(starts: { song_id: string; t: number }[], duration: number): SongMark[] {
  const sorted = [...starts].sort((a, b) => a.t - b.t);
  return sorted.flatMap((s, i) => (s.song_id === GAP ? []
    : [{ song_id: s.song_id, in: s.t, out: i < sorted.length - 1 ? sorted[i + 1].t : duration, source: "manual" as const }]));
}

/** The manual start marks a record's marks came from, with a `GAP` wherever a song ends before the next one starts. */
export function startsFromMarks(marks: SongMark[], duration: number): { song_id: string; t: number }[] {
  const sorted = marks.filter((m) => m.source === "manual").sort((a, b) => a.in - b.in);
  return sorted.flatMap((m, i) => {
    const nextIn = i < sorted.length - 1 ? sorted[i + 1].in : duration;
    return m.out < nextIn - 0.5 ? [{ song_id: m.song_id, t: m.in }, { song_id: GAP, t: m.out }] : [{ song_id: m.song_id, t: m.in }];
  });
}

export function addClip(show: Show, songId: string, clip: Clip) {
  const song = show.songs[songId];
  if (!song) return;
  song.clips = [...(song.clips ?? []).filter((c) => !(c.record_id === clip.record_id && c.in === clip.in)), clip];
  pairClip(show);
}

const RECORD_WORDS = /\b(full\s*show|show\s*record|record|l?tc|timecode|final|master|v\d+)\b|&/gi;

/**
 * What a show record is, guessed from its file name for naming its clips: "OVERMONO - NYC T5 - FULL SHOW & TC.mp4"
 * in the show "OVERMONO 2026" → "NYC T5". Parts naming the artist (the show name's first word) or the kind of file are dropped.
 */
export function guessRecordLabel(show: Show, path: string): string {
  const artist = show.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const parts = fileName(path).replace(/\.[^.]+$/, "").split(/\s+-\s+|_+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => p.toLowerCase() !== artist && p.replace(RECORD_WORDS, "").trim().length > 0);
  return cleanLabel(kept.join(" "));
}

/** Upper case, and nothing that can't go in a file name (or the "_" that separates the name's parts). */
export function cleanLabel(label: string): string {
  return label.replace(/[/\\:*?"<>|_]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * The audio channel carrying LTC, from a file name ending `_LTC-L` (0) or `_LTC-R` (1). Clips cut from a
 * record with LTC keep it on one side and are named this way (see clip_cut in src-tauri/src/lib.rs).
 */
export function ltcFromName(path: string): number | null {
  const side = /_LTC-([LR])(?:\.[^./]*)?$/i.exec(path)?.[1];
  return side ? (side.toUpperCase() === "L" ? 0 : 1) : null;
}

/** A clip's file name: "NYC T5_SHOW RECORD_CLIPPED 01 INTRO". */
export function recordClipName(show: Show, record: SourceRecord, songId: string): string {
  const label = cleanLabel(record.label ?? guessRecordLabel(show, record.path));
  return [label, "SHOW RECORD", `CLIPPED ${clipName(show, songId)}`].filter(Boolean).join("_");
}

/** What a clip is called in the Sheet and on the slide: its record's label ("NYC T5"), else its file name. */
export function clipLabel(show: Show, clip: Clip): string {
  const record = (show.records ?? []).find((r) => r.id === clip.record_id);
  if (record) return cleanLabel(record.label ?? guessRecordLabel(show, record.path)) || record.name;
  return fileName(clip.path).replace(/\.[^.]+$/, "");
}

/** A safe file name for a clip or grab: "03 Diamond Eyes". */
export function clipName(show: Show, songId: string): string {
  const pos = show.set_order.indexOf(songId);
  const name = (show.songs[songId]?.fields.name || "song").replace(/[/\\:*?"<>|]+/g, "-").trim();
  return `${pos >= 0 ? String(pos + 1).padStart(2, "0") + " " : ""}${name}`;
}

/** A folder-safe bundle name from a show name: "DEFTONES | SNW 2026" → "DEFTONES - SNW 2026". */
export function bundleName(showName: string): string {
  return showName.replace(/\s*[|/\\:]+\s*/g, " - ").replace(/[*?"<>]+/g, "").replace(/\s{2,}/g, " ").trim() || "Untitled show";
}

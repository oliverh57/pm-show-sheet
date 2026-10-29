// Other people's edits, as they arrive while a show is open (from Drive, or typed in the Google Sheet): which songs
// they changed and which of each song's fields, so the app can say so (like Google Sheets) and, on Show edits,
// highlight them until that's closed.
//
// Edits typed in the Sheet come in two ways: this Mac's pull of the Sheet, or another Mac's, uploaded with the show.
// A pull notes who typed them in the show (google.sheet_pull), so every Mac puts them down to that person.
import { clipName, fieldLabel } from "../model/ops";
import type { SheetPull, Show } from "../model/types";
import { same } from "./merge";
import { diffShows, type Change } from "./offline";
import type { Editor } from "./show";

/** What changed on one song. */
export interface SongEdits {
  /** Where: column ids ("tc", "lx_notes"…), or "name", "colours", "hero", "gallery", "clips", "records", "comments",
   * "segues_into_next", and "added", "moved", "archived", "restored" for the song as a whole. */
  keys: string[];
  labels: string[]; // the same, as people call them: "TC start", "Lighting", "Moved"
  by: string[]; // who (editorKey), latest last
}

export interface RemoteEdits {
  by: Editor[];
  songs: Record<string, SongEdits>;
  show: string[]; // changes to the show as a whole: "Venue", "Deleted 04 ROSEMARY"
}

/** Who, and where: the same person editing in the app and in the Sheet counts twice (same colour). */
export const editorKey = (e: Editor) => `${e.via === "sheet" ? "sheet:" : ""}${e.email || e.name}`;

/** "Sam Jones", "You, on another Mac", or (in the Sheet) "You". */
export const editorName = (e: Editor) => (e.me ? (e.via === "sheet" ? "You" : "You, on another Mac") : e.name);

/** Whoever typed in the Sheet (from sheetAuthor; null when it can't tell), as an Editor. `myEmail`: the signed-in user's. */
export function sheetEditor(author: { name: string; email?: string } | null, myEmail?: string): Editor {
  const email = author?.email ?? "";
  const me = Boolean(email && myEmail && email.toLowerCase() === myEmail.toLowerCase());
  return { name: author?.name ?? "Someone", email, via: "sheet", ...(me ? { me } : {}) };
}

const SONG_KEYED = new Set(["fields", "statuses", "images", "swatches"]);
const KIND_LABELS: Partial<Record<Change["kind"], string>> = { added: "New song", archived: "Archived", restored: "Back in the set" };
// As the song panel calls them.
const CORE_LABELS: Record<string, string> = { name: "Name", tc: "TC start", bpm: "BPM", audio: "Audio version" };
const PART_LABELS: Record<string, string> = { colours: "Colours", segues_into_next: "Segue", hero: "Main image", reviews: "Comment", records: "Show record", audio: "Audio" };

/** The songs whose place in the running order changed: all but the longest run still in the same order. */
export function movedSongs(before: string[], after: string[]): string[] {
  const common = after.filter((id) => before.includes(id));
  const pos = common.map((id) => before.indexOf(id));
  const len = pos.map(() => 1);
  const prev = pos.map(() => -1);
  pos.forEach((p, i) => {
    for (let j = 0; j < i; j++) if (pos[j] < p && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  });
  const kept = new Set<number>();
  for (let i = len.indexOf(Math.max(0, ...len)); i >= 0; i = prev[i]) kept.add(i);
  return common.filter((_, i) => !kept.has(i));
}

/** Where on a song a change is (see SongEdits.keys), and what to call it. */
function placeOf(c: Change, show: Show): { key: string; label: string } {
  if (KIND_LABELS[c.kind]) return { key: c.kind, label: KIND_LABELS[c.kind]! };
  const [top, , part, col] = c.paths[0] ?? [];
  if (top === "songs" && SONG_KEYED.has(part) && col) {
    const def = show.columns.find((x) => x.id === col);
    return { key: col, label: CORE_LABELS[col] ?? (def ? fieldLabel(def) : c.label) };
  }
  if (top === "songs") return { key: part, label: PART_LABELS[part] ?? c.label };
  if (top === "reviews") return { key: "comments", label: "Comment" };
  return { key: top, label: PART_LABELS[top] ?? c.label };
}

/**
 * What changed from `before` to `after`, and who by (an editorKey, or one for each song and key); null if it's only
 * bookkeeping.
 */
export function editsBetween(before: Show, after: Show, who: string | ((song: string, key: string) => string)): Omit<RemoteEdits, "by"> | null {
  const songs: Record<string, SongEdits> = {};
  const show: string[] = [];
  const note = (id: string, key: string, label: string) => {
    const s = (songs[id] ??= { keys: [], labels: [], by: [] });
    const by = typeof who === "string" ? who : who(id, key);
    s.by = [...s.by.filter((x) => x !== by), by];
    if (!s.keys.includes(key)) s.keys.push(key);
    if (!s.labels.includes(label)) s.labels.push(label);
  };
  for (const c of diffShows(before, after)) {
    if (c.kind === "removed") show.push(`Deleted ${clipName(before, c.song!)}`);
    else if (c.kind === "order") movedSongs(before.set_order, after.set_order).forEach((id) => note(id, "moved", "Moved"));
    else if (c.song && after.songs[c.song]) {
      const { key, label } = placeOf(c, after);
      note(c.song, key, label);
    } else if (!show.includes(c.label)) show.push(c.label);
  }
  return Object.keys(songs).length || show.length ? { songs, show } : null;
}

/** What a pull of the Sheet brought in (`found`, typed by `by`), to keep in the show for other Macs. */
export const sheetPull = (found: Omit<RemoteEdits, "by">, by: Editor): SheetPull => ({
  at: Date.now(),
  by: { name: by.name, ...(by.email ? { email: by.email } : {}) },
  songs: Object.fromEntries(Object.entries(found.songs).map(([id, s]) => [id, s.keys])),
});

/**
 * What came from Drive (`sent` is the show this Mac synced, `merged` what came back), each change put down to whoever
 * made it: if another Mac pulled edits from the Sheet, whoever typed them; the rest to who saved (`savers`).
 */
export function editsFromDrive(sent: Show, merged: Show, savers: Editor[], myEmail?: string): RemoteEdits | null {
  const pull = merged.google?.sheet_pull;
  const sheet = pull && !same(pull, sent.google?.sheet_pull) ? pull : null;
  const typist = sheet ? sheetEditor(sheet.by, myEmail) : null;
  const saver = savers[savers.length - 1] ?? { name: "Someone", email: "" };
  const found = editsBetween(sent, merged, (song, key) => (typist && sheet!.songs[song]?.includes(key) ? editorKey(typist) : editorKey(saver)));
  if (!found) return null;
  const used = new Set(Object.values(found.songs).flatMap((s) => s.by));
  const saved = used.has(editorKey(saver)) || found.show.length > 0;
  const by = [...(saved ? (savers.length ? savers : [saver]) : []), ...(typist && used.has(editorKey(typist)) ? [typist] : [])];
  return { by, ...found };
}

/** `prev` with more edits by `by` added. */
export function addEdits(prev: RemoteEdits | null, by: Editor[], found: Omit<RemoteEdits, "by">): RemoteEdits {
  const out: RemoteEdits = prev ? structuredClone(prev) : { by: [], songs: {}, show: [] };
  for (const e of by) if (!out.by.some((x) => editorKey(x) === editorKey(e))) out.by.push(e);
  for (const [id, s] of Object.entries(found.songs)) {
    const was = (out.songs[id] ??= { keys: [], labels: [], by: [] });
    for (const k of s.keys) if (!was.keys.includes(k)) was.keys.push(k);
    for (const l of s.labels) if (!was.labels.includes(l)) was.labels.push(l);
    was.by = [...was.by.filter((x) => !s.by.includes(x)), ...s.by];
  }
  for (const l of found.show) if (!out.show.includes(l)) out.show.push(l);
  return out;
}

// Google's collaborator colours: one per person, the same on every Mac.
const COLOURS = ["#e8710a", "#1a73e8", "#d93025", "#188038", "#9334e6", "#e52592", "#12a4b8", "#c5221f"];

export function editorColour(key: string): string {
  let h = 2166136261;
  for (const c of key.replace(/^sheet:/, "").toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return COLOURS[h % COLOURS.length];
}

/** The song cells a key covers in the Sheet view. */
function gridColumns(show: Show, key: string): string[] {
  if (key === "colours") return show.columns.filter((c) => c.type === "colour").map((c) => c.id);
  if (key === "clips" || key === "records") return show.columns.filter((c) => c.type === "clip").map((c) => c.id);
  if (key === "moved") return ["num"];
  return show.columns.some((c) => c.id === key) ? [key] : [];
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "\\$&").replace(/\n/g, " ")}"`;

/**
 * The highlights, as CSS: each edited song is outlined in its editor's colour (cards, list rows, the Sheet view's rows,
 * the song panel), and each edited field filled with it. Fields are marked with `data-col` (space-separated keys) inside
 * an element with the song's `data-song-id`; Sheet view cells with `data-cell="<song>|<column>"`.
 */
export function highlightCss(show: Show, edits: RemoteEdits): string {
  const names = new Map(edits.by.map((e) => [editorKey(e), `${editorName(e)}${e.via === "sheet" ? " · Sheet" : ""}`]));
  const out: string[] = [];
  for (const [id, s] of Object.entries(edits.songs)) {
    if (!show.songs[id]) continue;
    const who = s.by[s.by.length - 1] ?? "";
    const song = `[data-song-id=${quote(id)}]`;
    out.push(`${song} { --edit: ${editorColour(who)}; --edit-fill: color-mix(in srgb, var(--edit) 16%, transparent); }`);
    out.push(`.scard${song}, .lrow${song} { box-shadow: 0 0 0 2px var(--edit) !important; border-color: var(--edit) !important; }`);
    out.push(`.scard${song}::after { content: ${quote(names.get(who) ?? "Someone")}; }`);
    out.push(`.grid tr${song} > td.grip, .drawer${song} .dh { box-shadow: inset 3px 0 0 var(--edit); }`);
    if (s.keys.some((k) => ["added", "archived", "restored"].includes(k))) out.push(`.scard${song}, .lrow${song}, .grid tr${song} > td { background: var(--edit-fill) !important; }`);
    const fields = s.keys.map((k) => `${song} [data-col~=${quote(k)}]`);
    const cells = s.keys.flatMap((k) => gridColumns(show, k)).map((col) => `.grid td[data-cell=${quote(`${id}|${col}`)}]`);
    if (fields.length) out.push(`${fields.join(", ")} { background: var(--edit-fill) !important; box-shadow: 0 0 0 1.5px var(--edit) !important; border-radius: 6px; }`);
    if (cells.length) out.push(`${cells.join(", ")} { background: var(--edit-fill) !important; box-shadow: inset 0 0 0 2px var(--edit) !important; }`);
  }
  return out.join("\n");
}

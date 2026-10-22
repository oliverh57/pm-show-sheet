// Pure operations on a show. Each mutates the show it's given; the store clones first.
import type { AudioFile, ColumnDef, ListName, Note, Show, Song, SourceRecord } from "./types";

export const DEPTS = ["CORE", "STATUS", "COLOUR", "CONTENT", "LX", "VIDEO", "CAMERAS", "STAGING", "SFX", "MD"] as const;
export const MAX_SWATCHES = 4;
export const CORE_COLUMN_IDS = ["num", "name"];

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The value a cell shows. A song after a segue shows "Cont." in its TC column. */
export function cellValue(show: Show, col: ColumnDef, song: Song): string | boolean {
  switch (col.type) {
    case "tick":
      return Boolean(song.statuses[col.id]);
    case "colour":
      return song.colours[col.index ?? 0]?.label ?? "";
    case "image":
      return song.hero ?? "";
    case "tc": {
      const prev = prevSong(show, song.id);
      if (prev?.segues_into_next) return "Cont.";
      return song.fields[col.id] ?? "";
    }
    default:
      return song.fields[col.id] ?? "";
  }
}

export function isTextColumn(col: ColumnDef): boolean {
  return col.type === "text" || col.type === "longtext" || col.type === "tc";
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

export function addColumn(show: Show, label: string, dept: ColumnDef["dept"], type: ColumnDef["type"]): string {
  const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "col"}_${Math.random().toString(36).slice(2, 5)}`;
  const col: ColumnDef = { id, label: label.toUpperCase(), dept, type, width: type === "longtext" ? 240 : 120 };
  if (type === "colour") col.index = show.columns.filter((c) => c.type === "colour").length;
  show.columns.push(col);
  return id;
}

export function removeColumn(show: Show, colId: string) {
  if (CORE_COLUMN_IDS.includes(colId)) return;
  show.columns = show.columns.filter((c) => c.id !== colId);
  for (const song of Object.values(show.songs)) {
    delete song.fields[colId];
    delete song.statuses[colId];
  }
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
    c("st_viz", "VIZ", "STATUS", "tick", 44),
    c("st_auto", "AUTO", "STATUS", "tick", 44),
    c("st_lx", "LX", "STATUS", "tick", 44),
    c("st_vid", "VID", "STATUS", "tick", 44),
    ...[0, 1, 2, 3].map((i) => c(`colour_${i + 1}`, "COLOUR", "COLOUR", "colour", 52, { index: i })),
    c("colref", "COLOUR REF", "COLOUR", "text", 130),
    c("hero", "RENDER", "CONTENT", "image", 210),
    c("content_notes", "CONTENT NOTES", "CONTENT", "longtext", 260, { editable: true, on_slide: true }),
    c("lx_notes", "LIGHTING NOTES", "LX", "longtext", 220, { on_slide: true }),
    c("video_notes", "VIDEO DESIGN NOTES", "VIDEO", "longtext", 240, { on_slide: true }),
    c("notch", "NOTCH LAYER", "VIDEO", "text", 110),
    c("cam_fx", "CAMERA SUMMARY & FX", "CAMERAS", "longtext", 220, { on_slide: true }),
    c("cam_dir", "CAMERA DIRECTION", "CAMERAS", "longtext", 300, { editable: true, on_slide: true }),
  ];
}

export function newShow(name: string): Show {
  return {
    id: newId("show"),
    name: name.toUpperCase(),
    branding: {},
    columns: defaultColumns(),
    set_order: [],
    archive: [],
    songs: {},
    sessions: [{ id: "global", label: "GLOBAL NOTES", notes: [] }],
  };
}

// --- media --------------------------------------------------------------------

/** Add imported images to a song's gallery; the first one becomes the hero if it has none. */
export function addImages(show: Show, songId: string, paths: string[]) {
  const song = show.songs[songId];
  song.gallery = [...(song.gallery ?? []), ...paths.filter((p) => !(song.gallery ?? []).includes(p))];
  if (!song.hero && paths.length) song.hero = paths[0];
}

export function setHero(show: Show, songId: string, path: string) {
  show.songs[songId].hero = path;
}

/** Remove from the song (the file stays in the bundle). */
export function removeImage(show: Show, songId: string, path: string) {
  const song = show.songs[songId];
  song.gallery = (song.gallery ?? []).filter((p) => p !== path);
  if (song.hero === path) song.hero = song.gallery[0];
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

export function removeRecord(show: Show, id: string) {
  show.records = (show.records ?? []).filter((r) => r.id !== id);
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

// Working offline. While Google Drive can't be reached, each save stays on this Mac and the copy's edits are held (see
// `holdEdits`): nothing uploads them, even after Drive is back, until someone looks over what changed and approves it.
// This works out each change (song by song, field by field), so they can be kept or thrown away one at a time, and what
// other people changed meanwhile: in Drive, or typed in the Google Sheet (which no app pulls into the show while these
// edits wait, so it's read here).
import { sheetValue, type Edit as SheetEdit } from "../google/sheet";
import { unpulledSheetEdits } from "../google/sync";
import { applySheetValue, clipName, migrate } from "../model/ops";
import type { Show } from "../model/types";
import { same, type MergeConflict } from "./merge";
import { peekDrive } from "./show";

/** Where a value is in a show. A step into a list of things with ids is the thing's id. */
export type Path = string[];

export interface Change {
  id: string; // the same change in two diffs has the same id
  song: string | null; // the song it belongs to; null for the show as a whole
  label: string; // "TC START", "Main image", "Comment", "Venue"…
  kind: "value" | "added" | "removed" | "archived" | "restored" | "order";
  paths: Path[]; // value changes: where (thrown away, these go back as they were)
  before: unknown;
  after: unknown;
  image?: boolean; // the values are images (bundle-relative), or lists of them
  via?: "sheet"; // other people's changes: typed in the Google Sheet (not yet brought into the show)
}

const SONG_KEYED = ["fields", "statuses", "images", "swatches"] as const; // by column id
const SONG_PARTS: Record<string, string> = { colours: "Colours", segues_into_next: "Segue", clips: "Clips" };
const SHOW_PARTS: Record<string, string> = {
  name: "Show name", venue: "Venue", date: "Date", cover: "Cover image", branding: "Logo", records: "Show record",
  audio: "Show audio", watch_folders: "Watch folder", columns: "Column", departments: "Categories", sessions: "Sessions",
  reviews: "Comment", comments: "Comments", keep_resolved_days: "Keeping resolved comments",
};
// Bookkeeping, or covered song by song.
const UNLISTED = new Set(["id", "google", "migrations", "added_columns", "conflicts", "setup", "songs", "set_order", "archive"]);

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const withId = (v: Json): v is { id: string } & Record<string, Json> => isObject(v) && typeof v.id === "string";
const keyed = (v: Json): v is ({ id: string } & Record<string, Json>)[] => Array.isArray(v) && v.length > 0 && v.every(withId);

export function valueAt(show: Json, path: Path): Json {
  let at = show;
  for (const step of path) {
    if (Array.isArray(at)) at = at.find((x) => withId(x) && x.id === step);
    else if (isObject(at)) at = at[step];
    else return undefined;
  }
  return at;
}

/** Put `value` at `path` (undefined removes it), making objects on the way. */
function setAt(show: Json, path: Path, value: Json) {
  let at = show as Record<string, Json>;
  path.forEach((step, i) => {
    const last = i === path.length - 1;
    if (Array.isArray(at)) {
      const n = at.findIndex((x) => withId(x) && x.id === step);
      if (last) {
        if (value === undefined) { if (n >= 0) at.splice(n, 1); } else if (n >= 0) at[n] = value; else at.push(value);
      } else {
        at = at[n] as Record<string, Json>;
      }
    } else if (last) {
      if (value === undefined) delete at[step]; else at[step] = value;
    } else {
      if (!isObject(at[step]) && !Array.isArray(at[step])) at[step] = {};
      at = at[step] as Record<string, Json>;
    }
  });
}

const keys = (a: Json, b: Json) => [...new Set([...Object.keys(isObject(a) ? a : {}), ...Object.keys(isObject(b) ? b : {})])];

/** Every change from `base` to `next`, one for each field, image, comment… */
export function diffShows(base: Show, next: Show): Change[] {
  const out: Change[] = [];
  const colLabel = (col: string) => next.columns.find((c) => c.id === col)?.label ?? base.columns.find((c) => c.id === col)?.label ?? col;
  const value = (song: string | null, label: string, paths: Path[], image?: boolean) => {
    const before = valueAt(base, paths[0]);
    const after = valueAt(next, paths[0]);
    if (paths.every((p) => same(valueAt(base, p), valueAt(next, p)))) return;
    out.push({ id: paths[0].join("/"), song, label, kind: "value", paths, before, after, ...(image ? { image } : {}) });
  };

  for (const id of Object.keys(next.songs)) {
    const was = base.songs[id];
    const now = next.songs[id];
    if (!was) { out.push({ id: `songs/${id}`, song: id, label: "Song added", kind: "added", paths: [], before: undefined, after: now }); continue; }
    if (same(was, now)) continue;
    for (const part of SONG_KEYED) {
      for (const col of keys(was[part], now[part])) value(id, colLabel(col), [["songs", id, part, col]], part === "images");
    }
    value(id, "Main image", [["songs", id, "hero"], ["songs", id, "hero_crop"]], true);
    value(id, "Gallery", [["songs", id, "gallery"]], true);
    for (const k of keys(was, now)) {
      if (!["id", "hero", "hero_crop", "gallery", ...SONG_KEYED].includes(k)) value(id, SONG_PARTS[k] ?? k, [["songs", id, k]]);
    }
  }
  for (const id of Object.keys(base.songs)) {
    if (!next.songs[id]) out.push({ id: `songs/${id}`, song: id, label: "Song removed", kind: "removed", paths: [], before: base.songs[id], after: undefined });
  }
  for (const id of next.archive) {
    if (base.set_order.includes(id)) out.push({ id: `archive/${id}`, song: id, label: "Archived", kind: "archived", paths: [], before: "set_order", after: "archive" });
  }
  for (const id of next.set_order) {
    if (base.archive.includes(id)) out.push({ id: `archive/${id}`, song: id, label: "Brought back", kind: "restored", paths: [], before: "archive", after: "set_order" });
  }
  const kept = (a: string[], b: string[]) => a.filter((id) => b.includes(id));
  if (!same(kept(base.set_order, next.set_order), kept(next.set_order, base.set_order))) {
    out.push({ id: "set_order", song: null, label: "Running order", kind: "order", paths: [], before: base.set_order, after: next.set_order });
  }

  for (const k of keys(base, next) as (keyof Show)[]) {
    if (UNLISTED.has(k) || same(base[k], next[k])) continue;
    const label = SHOW_PARTS[k] ?? k;
    const [b, n] = [base[k] ?? [], next[k] ?? []];
    if ((keyed(b) || !(b as Json[]).length) && (keyed(n) || !(n as Json[]).length) && Array.isArray(b) && Array.isArray(n)) {
      // A list of things (comments, records, columns): each thing is a change of its own.
      const before = out.length;
      for (const id of new Set([...b, ...n].map((x) => (x as { id: string }).id))) {
        const item = (n.find((x) => (x as { id: string }).id === id) ?? b.find((x) => (x as { id: string }).id === id)) as Record<string, Json>;
        const song = typeof item.song_id === "string" && (next.songs[item.song_id] || base.songs[item.song_id]) ? item.song_id : null;
        value(song, label, [[k, id]]);
      }
      if (out.length > before) continue; // only the order changed otherwise
    }
    value(null, label, [[k]]);
  }
  return out;
}

/** `ref`'s order for the items of `list` that are in it, leaving the others where they are. */
const reorder = (list: string[], ref: string[]) => {
  const common = ref.filter((x) => list.includes(x));
  let i = 0;
  return list.map((x) => (ref.includes(x) ? common[i++] : x));
};

/** Put `id` back into `list` where it is in `ref`: after the nearest item before it that's in `list`. */
function insertLike(list: string[], ref: string[], id: string) {
  if (list.includes(id)) return;
  const i = ref.indexOf(id);
  for (let j = i - 1; j >= 0; j--) {
    const k = list.indexOf(ref[j]);
    if (k >= 0) return void list.splice(k + 1, 0, id);
  }
  list.unshift(id);
}

/** `local` with the changes in `thrown` (ids of `changes`, made from `base` to `local`) put back as they were in `base`. */
export function throwAway(base: Show, local: Show, changes: Change[], thrown: Set<string>): Show {
  const out = structuredClone(local);
  putBack(base, out, changes, thrown);
  return out;
}

/** Put the changes in `ids` (of `changes`, made from `from` to `show`) back as they are in `from`, in place. */
export function putBack(from: Show, show: Show, changes: Change[], ids: Set<string>) {
  const these = changes.filter((c) => ids.has(c.id));
  const listOf = (id: string) => (from.set_order.includes(id) ? "set_order" : "archive");
  for (const c of these) {
    if (c.kind === "value") for (const p of c.paths) setAt(show, p, structuredClone(valueAt(from, p)));
    if (c.kind === "added" && c.song) {
      delete show.songs[c.song];
      show.set_order = show.set_order.filter((x) => x !== c.song);
      show.archive = show.archive.filter((x) => x !== c.song);
    }
    if ((c.kind === "removed" || c.kind === "archived" || c.kind === "restored") && c.song) {
      if (c.kind === "removed") show.songs[c.song] = structuredClone(from.songs[c.song]);
      show.set_order = show.set_order.filter((x) => x !== c.song);
      show.archive = show.archive.filter((x) => x !== c.song);
      insertLike(show[listOf(c.song)], from[listOf(c.song)], c.song);
    }
  }
  if (these.some((c) => c.kind === "order")) show.set_order = reorder(show.set_order, from.set_order);
  for (const c of these) {
    const top = c.paths[0]?.[0] as keyof Show | undefined; // a list emptied by putting its things back: as it was, if it wasn't there
    if (top && from[top] === undefined && Array.isArray(show[top]) && !(show[top] as Json[]).length) delete show[top];
  }
}

/**
 * What to upload once the review's done: `local` with the changes in `thrown` put back, and the Sheet edits that kept
 * changes replace marked as seen (so the next pull of the Sheet doesn't bring them back, or call them a clash).
 */
export function settle(r: OfflineReview, local: Show, thrown: Set<string>): Show {
  const out = throwAway(r.base, local, r.mine, thrown);
  const fromSheet = new Set(r.theirs.filter((c) => c.via === "sheet").map((c) => c.id));
  for (const c of r.mine) {
    if (c.kind !== "value" || thrown.has(c.id) || !fromSheet.has(c.id)) continue;
    const [, song, , colId] = c.paths[0];
    const col = r.drive.columns.find((x) => x.id === colId);
    if (!col || !r.drive.songs[song]) continue;
    out.google = { ...out.google, published: { ...out.google?.published, [`show|${song}|${colId}`]: sheetValue(r.drive, col, r.drive.songs[song]) } };
  }
  return out;
}

/** The ids of my changes that someone else changed too. */
export const clashes = (r: OfflineReview) => {
  const theirs = new Set(r.theirs.map((c) => c.id));
  return new Set(r.mine.filter((c) => theirs.has(c.id)).map((c) => c.id));
};

/** A change's value in one version of the show. */
export function valueIn(c: Change, show: Show): unknown {
  if (c.kind === "added" || c.kind === "removed") return c.song ? show.songs[c.song] : undefined;
  if (c.kind === "archived" || c.kind === "restored") return c.song && show.archive.includes(c.song) ? "archive" : c.song && show.set_order.includes(c.song) ? "set_order" : undefined;
  if (c.kind === "order") return show.set_order;
  return valueAt(show, c.paths[0]);
}

/** A change's song, as it's named in whichever show has it. */
export const songName = (c: Change, ...shows: Show[]) => {
  const show = shows.find((s) => c.song && s.songs[c.song]);
  return show && c.song ? clipName(show, c.song) : "Song";
};

export interface OfflineReview {
  /** The show as last agreed with Drive. */
  base: Show;
  /** The show as others have it now: Drive's, with edits typed in the Google Sheet since. */
  drive: Show;
  /** What was changed on this Mac while offline. */
  mine: Change[];
  /** What other people changed meanwhile, in Drive or the Sheet. */
  theirs: Change[];
  /** False if the Sheet couldn't be read, so edits typed there may be missing. */
  sheetChecked: boolean;
}

/** The show as last agreed with Drive, with today's one-time fixes run (so they don't count as edits made offline). */
export const agreed = (base: Show) => migrate(structuredClone(base));

/** Look over the edits held on this Mac (`local`) against Drive and the Sheet. Throws if Drive can't be reached. */
export async function reviewOffline(bundle: string, local: Show, readSheet: (show: Show) => Promise<SheetEdit[]> = unpulledSheetEdits): Promise<OfflineReview> {
  const peek = await peekDrive(bundle);
  if (!peek.base && !peek.theirs) throw new Error("There's no copy of the show from Google Drive to compare with");
  const base = agreed(peek.base ?? peek.theirs!);
  const inDrive = peek.theirs ? agreed(peek.theirs) : base;
  const drive = structuredClone(inDrive);
  let sheetChecked = true;
  try {
    for (const e of await readSheet(drive)) {
      const col = drive.columns.find((c) => c.id === e.colId);
      if (col) applySheetValue(drive, e.songId, col, e.value);
    }
  } catch {
    sheetChecked = false;
  }
  const fromSheet = new Set(diffShows(inDrive, drive).map((c) => c.id));
  const theirs = diffShows(base, drive).map((c): Change => (fromSheet.has(c.id) ? { ...c, via: "sheet" } : c));
  return { base, drive, mine: diffShows(base, local), theirs, sheetChecked };
}

// --- clashes while online ----------------------------------------------------------------------

/**
 * Something this Mac and someone else both changed, while online: in Drive at the same time, or typed in the Google
 * Sheet. The show has this Mac's version (and so has Drive) until someone picks theirs.
 */
export interface Clash {
  change: Change; // this Mac's change; its id is the clash's
  theirs: Show; // the show as they have it: their version is read from it, and taken from it if picked
  sheetKeys?: string[]; // the Sheet edits' keys in show.conflicts, dropped once it's settled
}

const startsWith = (a: Path, b: Path) => b.length <= a.length && b.every((x, i) => x === a[i]);
const overlaps = (a: Path, b: Path) => a.length > 0 && b.length > 0 && (startsWith(a, b) || startsWith(b, a));

/** The clashes in a merge of `mine` with `theirs` (both changed since `base`), where `conflicts` kept mine. */
export function mergeClashes(base: Show, mine: Show, theirs: Show, conflicts: MergeConflict[]): Clash[] {
  const at = conflicts.map((k) => k.path.map(String));
  // A song they removed that I changed: one clash for the song, not one for each thing changed in it.
  const gone = new Set(at.filter((p) => p.length === 2 && p[0] === "songs" && !theirs.songs[p[1]] && mine.songs[p[1]]).map((p) => p[1]));
  const songs: Change[] = [...gone].map((id) => ({ id: `songs/${id}`, song: id, label: "Song", kind: "added", paths: [], before: undefined, after: mine.songs[id] }));
  const rest = diffShows(base, mine).filter((c) => !(c.song && gone.has(c.song)) && at.some((p) => [...c.paths, c.id.split("/")].some((q) => overlaps(p, q))));
  return [...songs, ...rest].map((change) => ({ change, theirs }));
}

/**
 * The Sheet edits that clashed with the app (show.conflicts): the app's value is in the show and the Sheet for now. Only
 * those whose app edit was `me`'s (an email), or that no one could put down to anyone: the others are for whoever made it.
 */
export function sheetClashes(show: Show, me?: string): Clash[] {
  const found = Object.entries((show.conflicts ?? {}) as Record<string, { sheet: string | boolean; by?: string }>).flatMap(([key, c]) => {
    if (c.by && c.by !== me?.toLowerCase()) return [];
    const [, song, colId] = key.split("|");
    const col = show.columns.find((x) => x.id === colId);
    return col && show.songs[song] ? [{ key, song, col, value: c.sheet }] : [];
  });
  if (!found.length) return [];
  const theirs = structuredClone(show);
  for (const f of found) applySheetValue(theirs, f.song, f.col, f.value);
  return diffShows(show, theirs).flatMap((change) => {
    const path = change.paths[0] ?? [];
    const keys = found.filter((f) => change.song === f.song && (path.includes(f.col.id) || (f.col.type === "colour" && path[2] === "colours"))).map((f) => f.key);
    return keys.length ? [{ change: { ...change, via: "sheet" as const }, theirs, sheetKeys: keys }] : [];
  });
}

/** The clashes still waiting for `me` to pick: `drive`'s (newest last) and the Sheet's, less any no longer different. */
export function openClashes(show: Show, drive: Clash[], me?: string): Clash[] {
  const byId = new Map<string, Clash>();
  for (const c of [...drive, ...sheetClashes(show, me)]) byId.set(c.change.id, c);
  return [...byId.values()].filter((c) => !same(valueIn(c.change, c.theirs), valueIn(c.change, show)));
}

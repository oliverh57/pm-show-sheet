// A show's media in Google Drive: renders, stills, crops and clips under media/ in the show's folder. Files made on
// this Mac go up after each save (anything the show uses that's here but not in Drive yet), so nothing needs queueing:
// an upload that didn't finish is simply tried again next time. Files made on other Macs come down when they're first
// shown or played (src-tauri/src/drive.rs fetches them for the media server).
import { create } from "zustand";
import { backend } from "../backend";
import { songImagePaths } from "../model/ops";
import type { Show } from "../model/types";
import { child, children, createFolder, FOLDER, notFound, trashFile } from "./api";
import { readManifest, serial, updateManifest, type Manifest } from "./show";

const SKIP = new Set(["Slides images", "presence", "thumbs", "proxies"]); // the deck's own copies, and what was only ever per-Mac

/** A file going up or coming down now: its name, and the bytes moved so far of `size` (0 until Drive says). */
export interface Transfer { id: string; name: string; sent: number; size: number }
/**
 * Files in a run of uploads (or downloads), how many are done, and the ones going now, with the bytes moved by the ones
 * done (for the time left). Back to 0 once all are done.
 */
export interface TransferRun { total: number; done: number; moved: number; active: Transfer[] }
interface Transfers {
  /** Media paths uploading, for the "Uploading…" badges. */
  uploading: string[];
  /** For the progress bars (src/components/TransferProgress.tsx). */
  up: TransferRun;
  down: TransferRun;
}
const IDLE: TransferRun = { total: 0, done: 0, moved: 0, active: [] };
export const useTransfers = create<Transfers>(() => ({ uploading: [], up: IDLE, down: IDLE }));
const setUploading = (fn: (cur: string[]) => string[]) => useTransfers.setState((s) => ({ uploading: fn(s.uploading) }));
const setRun = (dir: "up" | "down", fn: (r: TransferRun) => TransferRun) => useTransfers.setState((s) => ({ [dir]: fn(s[dir]) }));
const report = (r: TransferRun, id: string, sent: number, size: number): TransferRun => ({ ...r, active: r.active.map((t) => (t.id === id ? { ...t, sent, size } : t)) });
function finish(r: TransferRun, id: string): TransferRun {
  const active = r.active.filter((t) => t.id !== id);
  const done = r.done + 1;
  const moved = r.moved + (r.active.find((t) => t.id === id)?.sent ?? 0);
  return active.length || done < r.total ? { ...r, active, done, moved } : IDLE;
}
let uploadSeq = 0;

/** Count `n` more files into the upload progress bar. Each must then go up through `trackUpload` (or the bar never finishes). */
export function willUpload(n: number) {
  if (n > 0) setRun("up", (r) => ({ ...r, total: r.total + n }));
}

/** Upload a file (named `name`), shown in the progress bar while it goes. `run` reports the bytes sent. */
export async function trackUpload<T>(name: string, run: (onProgress: (sent: number, size: number) => void) => Promise<T>): Promise<T> {
  const id = `up${++uploadSeq}`;
  setRun("up", (r) => ({ ...r, active: [...r.active, { id, name, sent: 0, size: 0 }] }));
  try {
    return await run((sent, size) => setRun("up", (r) => report(r, id, sent, size)));
  } finally {
    setRun("up", (r) => finish(r, id));
  }
}

/**
 * Follow the media the Rust side downloads from Drive (for the player and images, and Download on a show's card) into
 * the download progress bar. Each download counts in when it starts. Returns a function that stops.
 */
export function watchDownloads(): () => void {
  return backend.onDownloadProgress(({ id, received, total, done }) => setRun("down", (r) => {
    const known = r.active.some((t) => t.id === id);
    if (done) return known ? finish(r, id) : r;
    if (known) return report(r, id, received, total);
    return { ...r, total: r.total + 1, active: [...r.active, { id, name: id.split("/").pop() ?? id, sent: received, size: total }] };
  }));
}

/** The bytes a run has moved so far, and about how many are left: files whose size isn't known yet count the average. */
export function runBytes(r: TransferRun): { moved: number; left: number | null } {
  const moved = r.moved + r.active.reduce((n, t) => n + t.sent, 0);
  const sized = r.active.filter((t) => t.size > 0);
  if (!sized.length && !r.done) return { moved, left: null };
  const average = (sized.reduce((n, t) => n + t.size, 0) + r.moved) / (sized.length + r.done);
  const unsized = Math.max(r.total, r.done + r.active.length) - r.done - sized.length;
  return { moved, left: sized.reduce((n, t) => n + Math.max(0, t.size - t.sent), 0) + unsized * average };
}

/** About how long is left, in words: "About 2 minutes left". */
export function formatTimeLeft(secs: number): string {
  if (secs < 10) return "A few seconds left";
  if (secs < 50) return `About ${Math.ceil(secs / 10) * 10} seconds left`;
  const min = Math.max(1, Math.round(secs / 60));
  if (min < 60) return `About ${min} minute${min === 1 ? "" : "s"} left`;
  const h = Math.floor(min / 60);
  return `About ${h} hour${h === 1 ? "" : "s"}${min % 60 ? ` ${min % 60} min` : ""} left`;
}

let cancels = 0;

/** Cancel on the download progress bar: stop the downloads in it, and the runs of them (`cancelsSoFar`). */
export async function cancelDownloads() {
  cancels++;
  await backend.cancelDownloads();
}
/** How many times Cancel has been pressed: a run of downloads that started before it stops. */
export const cancelsSoFar = () => cancels;
/** A note from `backend.driveFetch` for a file that didn't download because of Cancel. */
export const cancelledNote = (note: string) => note.endsWith(": cancelled");

/** Every media path the show uses (bundle-relative): images, crops, clips and their stills, song audio, comment frames, the cover. */
export function showMedia(show: Show): string[] {
  const songs = Object.values(show.songs ?? {});
  const paths = [
    ...songs.flatMap((s) => [...(s.gallery ?? []), ...songImagePaths(s), s.hero_crop?.src ?? "", ...(s.clips ?? []).flatMap((c) => [c.path, c.still ?? ""])]),
    ...(show.records ?? []).flatMap((r) => r.stills ?? []),
    ...(show.audio ?? []).map((a) => a.path), // song audio, copied into the show (show audio is linked in place)
    ...(show.reviews ?? []).flatMap((c) => [c.still ?? "", c.image ?? ""]),
    show.cover ?? "",
    show.branding?.logo ?? "",
  ];
  return [...new Set(paths.filter((p) => p.startsWith("media/") && !p.split("/").includes("..")))];
}

/** List the show's folder in Drive: every media file and folder, by bundle-relative path. */
export async function refreshManifest(bundle: string): Promise<Manifest> {
  const m = await readManifest(bundle);
  const files: Manifest["files"] = {};
  const folders: Manifest["folders"] = {};
  const walk = async (id: string, prefix: string) => {
    for (const f of await children(id)) {
      const rel = `${prefix}${f.name}`;
      if (f.mimeType === FOLDER) {
        if (prefix === "" && SKIP.has(f.name ?? "")) continue;
        folders[rel] = f.id;
        await walk(f.id, `${rel}/`);
      } else if (prefix && !f.mimeType?.startsWith("application/vnd.google-apps.")) {
        files[rel] = { id: f.id, md5: f.md5Checksum, modified: Date.parse(f.modifiedTime ?? "") || undefined, size: Number(f.size) || undefined };
      }
    }
  };
  await walk(m.folderId, "");
  return updateManifest(bundle, (x) => { x.files = files; x.folders = folders; });
}

/** The Drive folder for a bundle-relative folder ("media/clips"), made if it isn't there. */
async function folderFor(bundle: string, dir: string): Promise<string> {
  const m = await readManifest(bundle);
  if (m.folders[dir]) return m.folders[dir];
  let parent = m.folderId;
  let path = "";
  for (const name of dir.split("/")) {
    path = path ? `${path}/${name}` : name;
    const known = (await readManifest(bundle)).folders[path];
    const id = known ?? (await child(parent, name))?.id ?? (await createFolder(name, parent)).id;
    if (!known) await updateManifest(bundle, (x) => { x.folders[path] = id; });
    parent = id;
  }
  return parent;
}

/** Upload the media the show uses that's on this Mac but not in Drive yet. Returns a note for each that failed. */
export function uploadNewMedia(bundle: string, show: Show): Promise<string[]> {
  return serial(`media:${bundle}`, async () => {
    const m = await readManifest(bundle);
    const todo = showMedia(show).filter((rel) => !m.files[rel]);
    if (!todo.length) return [];
    const here = await backend.pathsExist(todo.map((rel) => `${bundle}/${rel}`));
    const notes: string[] = [];
    willUpload(here.filter(Boolean).length);
    for (const [i, rel] of todo.entries()) {
      if (!here[i]) continue; // made on another Mac: it's in Drive (or will be when that Mac uploads it)
      const dir = rel.split("/").slice(0, -1).join("/");
      const name = rel.split("/").pop()!;
      setUploading((cur) => [...cur, rel]);
      try {
        await trackUpload(name, async (onProgress) => {
          const parent = await folderFor(bundle, dir);
          // Downloaded here from Drive rather than made here: it's there already.
          const there = await child(parent, name, "id,md5Checksum");
          const file = there ?? (await backend.driveUpload(`${bundle}/${rel}`, { parent, name }, onProgress));
          const [size] = await backend.pathSizes([`${bundle}/${rel}`]);
          await updateManifest(bundle, (x) => { x.files[rel] = { id: file.id, md5: file.md5Checksum, modified: Date.now(), size: size || undefined }; });
        });
      } catch (e) {
        notes.push(`${name}: ${String(e).replace(/^Error: /, "")}`);
      } finally {
        setUploading((cur) => cur.filter((p) => p !== rel));
      }
    }
    return notes;
  });
}

/** Move media files (bundle-relative) to the bin: on this Mac and in Google Drive. */
export async function trashMedia(bundle: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  await backend.trashFiles(bundle, paths);
  const m = await readManifest(bundle);
  const gone: string[] = [];
  for (const rel of paths) {
    let id: string | undefined = m.files[rel]?.id;
    if (!id) {
      const dir = m.folders[rel.split("/").slice(0, -1).join("/")];
      id = dir ? (await child(dir, rel.split("/").pop()!).catch(() => null))?.id : undefined;
    }
    if (!id) continue;
    try {
      await trashFile(id);
      gone.push(rel);
    } catch (e) {
      if (notFound(e)) gone.push(rel);
      else throw e;
    }
  }
  if (gone.length) await updateManifest(bundle, (x) => { for (const rel of gone) delete x.files[rel]; });
}

/** The Drive id of a file or folder in a show's copy (absolute path), if it's in Drive. */
export async function driveIdOf(path: string, bundle: string): Promise<string | null> {
  const m = await readManifest(bundle);
  if (path === bundle) return m.folderId;
  const rel = path.slice(bundle.length + 1);
  if (m.files[rel]) return m.files[rel].id;
  if (m.folders[rel]) return m.folders[rel];
  let parent = m.folderId;
  for (const name of rel.split("/")) {
    const found = await child(parent, name).catch(() => null);
    if (!found) return null;
    parent = found.id;
  }
  return parent;
}

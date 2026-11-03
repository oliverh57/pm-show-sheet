// Space on this Mac: a show's clips and images are copies of what's in Google Drive (src/drive/), so they can be
// removed from this Mac and download again the next time they're shown. "Remove downloads of unused shows" is per
// Mac (localStorage, like the theme): once a day after All shows looks for shows, the clips of shows not opened on
// this Mac for that long are removed. Images stay: they're small, and the songs page shows them as soon as a show opens.
// Records and audio are on this Mac's disks (or an external one), not in Drive, so they're never removed.
//
// A show can be kept downloaded on this Mac (`keep` in its manifest, so it's per Mac): all its media is downloaded,
// neither the sweep nor the cache limit removes it, and new media in Drive comes down when the app starts, when it's
// back online and every few minutes (`watchKeptShows`).
import { create } from "zustand";
import { backend, IMAGE_EXTENSIONS } from "./backend";
import { cancelledNote, cancelsSoFar, refreshManifest } from "./drive/media";
import { isOffline } from "./drive/live";
import { readManifest, serial, updateManifest } from "./drive/show";
import { AUDIO_EXTENSIONS, extension, songImagePaths } from "./model/ops";
import type { Show } from "./model/types";
import { useStore } from "./store";

const KEY = "pm.removeDownloadsAfterDays";
const LIMIT_KEY = "pm.mediaCacheLimit";
const GB = 1e9;
const LAST_SWEEP_KEY = "pm.downloadsSweptAt";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where a file is. A show's media: "local" (on this Mac and in Drive), "online" (only in Drive), "uploading" (only
 * on this Mac so far), "missing" (nowhere). A record or audio file: "na" when it's on this Mac, else "missing".
 */
export type FileState = "local" | "online" | "uploading" | "missing" | "na";

/** Days a show goes unopened before its downloads are removed; 0 for never. */
export const UNUSED_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: "Never" },
  { days: 7, label: "After a week" },
  { days: 14, label: "After 2 weeks" },
  { days: 30, label: "After a month" },
  { days: 90, label: "After 3 months" },
];

function readDays(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return UNUSED_OPTIONS.some((o) => o.days === v) ? v : 0;
  } catch {
    return 0;
  }
}

/** The most the media cache may take up on this Mac; over it, the media used longest ago makes room for new downloads. */
export const LIMIT_OPTIONS: { bytes: number; label: string }[] = [
  { bytes: 0, label: "No limit" },
  ...[10, 25, 50, 100, 250, 500].map((n) => ({ bytes: n * GB, label: `${n} GB` })),
];

function readLimit(): number {
  try {
    const v = Number(localStorage.getItem(LIMIT_KEY));
    return LIMIT_OPTIONS.some((o) => o.bytes === v) ? v : 0;
  } catch {
    return 0;
  }
}

export const useStorage = create<{ unusedDays: number; cacheLimit: number }>(() => ({ unusedDays: readDays(), cacheLimit: readLimit() }));

/** Tell the app's downloads the cache limit (at launch, and when it's changed), trimming the cache to it. Bytes freed. */
export async function applyCacheLimit(): Promise<number> {
  return backend.isDesktop ? backend.driveSetCacheLimit(useStorage.getState().cacheLimit) : 0;
}

export function setCacheLimit(bytes: number): Promise<number> {
  try { localStorage.setItem(LIMIT_KEY, String(bytes)); } catch { /* storage unavailable */ }
  useStorage.setState({ cacheLimit: bytes });
  return applyCacheLimit();
}

export function setUnusedDays(days: number) {
  try { localStorage.setItem(KEY, String(days)); } catch { /* storage unavailable */ }
  useStorage.setState({ unusedDays: days });
}

/** Absolute paths of a show's media: records, audio and clips, and with `images` its renders and stills too. */
export function showMediaPaths(bundle: string, show: Show, images: boolean): string[] {
  const abs = (p: string) => (p.startsWith("/") ? p : `${bundle}/${p}`);
  const songs = Object.values(show.songs ?? {});
  return [...new Set([
    ...(show.records ?? []).map((r) => r.path),
    ...(show.audio ?? []).map((a) => abs(a.path)),
    ...songs.flatMap((s) => (s.clips ?? []).map((c) => abs(c.path))),
    ...(images ? songs.flatMap((s) => [...(s.gallery ?? []), ...songImagePaths(s)].map(abs)) : []),
  ])];
}

/** Where each file is (see FileState), for the open show at `bundle`. */
export async function fileStates(bundle: string, paths: string[]): Promise<Record<string, FileState>> {
  const m = await readManifest(bundle).catch(() => null);
  const here = await backend.pathsExist(paths);
  return Object.fromEntries(paths.map((p, i) => {
    if (!p.startsWith(`${bundle}/`)) return [p, here[i] ? "na" : "missing"];
    const uploaded = Boolean(m?.files[p.slice(bundle.length + 1)]);
    return [p, here[i] ? (uploaded ? "local" : "uploading") : (uploaded ? "online" : "missing")];
  }));
}

/**
 * Bytes of these files of the show at `bundle` that are in Google Drive: all of them (`total`), and the ones downloaded
 * to this Mac (`local`). Records and show audio aren't in Drive, so they don't count. A file not on this Mac counts what
 * Drive said its size was (0 until the show's opened once with sizes in its manifest).
 */
export async function mediaSize(bundle: string, paths: string[]): Promise<MediaSize> {
  const m = await readManifest(bundle);
  const inDrive = paths.filter((p) => p.startsWith(`${bundle}/`) && m.files[p.slice(bundle.length + 1)]);
  const sizes = await backend.pathSizes(inDrive);
  return inDrive.reduce((n, p, i) => {
    const kind = mediaKind(p);
    return {
      local: n.local + sizes[i],
      total: n.total + (sizes[i] || (m.files[p.slice(bundle.length + 1)].size ?? 0)),
      kinds: { ...n.kinds, [kind]: n.kinds[kind] + sizes[i] },
    };
  }, { local: 0, total: 0, kinds: { video: 0, image: 0, audio: 0 } });
}
/** `kinds` is the downloaded bytes of each kind of media; what's not downloaded is `total - local`. */
export type MediaSize = { local: number; total: number; kinds: Record<MediaKind, number> };
export type MediaKind = "video" | "image" | "audio";
const mediaKind = (path: string): MediaKind =>
  AUDIO_EXTENSIONS.includes(extension(path)) ? "audio" : IMAGE_EXTENSIONS.includes(extension(path)) ? "image" : "video";

/**
 * Remove a show's media from this Mac, the files that are in Drive (it downloads again when it's shown). How many went.
 * A show kept downloaded stops being kept, or they'd come straight back.
 */
export async function removeDownloads(bundle: string, paths: string[]): Promise<number> {
  const m = await readManifest(bundle);
  const rel = paths.map((p) => (p.startsWith(`${bundle}/`) ? p.slice(bundle.length + 1) : p)).filter((r) => m.files[r]);
  if (rel.length && m.keep) await setKeepDownloaded(bundle, false);
  return rel.length ? backend.driveEvict(bundle, rel) : 0;
}

/** Download a show's media from Drive to this Mac. */
export async function download(bundle: string, paths: string[]) {
  const notes = (await backend.driveFetch(bundle, paths.map((p) => (p.startsWith(`${bundle}/`) ? p.slice(bundle.length + 1) : p)))).filter((n) => !cancelledNote(n));
  if (notes.length) throw new Error(notes.slice(0, 3).join(" · "));
}

/**
 * Download every one of a show's media files that's in Google Drive but not on this Mac (All shows, on the show's card).
 * `onProgress` gets the files done so far, of how many. Returns how many it downloaded. Cancel on the progress bar stops it.
 */
export function downloadShow(bundle: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  return serial(`download:${bundle}`, () => downloadAll(bundle, onProgress)); // the card's and the watcher's, one at a time
}
async function downloadAll(bundle: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const rel = Object.keys((await refreshManifest(bundle)).files).filter((r) => r.startsWith("media/"));
  const here = await backend.pathsExist(rel.map((r) => `${bundle}/${r}`));
  const todo = rel.filter((_, i) => !here[i]);
  const notes: string[] = [];
  const cancels = cancelsSoFar();
  let i = 0;
  for (; i < todo.length && cancelsSoFar() === cancels; i += FETCH_BATCH) {
    onProgress?.(i, todo.length);
    notes.push(...(await backend.driveFetch(bundle, todo.slice(i, i + FETCH_BATCH))));
  }
  const failed = notes.filter((n) => !cancelledNote(n));
  if (failed.length) throw new Error(failed.slice(0, 3).join(" · "));
  const downloaded = Math.min(i, todo.length) - (notes.length - failed.length); // fewer if it was cancelled
  if (downloaded === todo.length) onProgress?.(todo.length, todo.length);
  return downloaded;
}
const FETCH_BATCH = 6;

/** The shows kept downloaded on this Mac (their bundles), for the toggle on their cards. */
export const useKept = create<{ kept: string[] }>(() => ({ kept: [] }));

/** Read which shows are kept downloaded, from the manifests of the shows copied to this Mac. */
export async function loadKept(): Promise<string[]> {
  if (!backend.isDesktop) return [];
  const bundles = await backend.driveCachedShows().catch(() => [] as string[]);
  const manifests = await Promise.all(bundles.map((b) => readManifest(b).catch(() => null)));
  const kept = bundles.filter((_, i) => manifests[i]?.keep);
  useKept.setState({ kept });
  return kept;
}

/** Keep a show's media downloaded on this Mac, or stop (its files stay until the cache limit or the sweep removes them). */
export async function setKeepDownloaded(bundle: string, keep: boolean) {
  await updateManifest(bundle, (m) => { if (keep) m.keep = true; else delete m.keep; });
  useKept.setState((s) => ({ kept: keep ? [...new Set([...s.kept, bundle])] : s.kept.filter((b) => b !== bundle) }));
}

const KEEP_EVERY_MS = 15 * 60 * 1000;
let keeping = false;

/** Download whatever's new in Drive for every show kept downloaded. Quiet: offline, it waits for the next time. */
export async function topUpKeptShows() {
  if (keeping || !backend.isDesktop) return;
  keeping = true;
  try {
    for (const bundle of await loadKept()) {
      try {
        await downloadShow(bundle);
      } catch (e) {
        if (isOffline(e)) break; // try them all again when back online
      }
    }
  } finally {
    keeping = false;
  }
}

/** Keep the kept shows topped up: now, whenever the connection comes back, and every few minutes. Returns a function that stops. */
export function watchKeptShows(): () => void {
  const run = () => { topUpKeptShows().catch(() => {}); };
  run();
  const t = window.setInterval(run, KEEP_EVERY_MS);
  window.addEventListener("online", run);
  const unsub = useStore.subscribe((s, prev) => { if (s.connection === "online" && prev.connection !== "online") run(); });
  return () => { window.clearInterval(t); window.removeEventListener("online", run); unsub(); };
}

/** Make a show's media online only: remove every file of it that's in Google Drive from this Mac (and stop keeping it downloaded). How many went. */
export async function showOnlineOnly(bundle: string): Promise<number> {
  const m = await readManifest(bundle);
  return removeDownloads(bundle, Object.keys(m.files).filter((r) => r.startsWith("media/")));
}

/** Remove the clips of shows not opened on this Mac for the setting's days, at most once a day. */
export async function sweepShowsDaily(bundles: string[]) {
  const days = useStorage.getState().unusedDays;
  if (!days || !backend.isDesktop) return;
  try {
    if (Date.now() - Number(localStorage.getItem(LAST_SWEEP_KEY) ?? 0) < DAY_MS) return;
    localStorage.setItem(LAST_SWEEP_KEY, String(Date.now()));
  } catch { /* storage unavailable: sweep anyway */ }
  for (const bundle of bundles) {
    if (bundle === useStore.getState().bundle) continue;
    const m = await readManifest(bundle).catch(() => null);
    if (!m?.openedAt || m.keep || Date.now() - m.openedAt < days * DAY_MS) continue;
    await removeDownloads(bundle, Object.keys(m.files).filter((r) => r.startsWith("media/clips/"))).catch(() => 0);
  }
}

/** Remove every show's downloaded media from this Mac, images too, and stop keeping any downloaded. `onProgress` gets the shows done so far. */
export async function removeAllDownloads(bundles: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
  let done = 0;
  for (const [i, bundle] of bundles.entries()) {
    onProgress?.(i, bundles.length);
    const m = await readManifest(bundle).catch(() => null);
    if (m) done += await removeDownloads(bundle, Object.keys(m.files).filter((r) => r.startsWith("media/"))).catch(() => 0);
  }
  return done;
}

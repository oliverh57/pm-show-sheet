// Space on this Mac: a show's clips and images are copies of what's in Google Drive (src/drive/), so they can be
// removed from this Mac and download again the next time they're shown. "Remove downloads of unused shows" is per
// Mac (localStorage, like the theme): once a day after All shows looks for shows, the clips of shows not opened on
// this Mac for that long are removed. Images stay: they're small, and the songs page shows them as soon as a show opens.
// Records and audio are on this Mac's disks (or an external one), not in Drive, so they're never removed.
import { create } from "zustand";
import { backend } from "./backend";
import { readManifest } from "./drive/show";
import { songImagePaths } from "./model/ops";
import type { Show } from "./model/types";
import { useStore } from "./store";

const KEY = "pm.removeDownloadsAfterDays";
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

export const useStorage = create<{ unusedDays: number }>(() => ({ unusedDays: readDays() }));

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
    ...(show.audio ?? []).map((a) => a.path),
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

/** Remove a show's media from this Mac, the files that are in Drive (it downloads again when it's shown). How many went. */
export async function removeDownloads(bundle: string, paths: string[]): Promise<number> {
  const m = await readManifest(bundle);
  const rel = paths.map((p) => (p.startsWith(`${bundle}/`) ? p.slice(bundle.length + 1) : p)).filter((r) => m.files[r]);
  return rel.length ? backend.driveEvict(bundle, rel) : 0;
}

/** Download a show's media from Drive to this Mac. */
export async function download(bundle: string, paths: string[]) {
  const notes = await backend.driveFetch(bundle, paths.map((p) => (p.startsWith(`${bundle}/`) ? p.slice(bundle.length + 1) : p)));
  if (notes.length) throw new Error(notes.slice(0, 3).join(" · "));
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
    if (!m?.openedAt || Date.now() - m.openedAt < days * DAY_MS) continue;
    await removeDownloads(bundle, Object.keys(m.files).filter((r) => r.startsWith("media/clips/"))).catch(() => 0);
  }
}

/** Remove every show's downloaded media from this Mac, images too. `onProgress` gets the shows done so far. */
export async function removeAllDownloads(bundles: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
  let done = 0;
  for (const [i, bundle] of bundles.entries()) {
    onProgress?.(i, bundles.length);
    const m = await readManifest(bundle).catch(() => null);
    if (m) done += await removeDownloads(bundle, Object.keys(m.files).filter((r) => r.startsWith("media/"))).catch(() => 0);
  }
  return done;
}

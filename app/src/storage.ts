// Space on this Mac: show media in Google Drive can be made online only (see src-tauri/src/files.rs).
// "Make unused files online only" is per Mac (localStorage, like the theme). It looks at a show's records,
// audio and clips when the show opens, and at every show's once a day after All shows looks for shows.
// Images stay: they're small, and the songs page shows them as soon as a show opens.
import { create } from "zustand";
import { backend } from "./backend";
import { songImagePaths } from "./model/ops";
import type { Show } from "./model/types";

const KEY = "pm.onlineOnlyAfterDays";
const LAST_SWEEP_KEY = "pm.onlineOnlySweptAt";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days unopened before a file is made online only; 0 for never. */
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

/** Make this show's unused records, audio and clips online only, if the setting is on. */
export async function sweepShow(bundle: string, show: Show): Promise<number> {
  const days = useStorage.getState().unusedDays;
  return days ? backend.makeUnusedOnlineOnly(showMediaPaths(bundle, show, false), days) : 0;
}

/** The same for every show, at most once a day. */
export async function sweepShowsDaily(bundles: string[]) {
  if (!useStorage.getState().unusedDays || !backend.isDesktop) return;
  try {
    if (Date.now() - Number(localStorage.getItem(LAST_SWEEP_KEY) ?? 0) < DAY_MS) return;
    localStorage.setItem(LAST_SWEEP_KEY, String(Date.now()));
  } catch { /* storage unavailable: sweep anyway */ }
  for (const bundle of bundles) {
    const show = await backend.open(bundle).catch(() => null);
    if (show) await sweepShow(bundle, show).catch(() => {});
  }
}

/**
 * Make every file of every show (images too) online only, where it can be. `onProgress` gets the shows done so far.
 * Returns how many files it made online only, and how many have to stay until they've uploaded.
 */
export async function makeAllOnlineOnly(bundles: string[], onProgress?: (done: number, total: number) => void): Promise<{ done: number; uploading: number; notes: string[] }> {
  const result = { done: 0, uploading: 0, notes: [] as string[] };
  for (const [i, bundle] of bundles.entries()) {
    onProgress?.(i, bundles.length);
    const show = await backend.open(bundle).catch(() => null);
    if (!show) continue;
    const states = await backend.fileStates(showMediaPaths(bundle, show, true));
    const local = Object.keys(states).filter((p) => states[p] === "local");
    result.uploading += Object.values(states).filter((s) => s === "uploading").length;
    const notes = local.length ? await backend.makeOnlineOnly(local) : [];
    result.done += local.length - notes.length;
    result.notes.push(...notes);
  }
  return result;
}

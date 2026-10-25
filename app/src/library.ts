// Finding, opening and creating shows. Shows live in Google Drive (synced by Google Drive for desktop):
// All shows lists every .showsheet in the signed-in account's My Drive and shared drives (see
// src-tauri/src/shows.rs). A show outside that account's Drive opens read-only.
import { backend, type ShowSummary } from "./backend";
import { bundleName, clipName, fileName, migrate, newShow, orphanRecordIds, recordMedia, removeImage, removeRecord, removeRecordStills } from "./model/ops";
import type { Show } from "./model/types";
import { sweepShow, sweepShowsDaily } from "./storage";
import { useStore } from "./store";

const CACHE_KEY = "pm.showsCache";
const NEW_FOLDER_KEY = "pm.newShowFolder";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// --- where a path is ---------------------------------------------------------------

const DRIVE_MOUNT = /\/Library\/CloudStorage\/GoogleDrive-([^/]+)\//;

/** The Google account whose Drive a path is in ("" for the old /Volumes/GoogleDrive), or null if it isn't in Drive. */
export function driveAccount(path: string): string | null {
  const m = path.match(DRIVE_MOUNT);
  if (m) return m[1];
  return path.startsWith("/Volumes/GoogleDrive/") ? "" : null;
}

/** Why a show at `path` can't be edited by `email`, or null if it can. */
export function readOnlyReason(path: string, email: string | null): string | null {
  const account = driveAccount(path);
  if (account === null) return "This show isn't in Google Drive, so it's read only.";
  if (email && account && account.toLowerCase() !== email.toLowerCase()) return `This show is in another account's Google Drive (${account}), so it's read only.`;
  return null;
}

/** "My Drive / Pixelmappers Show Sheets" or "Shared drives / PM - CLIENT FOLDER / 2026" for a show's folder. */
export function describeLocation(bundlePath: string): string {
  const folder = bundlePath.split("/").slice(0, -1).join("/");
  const m = folder.match(/\/Library\/CloudStorage\/GoogleDrive-[^/]+\/(.+)$/) ?? folder.match(/^\/Volumes\/GoogleDrive\/(.+)$/);
  if (m) return m[1].split("/").join(" / ");
  return folder.replace(/^\/Users\/[^/]+/, "~");
}

/** The top of the Google Drive mount a path is in (shows My Drive and Shared drives), if any. */
export function driveRoot(path: string): string | undefined {
  return path.match(/^(.*\/Library\/CloudStorage\/GoogleDrive-[^/]+)/)?.[1] ?? (path.startsWith("/Volumes/GoogleDrive/") ? "/Volumes/GoogleDrive" : undefined);
}

/** Open a show's folder on drive.google.com (or Drive itself if the id isn't known yet). */
export async function openInDrive(path: string) {
  const id = await backend.driveItemId(path);
  await backend.openWeb(id ? `https://drive.google.com/drive/folders/${id}` : "https://drive.google.com/drive/");
}

// --- the list of shows ---------------------------------------------------------------

/** Shows found by the last scan, so All shows can draw straight away. */
export function cachedShows(): ShowSummary[] {
  return read<ShowSummary[]>(CACHE_KEY, []);
}

/** Look through Google Drive for shows; `onFound` gets each as it's found. Folders that held shows last time go first. */
export async function scanShows(email: string | null, onFound: (s: ShowSummary) => void): Promise<ShowSummary[]> {
  const hints = [...new Set(cachedShows().map((s) => s.path.split("/").slice(0, -1).join("/")))];
  const shows = await backend.scanShows(email, hints, onFound);
  write(CACHE_KEY, shows);
  sweepShowsDaily(shows.map((s) => s.path)).catch(() => {});
  return shows;
}

/** Where New show saves: the last folder used, else where most shows are, else My Drive/Pixelmappers Show Sheets. */
export async function newShowFolder(email: string | null, shows: ShowSummary[]): Promise<string | null> {
  const remembered = read<string | null>(NEW_FOLDER_KEY, null);
  if (remembered && !readOnlyReason(`${remembered}/x`, email)) return remembered;
  const counts = new Map<string, number>();
  for (const s of shows) {
    const dir = s.path.split("/").slice(0, -1).join("/");
    if (!readOnlyReason(s.path, email)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? (await backend.showsFolder(email));
}

export function rememberNewShowFolder(folder: string) {
  write(NEW_FOLDER_KEY, folder);
}

// --- opening, creating, moving -----------------------------------------------------------

export async function openShow(path: string) {
  const show = migrate(await backend.open(path));
  const { user, load } = useStore.getState();
  const readOnly = readOnlyReason(path, user?.email ?? null);
  // Clips and stills left behind by a record that was removed before removing took them with it.
  const leftovers = readOnly ? [] : orphanRecordIds(show).flatMap((id) => {
    const { clips, stills } = recordMedia(show, id);
    removeRecord(show, id);
    return [...clips, ...stills];
  });
  load(show, path, readOnly);
  if (leftovers.length) backend.trashFiles(path, leftovers).catch(() => {});
  if (!readOnly) binUnusedMedia(path, show).catch(() => {});
  sweepShow(path, show).catch(() => {});
}

const UNUSED_AFTER_MS = 60 * 60 * 1000; // another Mac's new clip may not be in the show file here yet

/** Clips, stills and crops the app made that no song uses any more (from clip runs stopped part way, or re-cropped heroes). */
async function binUnusedMedia(bundle: string, show: Show) {
  const used = new Set(Object.values(show.songs).flatMap((s) => [...(s.clips ?? []).flatMap((c) => [c.path, c.still ?? ""]), ...(s.gallery ?? []), s.hero ?? ""]));
  const unused: string[] = [];
  for (const [dir, exts] of [["clips", ["mp4"]], ["grabs", ["jpg"]], ["crops", ["jpg"]]] as const) {
    const files = await backend.listFolder(`${bundle}/media/${dir}`, [...exts]).catch(() => []);
    for (const f of files) {
      const rel = `media/${dir}/${f.path.split("/").pop()}`;
      if (!used.has(rel) && Date.now() - f.modified_ms > UNUSED_AFTER_MS) unused.push(rel);
    }
  }
  await backend.trashFiles(bundle, unused);
}

/** Remove a record from the open show, binning the clips and stills made from it (after asking). */
export async function removeRecordAndMedia(id: string): Promise<void> {
  const { show, bundle, update, toast } = useStore.getState();
  const record = show?.records?.find((r) => r.id === id);
  if (!show || !bundle || !record) return;
  const { clips, stills } = recordMedia(show, id);
  const made = [clips.length && `${clips.length} clip${clips.length === 1 ? "" : "s"}`, stills.length && `${stills.length} still${stills.length === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  if (made && !(await backend.confirm(`Remove ${record.name}? Its ${made} will be deleted from the show too. The record itself stays where it is.`))) return;
  update((s) => removeRecord(s, id));
  try {
    await backend.trashFiles(bundle, [...clips, ...stills]);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
  }
}

/** Delete the stills made from a record (after asking): off every song, and to the Trash. Its clips stay. */
export async function deleteRecordStills(id: string): Promise<void> {
  const { show, bundle, update, toast } = useStore.getState();
  const record = show?.records?.find((r) => r.id === id);
  if (!show || !bundle || !record) return;
  const { stills } = recordMedia(show, id);
  if (!stills.length || !(await backend.confirm(`Delete the ${stills.length} still${stills.length === 1 ? "" : "s"} made from ${record.label || record.name}? Its clips stay.`))) return;
  update((s) => { removeRecordStills(s, id); });
  try {
    await backend.trashFiles(bundle, stills);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
  }
}

/** Files the show's songs use, so a file still used by another song isn't binned with the one being deleted. */
function usedPaths(show: Show): Set<string> {
  return new Set(Object.values(show.songs).flatMap((s) => [...(s.clips ?? []).flatMap((c) => [c.path, c.still ?? ""]), ...(s.gallery ?? []), s.hero ?? ""]));
}

/** Delete things from the open show after asking, moving the show's own files that nothing uses any more to the Trash. */
async function deleteFromShow(question: string, change: (s: Show) => void) {
  const { show, bundle, update, toast } = useStore.getState();
  if (!show || !bundle || !(await backend.confirm(question))) return;
  const before = usedPaths(show);
  update(change);
  const after = usedPaths(useStore.getState().show!);
  const gone = [...before].filter((p) => p.startsWith("media/") && !after.has(p));
  try {
    await backend.trashFiles(bundle, gone);
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
  }
}

/** Delete a render or still from a song (and its hero crop, if it was the hero). */
export function deleteSongImage(songId: string, path: string) {
  const show = useStore.getState().show;
  if (!show?.songs[songId]) return;
  const song = show.songs[songId];
  const others = (song.gallery ?? []).filter((p) => p !== path).length;
  const hero = (song.hero_crop?.src ?? song.hero) !== path ? "" : others ? " It's the song's hero, so the next image takes its place." : " It's the song's only image, so the song will have none.";
  return deleteFromShow(`Delete “${fileName(path)}” from ${clipName(show, songId)}? The file moves to the Trash.${hero}`, (s) => removeImage(s, songId, path));
}

/** Delete one clip from a song. Its still stays in the song's images, and the record isn't touched. */
export function deleteClip(songId: string, path: string) {
  const show = useStore.getState().show;
  if (!show?.songs[songId]) return;
  return deleteFromShow(`Delete the clip “${fileName(path)}” from ${clipName(show, songId)}? The file moves to the Trash. The show record isn't touched.`,
    (s) => { s.songs[songId].clips = (s.songs[songId].clips ?? []).filter((c) => c.path !== path); });
}

/** Create a show bundle in `folder` named after the show, adding " 2", " 3"… if the name is taken. */
export async function createShow(folder: string, fields: Pick<Show, "name" | "venue" | "date">): Promise<void> {
  const reason = readOnlyReason(`${folder}/x`, useStore.getState().user?.email ?? null);
  if (reason) throw new Error("Shows have to be saved in your Google Drive. Choose a folder in Google Drive.");
  const show = { ...newShow(fields.name), venue: fields.venue || undefined, date: fields.date || undefined };
  await backend.ensureFolder(folder);
  const existing = new Set((await backend.listShows(folder)).map((s) => s.path));
  const base = `${folder}/${bundleName(show.name)}`;
  let path = `${base}.showsheet`;
  for (let n = 2; existing.has(path); n++) path = `${base} ${n}.showsheet`;
  await backend.create(path, show);
  useStore.getState().load(show, path, null);
}

/** Move the open show into another folder in Google Drive (e.g. a shared drive). A read-only show becomes editable. */
export async function moveOpenShow(folder: string): Promise<string> {
  const { bundle, show, jobs, setBundle, user } = useStore.getState();
  if (!bundle || !show) throw new Error("No show is open");
  if (readOnlyReason(`${folder}/x`, user?.email ?? null)) throw new Error("Choose a folder in your Google Drive");
  if (jobs.some((j) => j.status === "queued" || j.status === "running")) throw new Error("Wait for the clips to finish first");
  if (!useStore.getState().readOnly) await backend.save(bundle, show);
  const moved = await backend.moveBundle(bundle, folder);
  setBundle(moved);
  useStore.getState().setSaveState("saved");
  return moved;
}

/** Resolves once no clips are being cut (a clip run writes into the show's folder, so it can't be renamed mid-run). */
function clipsIdle(): Promise<void> {
  const busy = () => useStore.getState().jobs.some((j) => j.status === "queued" || j.status === "running");
  if (!busy()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = useStore.subscribe(() => { if (!busy()) { stop(); resolve(); } });
  });
}

/**
 * Rename the open show, and its .showsheet folder to match (Drive for desktop renames it in Drive, and the
 * Sheet and deck are retitled on the next sync). If clips are being cut, the folder is renamed when they're done.
 */
export async function renameOpenShow(name: string): Promise<void> {
  const clean = name.trim().toUpperCase();
  const { show, update, toast } = useStore.getState();
  if (!clean || !show || show.name === clean) return;
  update((s) => { s.name = clean; });
  if (useStore.getState().readOnly) return;
  await clipsIdle();
  const { bundle, show: now, setBundle, setSaveState } = useStore.getState();
  if (!bundle || now?.id !== show.id || now.name !== clean) return; // closed, or renamed again since
  try {
    await backend.save(bundle, now);
    const to = await backend.renameBundle(bundle, bundleName(clean));
    if (to === bundle) return;
    setBundle(to);
    setSaveState("saved");
    write(CACHE_KEY, cachedShows().map((s) => (s.path === bundle ? { ...s, path: to, name: clean } : s)));
  } catch (e) {
    toast(String(e).replace(/^Error: /, ""));
  }
}

/**
 * Delete the open show: its folder (project, renders, clips, stills, and the Google Sheet and deck inside it) goes
 * to the Trash, and so to Google Drive's bin. Linked source files (show records, audio) stay where they are.
 * Shows from before the Sheet and deck moved into the show's folder have them binned separately.
 * Returns a note if the Google files couldn't be removed.
 */
export async function deleteOpenShow(): Promise<string | null> {
  const { bundle, show, user, readOnly, close } = useStore.getState();
  if (!bundle || !show) throw new Error("No show is open");
  if (readOnly) throw new Error("This show is read only");
  let note: string | null = null;
  const folderId = show.google?.folder_id;
  if (folderId && folderId !== (await backend.driveItemId(bundle))) {
    try {
      await backend.googleApi("PATCH", `https://www.googleapis.com/drive/v3/files/${folderId}?supportsAllDrives=true`, { trashed: true });
    } catch (e) {
      note = `The show is deleted, but its Google Sheet and deck couldn't be: ${String(e).replace(/^Error: /, "")}`;
    }
  }
  if (user) await backend.presenceLeave(bundle, user.email).catch(() => {});
  await backend.trashBundle(bundle);
  write(CACHE_KEY, cachedShows().filter((s) => s.path !== bundle));
  close();
  return note;
}

/** "2 hours ago", "Yesterday", "3 Oct". */
export function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 172800) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 300 * 86400 ? "numeric" : undefined });
}

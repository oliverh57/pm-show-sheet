// Finding, opening and creating shows. Shows live in Google Drive and the app reaches them through the Drive API
// (src/drive/): All shows lists every show you can open there (My Drive, shared drives and Shared with me), and each
// open show is worked on in a copy on this Mac that's kept in step with Drive.
import { backend, previewShows, type ShowSummary } from "./backend";
import { createFolder, FOLDER, getFile, patchFile, search, trashFile } from "./drive/api";
import { findShows, SHOW_EXT, summaryProps } from "./drive/list";
import { openFromDrive } from "./drive/live";
import { refreshManifest, trashMedia } from "./drive/media";
import { readManifest, showDir, syncShow, updateManifest } from "./drive/show";
import { bundleName, clipName, fileName, migrate, newShow, orphanRecordIds, recordMedia, removeImage, removeRecord, removeRecordStill, removeRecordStills } from "./model/ops";
import type { Show } from "./model/types";
import { sweepShowsDaily } from "./storage";
import { useStore } from "./store";

const CACHE_KEY = "pm.showsCache";
const NEW_FOLDER_KEY = "pm.newShowFolder2"; // a Drive folder { id, label } (pm.newShowFolder was a path in Drive for desktop)
export const SHOWS_FOLDER = "Pixelmappers Show Sheets";

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
const message = (e: unknown) => String(e).replace(/^Error: /, "");

/** Open a show's folder on drive.google.com. */
export async function openInDrive(bundle: string) {
  const m = await readManifest(bundle).catch(() => null);
  await backend.openWeb(m?.folderId ? `https://drive.google.com/drive/folders/${m.folderId}` : "https://drive.google.com/drive/");
}

// --- the list of shows ---------------------------------------------------------------

/** Shows found last time, so All shows can draw straight away. */
export function cachedShows(): ShowSummary[] {
  return read<ShowSummary[]>(CACHE_KEY, []);
}

/** Look through Google Drive for shows; `onFound` gets each as it's found. */
export async function scanShows(onFound: (s: ShowSummary) => void): Promise<ShowSummary[]> {
  if (!backend.isDesktop) {
    const shows = await previewShows();
    shows.forEach(onFound);
    return shows;
  }
  const shows = await findShows(onFound);
  write(CACHE_KEY, shows);
  sweepShowsDaily(shows.map((s) => s.path)).catch(() => {});
  return shows;
}

// --- where new shows go --------------------------------------------------------------------

/** A folder in Google Drive to make a show in. `id` null: My Drive › Pixelmappers Show Sheets, made when it's first used. */
export interface DriveFolder { id: string | null; label: string }
export const DEFAULT_FOLDER: DriveFolder = { id: null, label: `My Drive › ${SHOWS_FOLDER}` };

/** Where New show saves: the last folder used, else My Drive › Pixelmappers Show Sheets. */
export function newShowFolder(): DriveFolder {
  return read<DriveFolder>(NEW_FOLDER_KEY, DEFAULT_FOLDER);
}

export function rememberNewShowFolder(folder: DriveFolder) {
  write(NEW_FOLDER_KEY, folder);
}

/** The id of My Drive › Pixelmappers Show Sheets, made if it isn't there. */
async function defaultFolderId(): Promise<string> {
  const found = (await search(`'root' in parents and name = '${SHOWS_FOLDER}' and mimeType = '${FOLDER}' and trashed = false`, "id"))[0];
  return found?.id ?? (await createFolder(SHOWS_FOLDER, "root")).id;
}

// --- opening, creating, moving -----------------------------------------------------------

export async function openShow(path: string) {
  const opened = backend.isDesktop ? await openFromDrive(path) : { show: await backend.open(path), readOnly: null, offline: false };
  const show = migrate(opened.show);
  const { load, toast } = useStore.getState();
  const readOnly = opened.readOnly;
  // Clips and stills left behind by a record that was removed before removing took them with it.
  const leftovers = readOnly ? [] : orphanRecordIds(show).flatMap((id) => {
    const { clips, stills } = recordMedia(show, id);
    removeRecord(show, id);
    return [...clips, ...stills];
  });
  load(show, path, readOnly);
  if (opened.offline) toast("Google Drive can't be reached, so this is the copy on this Mac. Your changes upload when it's back.");
  if (!backend.isDesktop) return;
  (async () => {
    await refreshManifest(path);
    if (leftovers.length) await trashMedia(path, leftovers);
    if (!readOnly) await binUnusedMedia(path, show);
  })().catch(() => {});
}

const UNUSED_AFTER_MS = 60 * 60 * 1000; // a clip run on another Mac may not be in the show here yet

/** Clips, stills and crops the app made that no song uses any more (from clip runs stopped part way, or re-cropped heroes). */
async function binUnusedMedia(bundle: string, show: Show) {
  const used = usedPaths(show);
  const m = await readManifest(bundle);
  const unused = new Set<string>();
  for (const [dir, exts] of [["clips", ["mp4"]], ["grabs", ["jpg"]], ["crops", ["jpg"]]] as const) {
    const old = (rel: string, modified: number) => rel.startsWith(`media/${dir}/`) && exts.some((x) => rel.toLowerCase().endsWith(`.${x}`))
      && !used.has(rel) && Date.now() - modified > UNUSED_AFTER_MS;
    for (const f of await backend.listFolder(`${bundle}/media/${dir}`, [...exts]).catch(() => [])) {
      const rel = `media/${dir}/${f.path.split("/").pop()}`;
      if (old(rel, f.modified_ms) && !m.files[rel]) unused.add(rel); // made here, never uploaded
    }
    for (const [rel, f] of Object.entries(m.files)) if (old(rel, f.modified ?? 0) && f.modified) unused.add(rel);
  }
  await trashMedia(bundle, [...unused]);
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
    await trashMedia(bundle, [...clips, ...stills]);
  } catch (e) {
    toast(message(e));
  }
}

/** Delete the stills made from a record (after asking): off every song, and to the bin. Its clips stay. */
export async function deleteRecordStills(id: string): Promise<void> {
  const { show, bundle, update, toast } = useStore.getState();
  const record = show?.records?.find((r) => r.id === id);
  if (!show || !bundle || !record) return;
  const { stills } = recordMedia(show, id);
  if (!stills.length || !(await backend.confirm(`Delete the ${stills.length} still${stills.length === 1 ? "" : "s"} made from ${record.label || record.name}? Its clips stay.`))) return;
  update((s) => { removeRecordStills(s, id); });
  try {
    await trashMedia(bundle, stills);
  } catch (e) {
    toast(message(e));
  }
}

/** Delete a still made from a record that no song uses any more (after asking): off the record, and to the bin. */
export async function deleteRecordStill(id: string, path: string): Promise<void> {
  const { show, bundle, update, toast } = useStore.getState();
  if (!show || !bundle || !(await backend.confirm(`Delete “${fileName(path)}”? No song uses it. The file moves to the bin.`))) return;
  update((s) => removeRecordStill(s, id, path));
  if (usedPaths(useStore.getState().show!).has(path)) return;
  try {
    await trashMedia(bundle, [path]);
  } catch (e) {
    toast(message(e));
  }
}

/** Files the show's songs use, so a file still used by another song isn't binned with the one being deleted. */
function usedPaths(show: Show): Set<string> {
  return new Set(Object.values(show.songs).flatMap((s) => [...(s.clips ?? []).flatMap((c) => [c.path, c.still ?? ""]), ...(s.gallery ?? []), s.hero ?? ""]));
}

/** Delete things from the open show after asking, binning the show's own files that nothing uses any more. */
async function deleteFromShow(question: string, change: (s: Show) => void) {
  const { show, bundle, update, toast } = useStore.getState();
  if (!show || !bundle || !(await backend.confirm(question))) return;
  const before = usedPaths(show);
  update(change);
  const after = usedPaths(useStore.getState().show!);
  const gone = [...before].filter((p) => p.startsWith("media/") && !after.has(p));
  try {
    await trashMedia(bundle, gone);
  } catch (e) {
    toast(message(e));
  }
}

/** Delete a render or still from a song (and its hero crop, if it was the hero). */
export function deleteSongImage(songId: string, path: string) {
  const show = useStore.getState().show;
  if (!show?.songs[songId]) return;
  const song = show.songs[songId];
  const others = (song.gallery ?? []).filter((p) => p !== path).length;
  const hero = (song.hero_crop?.src ?? song.hero) !== path ? "" : others ? " It's the song's hero, so the next image takes its place." : " It's the song's only image, so the song will have none.";
  return deleteFromShow(`Delete “${fileName(path)}” from ${clipName(show, songId)}? The file moves to the bin.${hero}`, (s) => removeImage(s, songId, path));
}

/** Delete one clip from a song. Its still stays in the song's images, and the record isn't touched. */
export function deleteClip(songId: string, path: string) {
  const show = useStore.getState().show;
  if (!show?.songs[songId]) return;
  return deleteFromShow(`Delete the clip “${fileName(path)}” from ${clipName(show, songId)}? The file moves to the bin. The show record isn't touched.`,
    (s) => { s.songs[songId].clips = (s.songs[songId].clips ?? []).filter((c) => c.path !== path); });
}

/** A name for a show's folder that isn't taken in `parent`: "NAME.showsheet", else "NAME 2.showsheet"… */
async function freeName(parent: string, stem: string, except?: string): Promise<string> {
  const taken = new Set((await search(`'${parent}' in parents and trashed = false`, "id,name")).filter((f) => f.id !== except).map((f) => f.name));
  let name = `${stem}${SHOW_EXT}`;
  for (let n = 2; taken.has(name); n++) name = `${stem} ${n}${SHOW_EXT}`;
  return name;
}

/** Create a show in a Drive folder, named after the show. */
export async function createShow(folder: DriveFolder, fields: Pick<Show, "name" | "venue" | "date">): Promise<void> {
  const show = { ...newShow(fields.name), venue: fields.venue || undefined, date: fields.date || undefined };
  if (!backend.isDesktop) {
    const path = `/preview/shows/${bundleName(show.name)}`;
    await backend.create(path, show);
    return useStore.getState().load(show, path, null);
  }
  const parent = folder.id ?? (await defaultFolderId());
  const props = summaryProps(show);
  const made = await createFolder(await freeName(parent, bundleName(show.name)), parent, props);
  const dir = await showDir(made.id);
  await backend.create(dir, show);
  const up = await backend.driveUpload(`${dir}/project.json`, { parent: made.id, name: "project.json" });
  await backend.writeJson(dir, "base.json", show);
  await updateManifest(dir, (m) => { m.folderId = made.id; m.projectId = up.id; m.rev = up.headRevisionId; m.canEdit = true; m.summary = props; m.openedAt = Date.now(); });
  useStore.getState().load(show, dir, null);
}

/** Wait for the open show's changes to be saved and uploaded. */
async function settled(): Promise<void> {
  const { bundle, show } = useStore.getState();
  if (bundle && show && !useStore.getState().readOnly) await syncShow(bundle, show);
}

/**
 * Move the open show into another Drive folder (another shared drive, say). Drive moves the whole folder, keeping every
 * file's id, so links to the Sheet, deck and clips keep working. A shared drive that won't take a folder gets a new one
 * with the files moved into it.
 */
export async function moveOpenShow(target: DriveFolder & { id: string }): Promise<void> {
  const { bundle, show, jobs } = useStore.getState();
  if (!bundle || !show) throw new Error("No show is open");
  if (jobs.some((j) => j.status === "queued" || j.status === "running")) throw new Error("Wait for the clips to finish first");
  await settled();
  const m = await readManifest(bundle);
  const folder = await getFile(m.folderId, "id,name,parents,properties");
  if (folder.parents?.includes(target.id)) return;
  try {
    await patchFile(m.folderId, {}, `addParents=${target.id}&removeParents=${(folder.parents ?? []).join(",")}`);
  } catch {
    const moved = await moveContents(m.folderId, target.id, folder.name ?? `${bundleName(show.name)}${SHOW_EXT}`, folder.properties ?? {});
    // The show has a new folder, so a new copy on this Mac: open it there.
    await backend.driveForget(bundle).catch(() => {});
    write(CACHE_KEY, cachedShows().filter((s) => s.path !== bundle));
    const dir = await showDir(moved);
    await updateManifest(dir, (x) => { x.folderId = moved; });
    await openShow(dir);
    return;
  }
  useStore.getState().setLocation(target.label);
}

/** Make `name` in `target` and move everything in `from` into it, folder by folder; then bin `from`. */
async function moveContents(from: string, target: string, name: string, properties: Record<string, string>): Promise<string> {
  const made = await createFolder(name, target, properties);
  for (const f of await search(`'${from}' in parents and trashed = false`, "id,name,mimeType")) {
    if (f.mimeType === FOLDER) await moveContents(f.id, made.id, f.name ?? "folder", {});
    else await patchFile(f.id, {}, `addParents=${made.id}&removeParents=${from}`);
  }
  await trashFile(from);
  return made.id;
}

/** Rename the open show, and its folder in Drive to match (the Sheet and deck are retitled on the next sync). */
export async function renameOpenShow(name: string): Promise<void> {
  const clean = name.trim().toUpperCase();
  const { show, bundle, update, toast } = useStore.getState();
  if (!clean || !show || show.name === clean) return;
  update((s) => { s.name = clean; });
  if (useStore.getState().readOnly || !bundle || !backend.isDesktop) return;
  try {
    const m = await readManifest(bundle);
    const folder = await getFile(m.folderId, "parents");
    const parent = folder.parents?.[0];
    await patchFile(m.folderId, { name: parent ? await freeName(parent, bundleName(clean), m.folderId) : `${bundleName(clean)}${SHOW_EXT}` });
    write(CACHE_KEY, cachedShows().map((s) => (s.path === bundle ? { ...s, name: clean } : s)));
  } catch (e) {
    toast(message(e));
  }
}

/**
 * Delete the open show: its folder in Drive (project, renders, clips, stills, and the Sheet and deck inside it) goes to
 * Drive's bin, where it can be restored for 30 days, and its copy on this Mac is removed. Linked source files (show
 * records, audio) stay where they are. Shows from before the Sheet and deck moved into the show's folder have them
 * binned separately. Returns a note if the Google files couldn't be removed.
 */
export async function deleteOpenShow(): Promise<string | null> {
  const { bundle, show, readOnly, close } = useStore.getState();
  if (!bundle || !show) throw new Error("No show is open");
  if (readOnly) throw new Error("This show is read only");
  let note: string | null = null;
  const m = await readManifest(bundle);
  const old = show.google?.folder_id;
  if (old && old !== m.folderId) {
    try {
      await trashFile(old);
    } catch (e) {
      note = `The show is deleted, but its Google Sheet and deck couldn't be: ${message(e)}`;
    }
  }
  await trashFile(m.folderId);
  await backend.driveForget(bundle).catch(() => {});
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

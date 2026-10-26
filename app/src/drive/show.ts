// A show in Google Drive and its copy on this Mac. The copy (shows/<Drive folder id>/ in the app's data folder) holds
// project.json and whatever media has been opened or made here, laid out as in Drive, so the rest of the app works on
// local files as it always has. Beside project.json:
//   base.json    the show as last agreed with Drive: what the field-by-field merge compares both sides with
//   .drive.json  the manifest: the Drive ids of the show's folder, project.json, and each media file and folder
//
// `syncShow` brings the copy and Drive together: it pulls someone else's save (merging it with edits made here), then
// uploads what's changed here. Drive has no "only if unchanged" upload, so after each upload it checks that nobody
// else's save landed just before it; if one did, that save is merged in and uploaded again.
import { backend } from "../backend";
import type { Show } from "../model/types";
import { child, getFile } from "./api";
import { merge3, same, type MergeConflict } from "./merge";

export const PROJECT = "project.json";
const RETRIES = 3;

export interface Manifest {
  folderId: string;
  projectId?: string;
  rev?: string; // project.json's headRevisionId that base.json is
  canEdit?: boolean;
  files: Record<string, { id: string; md5?: string; modified?: number }>; // bundle-relative path → Drive file (modified: ms)
  folders: Record<string, string>; // bundle-relative folder ("media/clips") → Drive folder id
  summary?: Record<string, string>; // the properties last written on the show's folder (see list.ts)
  openedAt?: number;
}

// --- where copies live ---------------------------------------------------------------

let root: Promise<string> | null = null;
export const cacheRoot = () => (root ??= backend.driveCacheRoot());
export const showDir = async (folderId: string) => `${await cacheRoot()}/${folderId}`;
export const folderIdOf = (bundle: string) => bundle.split("/").pop()!;

// --- the manifest ----------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
/** Run `fn` after anything else queued under `key` (one sync per show at a time; manifest edits one at a time). */
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  return run;
}

export async function readManifest(bundle: string): Promise<Manifest> {
  const m = await backend.readJson<Manifest>(bundle, ".drive.json").catch(() => null);
  return { folderId: folderIdOf(bundle), files: {}, folders: {}, ...m };
}

/** Change the manifest (read, change, write, one change at a time). */
export function updateManifest(bundle: string, fn: (m: Manifest) => void): Promise<Manifest> {
  return serial(`manifest:${bundle}`, async () => {
    const m = await readManifest(bundle);
    fn(m);
    await backend.writeJson(bundle, ".drive.json", m);
    return m;
  });
}

// --- syncing project.json ------------------------------------------------------------------

/** Download project.json (or one revision of it) and read it. */
async function download(bundle: string, fileId: string, revision?: string): Promise<Show> {
  await backend.driveDownload(fileId, `${bundle}/.remote.json`, revision);
  const show = await backend.readJson<Show>(bundle, ".remote.json");
  if (!show) throw new Error("Google Drive sent an empty show");
  return show;
}

/** The revision saved just before `rev`, if it isn't `base`: someone else's save that landed between ours. */
async function slippedIn(fileId: string, base: string | undefined, rev: string | undefined): Promise<string | null> {
  if (!base || !rev) return null;
  const res = await backend.googleApi<{ revisions?: { id: string; modifiedTime: string }[] }>("GET",
    `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?pageSize=1000&fields=${encodeURIComponent("revisions(id,modifiedTime)")}`);
  const revs = [...(res.revisions ?? [])].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
  const i = revs.findIndex((r) => r.id === rev);
  if (i < 1 || !revs.some((r) => r.id === base)) return null; // can't tell (Drive prunes old revisions)
  return revs[i - 1].id === base ? null : revs[i - 1].id;
}

export interface SyncResult {
  /** The show on this Mac now: this Mac's edits with everyone else's merged in. Null if there's none yet. */
  show: Show | null;
  /** Both sides changed the same thing; this Mac's value was kept. */
  conflicts: MergeConflict[];
  uploaded: boolean;
  canEdit: boolean;
}

/**
 * Bring a show's copy and Drive together. `local` is the show as it is in the app (else project.json on this Mac).
 * The result's show is written to the copy; compare it with `local` to see what came from Drive.
 */
export function syncShow(bundle: string, local?: Show | null): Promise<SyncResult> {
  return serial(`sync:${bundle}`, () => syncNow(bundle, local));
}

async function syncNow(bundle: string, localIn?: Show | null): Promise<SyncResult> {
  const m = await readManifest(bundle);
  const projectId = m.projectId ?? (await child(m.folderId, PROJECT))?.id;
  if (!projectId) throw new Error("This show's folder in Google Drive has no project.json");
  const meta = await getFile(projectId, "id,headRevisionId,capabilities(canEdit)");
  const canEdit = meta.capabilities?.canEdit ?? false;
  let rev = m.rev;
  let base = await backend.readJson<Show>(bundle, "base.json").catch(() => null);
  let current = localIn !== undefined ? localIn : await backend.open(bundle).catch(() => null);
  const conflicts: MergeConflict[] = [];

  if (meta.headRevisionId !== rev || !base) {
    const theirs = await download(bundle, projectId);
    if (current && base && !same(base, current)) {
      const r = merge3(base, current, theirs);
      current = r.merged;
      conflicts.push(...r.conflicts);
    } else {
      current = theirs;
    }
    base = theirs;
    rev = meta.headRevisionId;
    await backend.writeJson(bundle, "base.json", base);
    await backend.save(bundle, current);
  }

  let uploaded = false;
  for (let attempt = 0; current && canEdit && !same(base, current); attempt++) {
    await backend.save(bundle, current);
    const up = await backend.driveUpload(`${bundle}/${PROJECT}`, { fileId: projectId });
    const before = base;
    const slipped = await slippedIn(projectId, rev, up.headRevisionId).catch(() => null);
    base = current;
    rev = up.headRevisionId;
    uploaded = true;
    await backend.writeJson(bundle, "base.json", base);
    if (!slipped || attempt >= RETRIES) break;
    // Someone saved between our check and our upload, and ours replaced theirs: merge theirs back in.
    const theirs = await download(bundle, projectId, slipped);
    const r = merge3(before, current, theirs);
    current = r.merged;
    conflicts.push(...r.conflicts);
  }

  await updateManifest(bundle, (x) => { x.projectId = projectId; x.rev = rev; x.canEdit = canEdit; });
  return { show: current, conflicts, uploaded, canEdit };
}

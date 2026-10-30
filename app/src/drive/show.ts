// A show in Google Drive and its copy on this Mac. The copy (shows/<Drive folder id>/ in the app's data folder) holds
// project.json and whatever media has been opened or made here, laid out as in Drive, so the rest of the app works on
// local files as it always has. Beside project.json:
//   base.json    the show as last agreed with Drive: what the field-by-field merge compares both sides with
//   .drive.json  the manifest: the Drive ids of the show's folder, project.json, and each media file and folder
//
// `syncShow` brings the copy and Drive together: it pulls someone else's save (merging it with edits made here), then
// uploads what's changed here. Drive has no "only if unchanged" upload, so after each upload it checks that nobody
// else's save landed between the version it merged with and its own; if any did, they're merged in and uploaded again.
import { backend, type DriveUser } from "../backend";
import type { Show } from "../model/types";
import { child, getFile, patiently, pause } from "./api";
import { merge3, same, type MergeConflict } from "./merge";

export const PROJECT = "project.json";
const RETRIES = 3;
const RETRY_PAUSE_MS = 200; // before uploading a re-merge, growing each time, so busy Macs stop landing on each other

export interface Manifest {
  folderId: string;
  projectId?: string;
  rev?: string; // project.json's headRevisionId that base.json is
  canEdit?: boolean;
  files: Record<string, { id: string; md5?: string; modified?: number }>; // bundle-relative path → Drive file (modified: ms)
  folders: Record<string, string>; // bundle-relative folder ("media/clips") → Drive folder id
  summary?: Record<string, string>; // the properties last written on the show's folder (see list.ts)
  openedAt?: number;
  held?: number; // when edits made offline began waiting to be approved (ms): nothing syncs until they are
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

interface Revision { id: string; modifiedTime: string; lastModifyingUser?: DriveUser }

/** project.json's revisions, oldest first. */
async function revisions(fileId: string): Promise<Revision[]> {
  const res = await patiently(() => backend.googleApi<{ revisions?: Revision[] }>("GET",
    `https://www.googleapis.com/drive/v3/files/${fileId}/revisions?pageSize=1000&fields=${encodeURIComponent("revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress,me))")}`));
  return [...(res.revisions ?? [])].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime));
}

/** When each person (by lowercased email) last saved project.json, from its revisions (Drive prunes old ones). */
export async function lastSaves(fileId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await revisions(fileId)) {
    const email = r.lastModifyingUser?.emailAddress?.toLowerCase();
    if (email) out.set(email, Date.parse(r.modifiedTime));
  }
  return out;
}

/**
 * The revisions saved after `base` and before ours (`rev`), newest first: other people's saves that landed in between.
 * If `base` is gone (Drive keeps only so many revisions), just the one before ours: older ones could be from before it.
 */
async function slippedIn(fileId: string, base: string | undefined, rev: string | undefined): Promise<Revision[]> {
  if (!base || !rev) return [];
  const revs = await revisions(fileId);
  const i = revs.findIndex((r) => r.id === rev);
  if (i < 1) return []; // can't tell
  const b = revs.findIndex((r) => r.id === base);
  return revs.slice(b >= 0 ? b + 1 : i - 1, i).reverse();
}

/** Someone who edited the show. `me`: the signed-in user (on another Mac). `via`: typed in the Google Sheet. */
export interface Editor { name: string; email: string; me?: boolean; via?: "sheet" }

export const editorOf = (u: DriveUser | undefined): Editor =>
  ({ name: u?.displayName || u?.emailAddress || "Someone", email: u?.emailAddress ?? "", ...(u?.me ? { me: true } : {}) });

/** Add `more` to `list`, once each. */
const addEditors = (list: Editor[], more: Editor[]) => {
  for (const e of more) if (!list.some((x) => (x.email || x.name) === (e.email || e.name))) list.push(e);
};

/** Who saved project.json after revision `since` (up to `head`): the head's last saver if those revisions are gone. */
async function savedBy(fileId: string, since: string, head: DriveUser | undefined): Promise<Editor[]> {
  const revs = await revisions(fileId).catch(() => []);
  const i = revs.findIndex((r) => r.id === since);
  if (i < 0) return [editorOf(head)];
  const out: Editor[] = [];
  addEditors(out, revs.slice(i + 1).map((r) => editorOf(r.lastModifyingUser)));
  return out.length ? out : [editorOf(head)];
}

export interface Merge { base: Show; mine: Show; theirs: Show; conflicts: MergeConflict[] }

export interface SyncResult {
  /** The show on this Mac now: this Mac's edits with everyone else's merged in. Null if there's none yet. */
  show: Show | null;
  /** Both sides changed the same thing; this Mac's value was kept. */
  conflicts: MergeConflict[];
  /** The merges that had conflicts, with the versions merged (to show each clash, and take theirs if someone picks it). */
  merges: Merge[];
  uploaded: boolean;
  canEdit: boolean;
  /** Edits made offline are waiting to be approved, so nothing was pulled or uploaded. */
  held?: boolean;
  /** Who saved the edits that came from Drive (none when nothing did, or on the first download). */
  editors: Editor[];
}

/**
 * Bring a show's copy and Drive together. `local` is the show as it is in the app (else project.json on this Mac).
 * The result's show is written to the copy; compare it with `local` to see what came from Drive.
 */
export function syncShow(bundle: string, local?: Show | null): Promise<SyncResult> {
  return serial(`sync:${bundle}`, () => patiently(() => syncNow(bundle, local)));
}

async function syncNow(bundle: string, localIn?: Show | null): Promise<SyncResult> {
  const m = await readManifest(bundle);
  if (m.held) {
    const show = localIn !== undefined ? localIn : await backend.open(bundle).catch(() => null);
    return { show, conflicts: [], merges: [], uploaded: false, canEdit: m.canEdit !== false, held: true, editors: [] };
  }
  const projectId = m.projectId ?? (await child(m.folderId, PROJECT))?.id;
  if (!projectId) throw new Error("This show's folder in Google Drive has no project.json");
  const meta = await getFile(projectId, "id,headRevisionId,capabilities(canEdit),lastModifyingUser(displayName,emailAddress,me)");
  const canEdit = meta.capabilities?.canEdit ?? false;
  let rev = m.rev;
  let base = await backend.readJson<Show>(bundle, "base.json").catch(() => null);
  let current = localIn !== undefined ? localIn : await backend.open(bundle).catch(() => null);
  const conflicts: MergeConflict[] = [];
  const merges: Merge[] = [];
  const editors: Editor[] = [];

  if (meta.headRevisionId !== rev || !base) {
    const theirs = await download(bundle, projectId);
    if (base && rev) addEditors(editors, await savedBy(projectId, rev, meta.lastModifyingUser));
    if (current && base && !same(base, current)) {
      const r = merge3(base, current, theirs);
      if (r.conflicts.length) merges.push({ base, mine: current, theirs, conflicts: r.conflicts });
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
    if (attempt) await pause(RETRY_PAUSE_MS * attempt * (0.5 + Math.random()));
    await backend.save(bundle, current);
    const up = await backend.driveUpload(`${bundle}/${PROJECT}`, { fileId: projectId });
    const before = base;
    const slipped = await slippedIn(projectId, rev, up.headRevisionId).catch(() => []);
    base = current;
    rev = up.headRevisionId;
    uploaded = true;
    await backend.writeJson(bundle, "base.json", base);
    if (!slipped.length) break;
    // Others saved between our check and our upload, and ours replaced theirs: merge theirs back in. Newest first, so
    // where two of theirs differ the later one wins; each clash is listed against this Mac's own edits only.
    const mine = current;
    let merged = current;
    const round: Merge[] = [];
    for (const s of slipped) {
      const theirs = await download(bundle, projectId, s.id);
      addEditors(editors, [editorOf(s.lastModifyingUser)]);
      const r = merge3(before, merged, theirs);
      if (r.conflicts.length) round.unshift({ base: before, mine, theirs, conflicts: r.conflicts });
      merged = r.merged;
      conflicts.push(...r.conflicts);
    }
    merges.push(...round);
    current = merged;
    if (attempt >= RETRIES) {
      // Still busy: what was merged stays on this Mac (it's not in Drive yet) for the next save or pull to upload.
      await backend.save(bundle, merged);
      break;
    }
  }

  await updateManifest(bundle, (x) => { x.projectId = projectId; x.rev = rev; x.canEdit = canEdit; });
  return { show: current, conflicts, merges, uploaded, canEdit, editors };
}

// --- edits made offline ------------------------------------------------------------------

/** Hold the copy's edits (made while Drive couldn't be reached): nothing syncs until they're approved. */
export const holdEdits = (bundle: string) => updateManifest(bundle, (m) => { m.held ??= Date.now(); });

/** Let the copy sync again (its held edits were approved, or thrown away). */
export const releaseEdits = (bundle: string) => updateManifest(bundle, (m) => { delete m.held; });

/** The show as last agreed with Drive, and Drive's project.json if someone has saved since (else null). Throws offline. */
export function peekDrive(bundle: string): Promise<{ base: Show | null; theirs: Show | null }> {
  return serial(`sync:${bundle}`, async () => {
    const m = await readManifest(bundle);
    const projectId = m.projectId ?? (await child(m.folderId, PROJECT))?.id;
    if (!projectId) throw new Error("This show's folder in Google Drive has no project.json");
    const meta = await getFile(projectId, "id,headRevisionId");
    const base = await backend.readJson<Show>(bundle, "base.json").catch(() => null);
    const theirs = meta.headRevisionId !== m.rev || !base ? await download(bundle, projectId) : null;
    return { base, theirs };
  });
}

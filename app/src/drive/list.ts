// All shows: every show the signed-in user can open in Google Drive (My Drive, shared drives and Shared with me).
// A show is a "<name>.showsheet" folder holding a project.json. Each show's folder carries a summary in its Drive
// properties (name, venue, date, song count, cover), written when the show is saved, so the list doesn't have to
// download every show; a show no app has saved since then is downloaded once to read it.
import type { ShowSummary } from "../backend";
import { showCover } from "../model/ops";
import type { Show } from "../model/types";
import { api, FOLDER, fitProperty, getFile, patchFile, search } from "./api";
import { readManifest, showDir, syncShow, updateManifest } from "./show";

export const SHOW_EXT = ".showsheet";
const FOLDER_FIELDS = "id,name,properties,driveId,ownedByMe,sharingUser(displayName,emailAddress),owners(displayName,emailAddress)";

/** The summary kept in a show folder's properties. */
export function summaryProps(show: Show): Record<string, string> {
  const props: Record<string, string> = { pmss: "1", name: show.name, songs: String(show.set_order.length) };
  if (show.venue) props.venue = show.venue;
  if (show.date) props.date = show.date;
  const cover = showCover(show);
  if (cover && !cover.startsWith("/")) props.cover = cover;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fitProperty(k, v)]));
}

/** Write the show's summary on its folder if it's changed since last time (unset keys are cleared). */
export async function writeSummary(bundle: string, show: Show): Promise<void> {
  const m = await readManifest(bundle);
  const props = summaryProps(show);
  const old = m.summary ?? {};
  if (Object.keys(props).length === Object.keys(old).length && Object.entries(props).every(([k, v]) => old[k] === v)) return;
  const cleared = Object.fromEntries(Object.keys(old).filter((k) => !(k in props)).map((k) => [k, null]));
  await patchFile(m.folderId, { properties: { ...cleared, ...props } });
  await updateManifest(bundle, (x) => { x.summary = props; });
}

let driveNames: Promise<Map<string, string>> | null = null;
/** Shared drive id → name. */
function sharedDrives(): Promise<Map<string, string>> {
  driveNames ??= api<{ drives?: { id: string; name: string }[] }>("GET", "https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)")
    .then((r) => new Map((r.drives ?? []).map((d) => [d.id, d.name])))
    .catch(() => { driveNames = null; return new Map(); });
  return driveNames;
}

type Folder = Awaited<ReturnType<typeof getFile>>;

/** "My Drive", "Shared drives / PM - CLIENTS", or "Shared with you by Sam". */
export function whereIs(folder: Folder, drives: Map<string, string>): string {
  if (folder.driveId) return `Shared drives / ${drives.get(folder.driveId) ?? "a shared drive"}`;
  if (folder.ownedByMe) return "My Drive";
  const by = folder.sharingUser?.displayName || folder.sharingUser?.emailAddress || folder.owners?.[0]?.displayName || folder.owners?.[0]?.emailAddress;
  return by ? `Shared with you by ${by}` : "Shared with you";
}

/** Every show in Google Drive, newest first. `onFound` gets each as it's ready. */
export async function findShows(onFound?: (s: ShowSummary) => void): Promise<ShowSummary[]> {
  const [projects, folders, drives] = await Promise.all([
    search("name = 'project.json' and trashed = false", "id,parents,modifiedTime,capabilities(canEdit)", true),
    search(`mimeType = '${FOLDER}' and name contains 'showsheet' and trashed = false`, FOLDER_FIELDS, true),
    sharedDrives(),
  ]);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: ShowSummary[] = [];
  for (const p of projects) {
    const parentId = p.parents?.[0];
    if (!parentId) continue;
    const folder = byId.get(parentId) ?? (await getFile(parentId, FOLDER_FIELDS).catch(() => null));
    if (!folder?.name?.endsWith(SHOW_EXT)) continue;
    const dir = await showDir(folder.id);
    const canEdit = p.capabilities?.canEdit ?? false;
    await updateManifest(dir, (m) => { m.projectId = p.id; m.canEdit = canEdit; });
    let props = folder.properties ?? {};
    if (props.pmss !== "1") {
      // Not saved by this version yet: download it to read its summary.
      const show = await syncShow(dir).then((r) => r.show).catch(() => null);
      if (!show) continue;
      props = summaryProps(show);
    }
    const summary: ShowSummary = {
      path: dir,
      name: props.name || folder.name.slice(0, -SHOW_EXT.length),
      venue: props.venue || null,
      date: props.date || null,
      songs: Number(props.songs) || 0,
      cover: props.cover ? `${dir}/${props.cover}` : null,
      modified_ms: Date.parse(p.modifiedTime ?? "") || 0,
      where: whereIs(folder, drives),
      canEdit,
    };
    out.push(summary);
    onFound?.(summary);
  }
  return out.sort((a, b) => b.modified_ms - a.modified_ms);
}

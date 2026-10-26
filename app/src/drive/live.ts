// The open show and Google Drive: opening it, uploading each save, pulling other people's saves every few seconds
// (merged with what's being edited here) and saying who has it open.
import { useEffect } from "react";
import { backend } from "../backend";
import { clipName } from "../model/ops";
import type { Show } from "../model/types";
import { useStore } from "../store";
import { getFile, notFound } from "./api";
import { whereIs, writeSummary } from "./list";
import { same, type MergeConflict } from "./merge";
import { uploadNewMedia } from "./media";
import { beat, leave } from "./presence";
import { readManifest, syncShow, updateManifest, type SyncResult } from "./show";

const PULL_EVERY_MS = 10_000;
const PRESENCE_EVERY_MS = 30_000;
export const VIEW_ONLY = "it's shared with you to view, not edit. Ask whoever shared it for edit access.";

/** Drive couldn't be reached (rather than refusing): keep working on this Mac's copy. */
export const isOffline = (e: unknown) => /reach Google|error sending request|network|timed out/i.test(String(e));

/** Open a show: bring its copy up to date with Drive, or use the copy as it is if Drive can't be reached. */
export async function openFromDrive(bundle: string): Promise<{ show: Show; readOnly: string | null; offline: boolean }> {
  try {
    const r = await syncShow(bundle);
    if (!r.show) throw new Error("The show is empty");
    await updateManifest(bundle, (m) => { m.openedAt = Date.now(); });
    return { show: r.show, readOnly: r.canEdit ? null : VIEW_ONLY, offline: false };
  } catch (e) {
    if (notFound(e)) throw new Error("This show isn't in Google Drive any more, or it's no longer shared with you");
    const show = isOffline(e) ? await backend.open(bundle).catch(() => null) : null;
    if (!show) throw e;
    const m = await readManifest(bundle);
    return { show, readOnly: m.canEdit === false ? VIEW_ONLY : null, offline: true };
  }
}

/** "Both you and someone else changed TC on 03 INTRO: kept yours." */
function conflictNote(show: Show, conflicts: MergeConflict[]): string {
  const [first] = conflicts;
  const [top, id, , col] = first.path;
  let what = String(top);
  if (top === "songs" && typeof id === "string" && show.songs[id]) {
    const label = typeof col === "string" ? show.columns.find((c) => c.id === col)?.label : null;
    what = label ? `${label} on ${clipName(show, id)}` : clipName(show, id);
  }
  const more = conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : "";
  return `Someone else changed ${what}${more} at the same time as you: kept yours`;
}

/** Bring what a sync found into the app, if the show is still open. */
function apply(bundle: string, sent: Show, r: SyncResult) {
  const st = useStore.getState();
  if (st.bundle !== bundle || !r.show) return;
  if (!same(sent, r.show)) st.applyRemote(sent, r.show);
  if (r.conflicts.length) st.toast(conflictNote(r.show, r.conflicts));
  const readOnly = r.canEdit ? null : VIEW_ONLY;
  if (st.readOnly !== readOnly) st.setReadOnly(readOnly);
}

/** Upload a save (the show as it was saved on this Mac), then its new media and the folder's summary. */
export async function pushShow(bundle: string, sent: Show): Promise<void> {
  const r = await syncShow(bundle, sent);
  apply(bundle, sent, r);
  if (!r.show || !r.canEdit) return;
  writeSummary(bundle, r.show).catch(() => {});
  uploadNewMedia(bundle, r.show).then((notes) => {
    if (notes.length) useStore.getState().toast(`Couldn't upload to Google Drive: ${notes.join(" · ")}`);
  }).catch(() => {});
}

/** Look for someone else's save. Skipped while there are changes here waiting to be saved: that save merges them. */
async function pull(bundle: string) {
  const st = useStore.getState();
  if (!st.show || st.bundle !== bundle || st.saveState === "unsaved" || st.saveState === "saving") return;
  const sent = st.show;
  try {
    apply(bundle, sent, await syncShow(bundle, sent)); // back online after saving offline: this uploads it
    if (useStore.getState().saveState === "offline") useStore.getState().setSaveState("saved"); // edits since would have made it "unsaved"
  } catch {
    /* offline, or Drive is busy: try again next time */
  }
}

/** Where the open show is in Drive: "Shared drives / PM - CLIENTS › 2026". */
async function locate(bundle: string): Promise<string | null> {
  const m = await readManifest(bundle);
  const folder = await getFile(m.folderId, "id,parents,driveId,ownedByMe,sharingUser(displayName,emailAddress),owners(displayName,emailAddress)");
  const drives = folder.driveId
    ? new Map([[folder.driveId, (await backend.googleApi<{ name: string }>("GET", `https://www.googleapis.com/drive/v3/drives/${folder.driveId}?fields=name`).catch(() => ({ name: "a shared drive" }))).name]])
    : new Map<string, string>();
  const where = whereIs(folder, drives);
  const parent = folder.parents?.[0] && folder.parents[0] !== folder.driveId ? await getFile(folder.parents[0], "name,parents").catch(() => null) : null;
  return parent?.name && parent.parents?.length ? `${where} › ${parent.name}` : where;
}

/** While a show is open: pull other people's saves, say who has it open, and find where it is. */
export function useDriveLive() {
  const bundle = useStore((s) => s.bundle);
  const user = useStore((s) => s.user);
  useEffect(() => {
    if (!bundle || !user || !backend.isDesktop) return;
    let folderId: string | null = null;
    readManifest(bundle).then((m) => { folderId = m.folderId; });
    locate(bundle).then((where) => { if (useStore.getState().bundle === bundle) useStore.getState().setLocation(where); }).catch(() => {});
    const say = () => {
      if (!folderId) return;
      const canEdit = !useStore.getState().readOnly;
      beat(folderId, user.email, user.name, canEdit).then((o) => { if (useStore.getState().bundle === bundle) useStore.getState().setOthers(o); }).catch(() => {});
    };
    const firstBeat = window.setTimeout(say, 1000);
    const pulls = window.setInterval(() => pull(bundle), PULL_EVERY_MS);
    const beats = window.setInterval(say, PRESENCE_EVERY_MS);
    const bye = () => { if (folderId && !useStore.getState().readOnly) leave(folderId, user.email).catch(() => {}); };
    window.addEventListener("beforeunload", bye);
    return () => {
      window.clearTimeout(firstBeat);
      window.clearInterval(pulls);
      window.clearInterval(beats);
      window.removeEventListener("beforeunload", bye);
      bye();
      useStore.getState().setOthers([]);
    };
  }, [bundle, user]);
}

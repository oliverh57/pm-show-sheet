// The open show and Google Drive: opening it, uploading each save, pulling other people's saves every few seconds
// (merged with what's being edited here) and saying who has it open. While Drive can't be reached the show is worked on
// offline: saves stay on this Mac and wait, once Drive is back, for someone to approve them (see offline.ts).
import { useEffect } from "react";
import { backend } from "../backend";
import { migrate } from "../model/ops";
import type { Show } from "../model/types";
import { useStore } from "../store";
import { getFile, notFound } from "./api";
import { whereIs, writeSummary } from "./list";
import { addEdits, editsFromDrive } from "./edits";
import { same } from "./merge";
import { uploadNewMedia } from "./media";
import { agreed, mergeClashes, type Clash } from "./offline";
import { beat, leave, type Presence } from "./presence";
import { holdEdits, lastSaves, readManifest, releaseEdits, syncShow, updateManifest, type SyncResult } from "./show";

const PULL_EVERY_MS = 10_000;
const PRESENCE_EVERY_MS = 30_000;
export const VIEW_ONLY = "it's shared with you to view, not edit. Ask whoever shared it for edit access.";

/** Drive couldn't be reached (rather than refusing): keep working on this Mac's copy. */
export const isOffline = (e: unknown) => /reach Google|error sending request|network|timed out/i.test(String(e));

/**
 * Open a show: bring its copy up to date with Drive, or use the copy as it is (`offline`) if Drive can't be reached or
 * the copy has edits made offline waiting to be approved.
 */
export async function openFromDrive(bundle: string): Promise<{ show: Show; readOnly: string | null; offline: boolean; clashes?: Clash[] }> {
  const held = await readManifest(bundle);
  if (held.held) return { show: await backend.open(bundle), readOnly: held.canEdit === false ? VIEW_ONLY : null, offline: true };
  try {
    const r = await syncShow(bundle);
    if (!r.show) throw new Error("The show is empty");
    await updateManifest(bundle, (m) => { m.openedAt = Date.now(); });
    return { show: r.show, readOnly: r.canEdit ? null : VIEW_ONLY, offline: false, clashes: clashesIn(r) };
  } catch (e) {
    if (notFound(e)) throw new Error("This show isn't in Google Drive any more, or it's no longer shared with you");
    const show = isOffline(e) ? await backend.open(bundle).catch(() => null) : null;
    if (!show) throw e;
    const m = await readManifest(bundle);
    return { show, readOnly: m.canEdit === false ? VIEW_ONLY : null, offline: true };
  }
}

/** The clashes in what a sync merged: this Mac's version was kept, until someone picks. */
const clashesIn = (r: SyncResult) => r.merges.flatMap((m) => mergeClashes(m.base, m.mine, m.theirs, m.conflicts));

/** Bring what a sync found into the app, if the show is still open. */
function apply(bundle: string, sent: Show, r: SyncResult) {
  const st = useStore.getState();
  if (st.bundle !== bundle || !r.show) return;
  if (!same(sent, r.show)) {
    st.applyRemote(sent, r.show);
    const found = editsFromDrive(sent, r.show, r.editors, st.user?.email);
    if (found) st.setRemoteEdits((prev) => addEdits(prev, found.by, found));
  }
  st.addClashes(clashesIn(r));
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
  if (!st.show || st.bundle !== bundle) return;
  if (st.connection === "offline") return checkBack(bundle);
  if (st.connection === "back" || st.saveState === "unsaved" || st.saveState === "saving") return;
  const sent = st.show;
  try {
    apply(bundle, sent, await syncShow(bundle, sent));
  } catch (e) {
    if (isOffline(e)) goOffline(); // else Drive is busy: try again next time
  }
}

// --- working offline -------------------------------------------------------------------------

/** Whether Google Drive can be reached. */
async function reachable(bundle: string): Promise<boolean> {
  try {
    await getFile((await readManifest(bundle)).folderId, "id");
    return true;
  } catch (e) {
    return !isOffline(e);
  }
}

/** Drive can't be reached: work on this Mac's copy, holding each save until it's approved. */
export function goOffline() {
  const st = useStore.getState();
  if (st.show && st.connection === "online") st.setConnection("offline");
}

let checking = false;
/** While offline: once Drive can be reached, go back online, or (if edits were made meanwhile) wait for them to be approved. */
export async function checkBack(bundle: string) {
  if (checking || useStore.getState().connection !== "offline") return;
  checking = true;
  try {
    if (!(await reachable(bundle))) return;
    const st = useStore.getState();
    if (st.bundle !== bundle || !st.show || st.connection !== "offline") return;
    if ((await readManifest(bundle)).held) {
      const base = await backend.readJson<Show>(bundle, "base.json").catch(() => null);
      const unchanged = base && st.saveState !== "unsaved" && same(agreed(base), st.show);
      if (!unchanged) {
        st.setConnection("back");
        return st.toast("You're back online. Review the changes you made offline to upload them.");
      }
      await releaseEdits(bundle);
    }
    st.setConnection("online");
    if (st.saveState === "offline") st.setSaveState("saved"); // nothing's different from Drive
    st.toast("You're back online");
  } finally {
    checking = false;
  }
}

/** Upload the edits made offline (merging anyone else's), now that they're approved: `keep`, if some were thrown away. */
export async function approveOffline(bundle: string, keep?: Show) {
  const st = useStore.getState();
  if (!st.show || st.bundle !== bundle) return;
  if (keep && !same(keep, st.show)) st.replace(keep);
  const show = useStore.getState().show!;
  await backend.save(bundle, show);
  st.setConnection("online"); // so a save while this uploads uploads too, after it
  await releaseEdits(bundle);
  try {
    await pushShow(bundle, show);
  } catch (e) {
    await holdEdits(bundle);
    useStore.getState().setConnection(isOffline(e) ? "offline" : "back");
    throw e;
  }
  if (useStore.getState().saveState === "offline") useStore.getState().setSaveState("saved");
}

/** Throw away the edits made offline: the show goes back to how it is in Drive (with anyone else's saves since). */
export async function discardOffline(bundle: string) {
  const base = await backend.readJson<Show>(bundle, "base.json").catch(() => null);
  if (!base) throw new Error("There's no copy of the show from Google Drive to go back to");
  await backend.save(bundle, base);
  await releaseEdits(bundle);
  const r = await syncShow(bundle, base);
  const st = useStore.getState();
  if (st.bundle !== bundle) return;
  st.replace(migrate(r.show ?? base));
  st.setConnection("online");
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

/**
 * When anyone without an edit time in their presence (older apps send none, and it only counts since they opened the
 * show) last saved it, from project.json's revisions.
 */
async function withLastSaves(bundle: string, others: Presence[]): Promise<Presence[]> {
  if (others.every((o) => o.editedAt)) return others;
  const { projectId } = await readManifest(bundle);
  const saves = projectId ? await lastSaves(projectId).catch(() => null) : null;
  return others.map((o) => {
    const saved = saves?.get(o.email.toLowerCase());
    return o.editedAt || !saved ? o : { ...o, editedAt: saved };
  });
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
      const { readOnly, editedAt } = useStore.getState();
      beat(folderId, user.email, user.name, !readOnly, editedAt).then((o) => withLastSaves(bundle, o)).then((o) => { if (useStore.getState().bundle === bundle) useStore.getState().setOthers(o); }).catch(() => {});
    };
    const firstBeat = window.setTimeout(say, 1000);
    const lost = () => goOffline();
    const found = () => checkBack(bundle);
    window.addEventListener("offline", lost);
    window.addEventListener("online", found);
    const pulls = window.setInterval(() => pull(bundle), PULL_EVERY_MS);
    const beats = window.setInterval(say, PRESENCE_EVERY_MS);
    const bye = () => { if (folderId && !useStore.getState().readOnly) leave(folderId, user.email).catch(() => {}); };
    window.addEventListener("beforeunload", bye);
    return () => {
      window.clearTimeout(firstBeat);
      window.clearInterval(pulls);
      window.clearInterval(beats);
      window.removeEventListener("beforeunload", bye);
      window.removeEventListener("offline", lost);
      window.removeEventListener("online", found);
      bye();
      useStore.getState().setOthers([]);
    };
  }, [bundle, user]);
}

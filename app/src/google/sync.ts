// Always-on Google sync. While a show is open the app keeps its Google Sheet and Slides deck up to date:
// a few seconds after each change it pulls collaborator edits from the Sheet's ✎ columns, then pushes the
// show; the deck is redrawn when you pause. Every minute it also checks the Sheet for edits.
// There's no Publish step. One job runs at a time.
import { useEffect } from "react";
import { create } from "zustand";
import { backend } from "../backend";
import type { GoogleSync, Show } from "../model/types";
import { applySheetValue, songImagePaths } from "../model/ops";
import { useStore } from "../store";
import {
  columnChangeRequests, contentRequests, diffShowTab, HEADER_ROWS, protectionUpdateRequests, reconcileRequests, reconcileRows, type SheetProtection, showTab, snapshot,
  structureRequests, ARCHIVE_TAB, SHOW_TAB, type Conflict, type TabGrid,
} from "./sheet";
import { deckFingerprint, deckRequests } from "./slides";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME = "application/vnd.google-apps.presentation";
const TAB_ID = 1001;
const ARCHIVE_TAB_ID = 1002;
const PUSH_DELAY_MS = 3000;
const DECK_DELAY_MS = 15000;
const POLL_MS = 60000;
const RETRY_MS = 30000;
const IMAGE_PX = 2560;

export type SyncState = "off" | "syncing" | "ok" | "error";
interface Status {
  state: SyncState;
  message: string | null;
  lastSync: number | null;
  deck: "idle" | "waiting" | "drawing";
}
export const useSyncStatus = create<Status>(() => ({ state: "off", message: null, lastSync: null, deck: "idle" }));
const status = (s: Partial<Status>) => useSyncStatus.setState(s);

const api = <T,>(method: string, url: string, body?: unknown) => backend.googleApi<T>(method, url, body);
const enc = encodeURIComponent;
const a1 = (title: string) => `'${title.replace(/'/g, "''")}'`;
const imageUrl = (fileId: string) => `https://lh3.googleusercontent.com/d/${fileId}`;
const playUrl = (fileId: string) => `https://drive.google.com/file/d/${fileId}/view`;

/** Write sync bookkeeping into the show without an undo step. */
function meta(fn: (g: GoogleSync, show: Show) => void) {
  useStore.getState().updateQuiet((s) => { s.google ??= {}; fn(s.google, s); });
}
const g = () => useStore.getState().show?.google ?? {};

// --- one-time setup ------------------------------------------------------------
// The Sheet, the deck and the images the deck uses live inside the show's own .showsheet folder in Drive,
// so they move, share and delete with the show.

const ALL = "supportsAllDrives=true"; // shows are often in shared drives
export const IMAGES_FOLDER = "Slides images";

/** The Drive id of the open show's .showsheet folder (Drive for desktop has to have uploaded it first). */
async function showFolderId(): Promise<string> {
  const id = await backend.driveItemId(useStore.getState().bundle!);
  if (!id) throw new Error("Waiting for Google Drive to upload the show");
  return id;
}

/**
 * Move the Sheet, deck and images into the show's folder (and bin the old folder once it's empty): for a show moved
 * by copying (across drives, which leaves them behind: see bundle_move), and shows from before they lived in the
 * show's folder, which kept them in a "SHOW | PM Show Sheet" folder in My Drive.
 */
async function moveInto(folder: string): Promise<void> {
  const old = g().folder_id;
  const files: [string | undefined, string | null][] = [[g().spreadsheet_id, null], [g().presentation_id, null], [g().media_folder_id, IMAGES_FOLDER]];
  let refused = false;
  for (const [id, rename] of files) {
    if (!id) continue;
    const f = await api<{ parents?: string[] }>("GET", `${DRIVE}/${id}?fields=parents&${ALL}`);
    if (f.parents?.includes(folder)) continue;
    // A shared drive can refuse them: they work from where they are (by id), so they stay there.
    await api("PATCH", `${DRIVE}/${id}?addParents=${folder}&removeParents=${(f.parents ?? []).join(",")}&${ALL}`, rename ? { name: rename } : {})
      .catch(() => { refused = true; });
  }
  if (refused) useStore.getState().toast("Google Drive wouldn't move the Sheet and deck into the show's new folder: they still work from where they were");
  if (old && old !== folder) {
    const left = await api<{ files?: unknown[] }>("GET", `${DRIVE}?q=${enc(`'${old}' in parents and trashed = false`)}&fields=files(id)&${ALL}&includeItemsFromAllDrives=true`).catch(() => null);
    if (left && !left.files?.length) await api("PATCH", `${DRIVE}/${old}?${ALL}`, { trashed: true }).catch(() => {});
  }
  meta((x) => { x.folder_id = folder; });
}

async function ensureFiles(): Promise<void> {
  const show = useStore.getState().show!;
  const folder = await showFolderId();
  const create = (body: object) => api<{ id: string; webViewLink?: string }>("POST", `${DRIVE}?fields=id,webViewLink&${ALL}`, body);
  if (g().folder_id !== folder) await moveInto(folder);
  if (!g().media_folder_id) {
    const f = await create({ name: IMAGES_FOLDER, mimeType: FOLDER, parents: [folder] });
    meta((x) => { x.media_folder_id = f.id; });
  }
  if (!g().spreadsheet_id) {
    const f = await create({ name: `${show.name} | SHOW SHEET`, mimeType: SHEET_MIME, parents: [folder] });
    meta((x) => { x.spreadsheet_id = f.id; x.sheet_url = f.webViewLink; x.tab_id = undefined; x.archive_tab_id = undefined; x.published = {}; });
  }
  if (g().named !== show.name && g().spreadsheet_id && g().presentation_id) {
    // Renamed show: retitle the Sheet and deck to match.
    await api("PATCH", `${DRIVE}/${g().spreadsheet_id}?${ALL}`, { name: `${show.name} | SHOW SHEET` });
    await api("PATCH", `${DRIVE}/${g().presentation_id}?${ALL}`, { name: `${show.name} | SHOW DECK` });
    meta((x) => { x.named = show.name; });
  }
  if (!g().presentation_id) {
    const f = await create({ name: `${show.name} | SHOW DECK`, mimeType: SLIDES_MIME, parents: [folder] });
    meta((x) => { x.presentation_id = f.id; x.slides_url = f.webViewLink; });
  }
}

/** Upload any image-column images (renders, tagged stills) not on Drive yet (downsized). Returns image path → image URL. */
async function ensureImages(songIds: string[]): Promise<Record<string, { url: string; id: string }>> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) return {};
  const out: Record<string, { url: string; id: string }> = {};
  const paths = [...new Set(songIds.flatMap((sid) => (show.songs[sid] ? songImagePaths(show.songs[sid]) : [])))];
  for (const img of paths) {
    let id = g().images?.[img];
    if (!id) {
      const path = img.startsWith("/") ? img : `${bundle}/${img}`;
      try {
        id = await backend.googleUpload(path, img.split("/").pop() ?? "render.jpg", g().media_folder_id ?? null, null, IMAGE_PX);
      } catch {
        continue; // missing file: the cell stays empty
      }
      const fileId = id;
      meta((x) => { x.images = { ...x.images, [img]: fileId }; });
    }
    out[img] = { url: imageUrl(id), id };
  }
  return out;
}

/** Bin the Drive copies of images no song uses any more (removed images, replaced heroes, deleted songs). */
async function pruneImages(): Promise<void> {
  const show = useStore.getState().show!;
  const used = new Set(Object.values(show.songs).flatMap(songImagePaths));
  for (const [path, id] of Object.entries(g().images ?? {})) {
    if (used.has(path)) continue;
    try {
      await api("PATCH", `${DRIVE}/${id}?${ALL}`, { trashed: true });
    } catch (e) {
      if (!/^(Error: )?Google 404/.test(String(e))) continue; // try again next sync; already gone is fine
    }
    meta((x) => { const { [path]: _, ...rest } = x.images ?? {}; x.images = rest; });
  }
}

/**
 * Clips are saved in the show's folder, so Drive for desktop uploads them with it: find each one's Drive id (and forget
 * clips no song has any more). A clip not uploaded yet is looked for again next time.
 */
async function resolveClips(): Promise<void> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) return;
  const known = g().clips ?? {};
  const paths = new Set(Object.values(show.songs).flatMap((s) => (s.clips ?? []).map((c) => c.path)));
  const found: Record<string, string> = {};
  for (const path of paths) {
    if (known[path]) continue;
    const id = await backend.driveItemId(`${bundle}/${path}`);
    if (id) found[path] = id;
  }
  const gone = Object.keys(known).filter((p) => !paths.has(p));
  if (!Object.keys(found).length && !gone.length) return;
  meta((x) => {
    const next = { ...x.clips, ...found };
    for (const p of gone) delete next[p];
    x.clips = next;
  });
}

/** Clip path → where it plays on Drive. */
const clipUrls = () => Object.fromEntries(Object.entries(g().clips ?? {}).map(([path, id]) => [path, playUrl(id)]));

// --- the Sheet ------------------------------------------------------------------

interface SheetMeta { sheets: { properties: { sheetId: number; title: string; gridProperties?: { columnCount?: number } }; protectedRanges?: SheetProtection[] }[] }

/** Bring collaborator edits from the ✎ columns (of both tabs) into the show. */
async function pull(): Promise<void> {
  const { spreadsheet_id: ssid, tab_id, archive_tab_id, published } = g();
  if (!ssid || !tab_id || !published) return;
  const tabs = archive_tab_id ? [SHOW_TAB, ARCHIVE_TAB] : [SHOW_TAB];
  const res = await api<{ valueRanges: { values?: unknown[][] }[] }>("GET",
    `${SHEETS}/${ssid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${tabs.map((t) => `ranges=${enc(a1(t))}`).join("&")}`);
  const show = useStore.getState().show!;
  const diffs = res.valueRanges.map((r) => diffShowTab(show, published, r.values ?? []));
  const edits = diffs.flatMap((d) => d.edits);
  const conflicts = diffs.flatMap((d) => d.conflicts);
  if (edits.length) {
    useStore.getState().update((s) => {
      for (const e of edits) {
        const col = s.columns.find((c) => c.id === e.colId);
        if (col) applySheetValue(s, e.songId, col, e.value);
      }
    });
    meta((x) => { for (const e of edits) x.published = { ...x.published, [`show|${e.songId}|${e.colId}`]: e.value }; });
    useStore.getState().toast(`${edits.length} change${edits.length === 1 ? "" : "s"} from the Google Sheet`);
  }
  if (conflicts.length) recordConflicts(conflicts);
}

function recordConflicts(conflicts: Conflict[]) {
  const current = (useStore.getState().show?.conflicts ?? {}) as Record<string, unknown>;
  const fresh = conflicts.filter((c) => !(`show|${c.songId}|${c.colId}` in current));
  if (!fresh.length) return;
  useStore.getState().updateQuiet((s) => {
    s.conflicts = { ...(s.conflicts ?? {}) };
    for (const c of fresh) s.conflicts[`show|${c.songId}|${c.colId}`] = { sheet: c.sheet, app: c.app, published: c.published };
  });
  useStore.getState().toast(`${fresh.length} Sheet edit${fresh.length === 1 ? "" : "s"} clashed with the app. See Share & publish.`);
}

async function pushSheet(): Promise<void> {
  const { user } = useStore.getState();
  const ssid = g().spreadsheet_id!;
  const show = useStore.getState().show!;
  const images = await ensureImages([...show.set_order, ...show.archive]);
  const urls = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.url]));
  // The running order on SHOW SHEET, archived songs on ARCHIVED SONGS: a song moves between them as it's archived or restored.
  const grids: [TabGrid, number][] = [[showTab(show, urls, clipUrls()), TAB_ID], [showTab(show, urls, clipUrls(), true), ARCHIVE_TAB_ID]];
  const metaRes = await api<SheetMeta>("GET", `${SHEETS}/${ssid}?fields=${enc("sheets(properties(sheetId,title,gridProperties(columnCount)))")}`);
  const tabs = new Map(metaRes.sheets.map((s) => [s.properties.sheetId, s]));
  const reqs: object[] = [];
  const columnsChanged = new Set<number>();
  const existing = grids.filter(([, id]) => tabs.has(id));
  const read = existing.length ? await api<{ valueRanges: { values?: unknown[][] }[] }>("GET",
    `${SHEETS}/${ssid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${existing.flatMap(([, id]) => {
      const t = a1(tabs.get(id)!.properties.title);
      return [`ranges=${enc(`${t}!1:1`)}`, `ranges=${enc(`${t}!A${HEADER_ROWS + 1}:A`)}`];
    }).join("&")}`) : { valueRanges: [] };
  for (const [grid, id] of grids) {
    const tab = tabs.get(id);
    if (!tab) {
      reqs.push(...structureRequests(grid, id));
      if (id === TAB_ID && tabs.has(0)) reqs.push({ deleteSheet: { sheetId: 0 } }); // the default "Sheet1"
      continue;
    }
    const at = existing.findIndex(([, eid]) => eid === id) * 2;
    if (tab.properties.title !== grid.title) reqs.push({ updateSheetProperties: { properties: { sheetId: id, title: grid.title }, fields: "title" } });
    const headerIds = (read.valueRanges[at]?.values?.[0] ?? []).map(String);
    if (headerIds.join("|") !== grid.colIds.join("|")) {
      columnsChanged.add(id);
      reqs.push(...columnChangeRequests(grid, id, tab.properties.gridProperties?.columnCount ?? headerIds.length));
    }
    const rowIds = (read.valueRanges[at + 1]?.values ?? []).map((r) => (r?.[0] === undefined ? "" : String(r[0])));
    reqs.push(...reconcileRequests(reconcileRows(rowIds, grid.rowIds), id));
  }
  for (const [grid, id] of grids) reqs.push(...contentRequests(grid, id));
  await api("POST", `${SHEETS}/${ssid}:batchUpdate`, { requests: reqs });
  // Snapshot the show that was pushed, not the current one: an edit made while the push was in flight isn't in the
  // Sheet, and recording it as published would make the next pull read the Sheet's old value as a collaborator's edit.
  const pushed = snapshot(show);
  meta((x) => { x.tab_id = TAB_ID; x.archive_tab_id = ARCHIVE_TAB_ID; x.published = pushed; });
  lastSheet = sheetFingerprint(show);
  await lockTabs(ssid, grids, user?.email ?? "", columnsChanged);
  await pruneImages();
}

let lockRefused: string | null = null; // why Google last refused the tabs' lock, said once rather than every push

/**
 * Lock all but the ✎ columns of each tab, when they aren't locked that way already. Sent on its own after the push, with
 * the ranges read fresh (a column deleted in the push can change them), so a lock Google refuses never stops the sync.
 */
async function lockTabs(ssid: string, grids: [TabGrid, number][], me: string, columnsChanged: Set<number>) {
  // Everyone who syncs the show from the app writes every column, so each one goes on the lock's editors (and stays
  // there, so a collaborator's sync doesn't lock out whoever made the show).
  if (me && !(g().app_editors ?? []).some((e) => e.toLowerCase() === me.toLowerCase())) meta((x) => { x.app_editors = [...(x.app_editors ?? []), me]; });
  const editors = [...new Set([me, ...(g().app_editors ?? [])].filter(Boolean).map((e) => e.toLowerCase()))];
  try {
    const res = await api<SheetMeta>("GET", `${SHEETS}/${ssid}?fields=${enc("sheets(properties(sheetId),protectedRanges(protectedRangeId,warningOnly,range,unprotectedRanges,editors))")}`);
    const reqs = grids.flatMap(([grid, id]) => {
      const ranges = res.sheets.find((s) => s.properties.sheetId === id)?.protectedRanges ?? [];
      return protectionUpdateRequests(grid, id, ranges, editors, columnsChanged.has(id));
    });
    if (reqs.length) await api("POST", `${SHEETS}/${ssid}:batchUpdate`, { requests: reqs });
    lockRefused = null;
  } catch (e) {
    const why = String(e).replace(/^Error: /, "");
    if (why !== lockRefused) useStore.getState().toast(`The Sheet synced, but its locked columns couldn't be updated: ${why}`);
    lockRefused = why;
  }
}

// --- the deck ---------------------------------------------------------------------

async function pushDeck(): Promise<void> {
  const show = useStore.getState().show!;
  const pid = g().presentation_id!;
  status({ deck: "drawing" });
  const images = await ensureImages(show.set_order);
  const pres = await api<{ slides?: { objectId: string; pageElements?: { objectId: string }[] }[] }>("GET", `${SLIDES}/${pid}?fields=${enc("slides(objectId,pageElements(objectId))")}`);
  const existing = Object.fromEntries((pres.slides ?? []).map((s) => [s.objectId, (s.pageElements ?? []).map((e) => e.objectId)]));
  const rev = (g().slides_rev ?? 0) + 1;
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const reqs = deckRequests(show, rev, Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.url])), existing, today, clipUrls());
  // Slides copies an image in from a URL Google can fetch, so each one is link-public only while it's inserted.
  const ids = Object.values(images).map((i) => i.id);
  try {
    for (const id of ids) await api("POST", `${DRIVE}/${id}/permissions?${ALL}`, { type: "anyone", role: "reader", allowFileDiscovery: false });
    if (ids.length) await new Promise((r) => setTimeout(r, 2000));
    await api("POST", `${SLIDES}/${pid}:batchUpdate`, { requests: reqs });
  } finally {
    for (const id of ids) await api("DELETE", `${DRIVE}/${id}/permissions/anyoneWithLink?${ALL}`).catch(() => {});
  }
  lastDeck = deckFingerprint(show);
  const hash = lastDeck;
  meta((x) => { x.slides_rev = rev; x.deck_hash = hash; });
  status({ deck: "idle" });
}

// --- scheduling -------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();
let lastSheet: string | null = null;
let lastDeck: string | null = null;
let generation = 0; // bumps when the open show changes, so stale jobs stop

function sheetFingerprint(show: Show): string {
  return JSON.stringify([show.name, show.columns, show.set_order, show.archive,
    Object.values(show.songs).map((s) => [s.id, s.fields, s.statuses, s.colours, s.hero, s.images, s.segues_into_next, s.clips]), show.google?.clips]);
}

function run(job: () => Promise<void>) {
  const gen = generation;
  queue = queue.then(async () => {
    if (gen !== generation || !useStore.getState().show) return;
    status({ state: "syncing" });
    try {
      await job();
      if (gen === generation) status({ state: "ok", message: null, lastSync: Date.now() });
    } catch (e) {
      if (gen !== generation) return;
      status({ state: "error", message: String(e).replace(/^Error: /, ""), deck: "idle" });
      setTimeout(() => { if (gen === generation) syncNow(); }, RETRY_MS);
    }
  });
}

/** Pull, then push the Sheet if anything changed (or always, with `force`). */
export function syncNow(force = false) {
  run(async () => {
    await ensureFiles();
    await resolveClips();
    await pull();
    const show = useStore.getState().show!;
    if (force || sheetFingerprint(show) !== lastSheet || !g().tab_id) await pushSheet();
    if (force || deckFingerprint(show) !== lastDeck) await pushDeck();
  });
}

/** Run the sync engine while a show is open (desktop app, signed in). */
export function useGoogleSync() {
  const bundle = useStore((s) => s.bundle);
  const user = useStore((s) => s.user);
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    generation++;
    lastSheet = null;
    lastDeck = useStore.getState().show?.google?.deck_hash ?? null; // don't redraw an unchanged deck on open
    if (!bundle || !user) return status({ state: "off", message: null });
    if (readOnly) return status({ state: "off", message: "Read only" });
    if (!backend.isDesktop) return status({ state: "off", message: "Google sync runs in the desktop app" });
    syncNow();
    let sheetTimer: number | undefined;
    let deckTimer: number | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      if (!s.show || s.show === prev.show) return;
      if (sheetFingerprint(s.show) !== lastSheet) {
        window.clearTimeout(sheetTimer);
        sheetTimer = window.setTimeout(() => run(async () => { await pull(); await pushSheet(); }), PUSH_DELAY_MS);
      }
      if (deckFingerprint(s.show) !== lastDeck) {
        status({ deck: "waiting" });
        window.clearTimeout(deckTimer);
        deckTimer = window.setTimeout(() => run(pushDeck), DECK_DELAY_MS);
      }
    });
    const poll = window.setInterval(() => run(async () => {
      await resolveClips();
      await pull();
      if (sheetFingerprint(useStore.getState().show!) !== lastSheet) await pushSheet();
    }), POLL_MS);
    return () => {
      unsub();
      window.clearTimeout(sheetTimer);
      window.clearTimeout(deckTimer);
      window.clearInterval(poll);
    };
  }, [bundle, user, readOnly]);
}

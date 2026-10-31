// Always-on Google sync. While a show is open the app keeps its Google Sheet and Slides deck up to date:
// a few seconds after each change it pulls collaborator edits from the Sheet's ✎ columns, then pushes the
// show; the deck is redrawn when you pause. Every minute it also checks the Sheet for edits.
// There's no Publish step. One job runs at a time, and only on the Mac holding the show's sync lease (drive/lease.ts):
// the others see its pushes through Drive.
import { useEffect } from "react";
import { create } from "zustand";
import { backend } from "../backend";
import type { GoogleSync, Show } from "../model/types";
import { applySheetValue, newId, songImagePaths } from "../model/ops";
import { useStore } from "../store";
import {
  applyReviewEdits, colLetter, emailKey, REPLY_FROM, sheetAuthor, type SheetAuthor, type SheetRevision, columnChangeRequests, formatRuleRequests, mergeUpdateRequests, spareColumnRequests, type SheetFormatRule, type SheetMerge, contentRequests, withSheetValues, diffReviewTab, diffShowTab, HEADER_ROWS, keptCells, protectionUpdateRequests, reconcileRequests, reconcileRows,
  reviewTab, type SheetProtection, sheetValue, showTab, snapshot, structureRequests, ARCHIVE_TAB, REVIEW_TAB, SHOW_TAB, type Conflict, type Edit, type TabGrid,
} from "./sheet";
import { deckFingerprint, deckRequests, playUrl } from "./slides";
import { driveIdOf } from "../drive/media";
import { addEdits, editsBetween, editorKey, sheetEditor as asEditor, sheetPull } from "../drive/edits";
import { folderIdOf, readManifest } from "../drive/show";
import { holdLease, releaseLease, THIS_MAC, type Lease } from "../drive/lease";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME = "application/vnd.google-apps.presentation";
const TAB_ID = 1001;
const ARCHIVE_TAB_ID = 1002;
const REVIEW_TAB_ID = 1003;
const PUSH_DELAY_MS = 3000;
const DECK_DELAY_MS = 60000; // a redraw takes a while, so wait for a proper pause
const POLL_MS = 60000;
const RETRY_MS = 30000;
const QUOTA_RETRY_MS = 60000; // Google's quotas are per minute
const MAX_RETRY_MS = 5 * 60000;
const CLASH_RETRY_MS = 4000; // and up to as long again, so two Macs don't clash again
const MAX_CLASHES = 3; // in a row, before it's said as an error
const LEASE_EVERY_MS = 30000; // renew the sync lease, or look whether it's free
const IMAGE_PX = 2560;

export type SyncState = "off" | "syncing" | "ok" | "error";
interface Status {
  state: SyncState;
  message: string | null;
  lastSync: number | null;
  deck: "idle" | "waiting" | "drawing";
  /** What the running sync is doing, in plain words ("Updating the Sheet"). */
  step: string | null;
  /** When a failed sync is tried again (ms). */
  retryAt: number | null;
  /** Who's syncing the show from their Mac, when it's not this one. */
  by: string | null;
}
export const useSyncStatus = create<Status>(() => ({ state: "off", message: null, lastSync: null, deck: "idle", step: null, retryAt: null, by: null }));
const status = (s: Partial<Status>) => useSyncStatus.setState(s);
const step = (what: string) => status({ step: what });

const api = <T,>(method: string, url: string, body?: unknown) => backend.googleApi<T>(method, url, body);
const enc = encodeURIComponent;
const a1 = (title: string) => `'${title.replace(/'/g, "''")}'`;
const imageUrl = (fileId: string) => `https://lh3.googleusercontent.com/d/${fileId}`;

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

/** The Drive id of the open show's .showsheet folder. */
async function showFolderId(): Promise<string> {
  return (await readManifest(useStore.getState().bundle!)).folderId;
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
  step("Moving the Sheet and deck into the show's folder");
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
  if (!g().media_folder_id || !g().spreadsheet_id || !g().presentation_id) step("Making the Google Sheet and deck");
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
    step("Renaming the Sheet and deck");
    await api("PATCH", `${DRIVE}/${g().spreadsheet_id}?${ALL}`, { name: `${show.name} | SHOW SHEET` });
    await api("PATCH", `${DRIVE}/${g().presentation_id}?${ALL}`, { name: `${show.name} | SHOW DECK` });
    meta((x) => { x.named = show.name; });
  }
  if (!g().presentation_id) {
    const f = await create({ name: `${show.name} | SHOW DECK`, mimeType: SLIDES_MIME, parents: [folder] });
    meta((x) => { x.presentation_id = f.id; x.slides_url = f.webViewLink; });
  }
}

/** The frames of the comments in the REVIEW tab. */
const reviewStills = (show: Show) => (show.reviews ?? []).flatMap((c) => (c.still ? [c.still] : []));

/**
 * Upload any image-column images (renders, tagged stills) of these songs, and `extra` images, not on Drive yet
 * (downsized). Returns image path → image URL, and how many couldn't be found (made on a Mac that hasn't uploaded them yet).
 */
async function ensureImages(songIds: string[], extra: string[] = []): Promise<{ images: Record<string, { url: string; id: string }>; missing: number }> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) return { images: {}, missing: 0 };
  const out: Record<string, { url: string; id: string }> = {};
  let missing = 0;
  const paths = [...new Set([...songIds.flatMap((sid) => (show.songs[sid] ? songImagePaths(show.songs[sid]) : [])), ...extra])];
  const todo = paths.filter((p) => !g().images?.[p]).length;
  let n = 0;
  for (const img of paths) {
    let id = g().images?.[img];
    if (!id) {
      step(`Uploading image ${++n} of ${todo}`);
      const path = img.startsWith("/") ? img : `${bundle}/${img}`;
      try {
        if (!img.startsWith("/")) await backend.driveFetch(bundle, [img], true); // made on another Mac: download it first (quietly: it's only for the Sheet)
        id = await backend.googleUpload(path, img.split("/").pop() ?? "render.jpg", g().media_folder_id ?? null, null, IMAGE_PX);
      } catch {
        missing++;
        continue; // missing file: the cell stays empty
      }
      const fileId = id;
      meta((x) => { x.images = { ...x.images, [img]: fileId }; });
    }
    out[img] = { url: imageUrl(id), id };
  }
  return { images: out, missing };
}

/** Bin the Drive copies of images no song uses any more (removed images, replaced heroes, deleted songs). */
async function pruneImages(): Promise<void> {
  const show = useStore.getState().show!;
  const used = new Set([...Object.values(show.songs).flatMap(songImagePaths), ...reviewStills(show)]);
  for (const [path, id] of Object.entries(g().images ?? {})) {
    if (used.has(path)) continue;
    step("Removing images no song uses");
    try {
      await api("PATCH", `${DRIVE}/${id}?${ALL}`, { trashed: true });
    } catch (e) {
      if (!/^(Error: )?Google 404/.test(String(e))) continue; // try again next sync; already gone is fine
    }
    meta((x) => { const { [path]: _, ...rest } = x.images ?? {}; x.images = rest; });
  }
}

const CLIPS_DIR = "media/clips/";

/**
 * Clips are uploaded to the show's folder after they're made (src/drive/media.ts): find each one's Drive id (and forget
 * clips no song has any more). A clip not uploaded yet is looked for again next time.
 *
 * The clips folder is listed on Drive rather than trusting stored ids: shows from when Drive for desktop synced them
 * could hold the id of a file a clip was copied from (often binned, and not shared with anyone else), and listing
 * mends those.
 */
export async function resolveClips(): Promise<void> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) return;
  const known = g().clips ?? {};
  const paths = new Set(Object.values(show.songs).flatMap((s) => (s.clips ?? []).map((c) => c.path)));
  if (paths.size) step("Finding the clips on Drive");
  const inFolder = [...paths].filter((p) => p.startsWith(CLIPS_DIR) && !p.slice(CLIPS_DIR.length).includes("/"));
  const onDrive = new Map<string, string>(); // file name → id, the most recently changed if two share a name
  const folder = inFolder.length ? await driveIdOf(`${bundle}/${CLIPS_DIR.slice(0, -1)}`, bundle) : null;
  if (folder) {
    const q = enc(`'${folder}' in parents and trashed = false`);
    let page: string | undefined;
    do {
      const res = await api<{ files?: { id: string; name: string }[]; nextPageToken?: string }>("GET",
        `${DRIVE}?q=${q}&fields=${enc("nextPageToken,files(id,name)")}&orderBy=modifiedTime%20desc&pageSize=1000&${ALL}&includeItemsFromAllDrives=true${page ? `&pageToken=${enc(page)}` : ""}`);
      for (const f of res.files ?? []) if (!onDrive.has(f.name)) onDrive.set(f.name, f.id);
      page = res.nextPageToken;
    } while (page);
  }
  const next: Record<string, string> = {};
  for (const path of paths) {
    if (folder && inFolder.includes(path)) {
      const id = onDrive.get(path.slice(CLIPS_DIR.length));
      if (id) next[path] = id; // not uploaded yet: no link until it is
    } else {
      const id = known[path] ?? (await driveIdOf(`${bundle}/${path}`, bundle));
      if (id) next[path] = id;
    }
  }
  const same = Object.keys(next).length === Object.keys(known).length && Object.entries(next).every(([p, id]) => known[p] === id);
  if (!same) meta((x) => { x.clips = next; });
}

/** Clip path → where it plays on Drive. */
const clipUrls = () => Object.fromEntries(Object.entries(g().clips ?? {}).map(([path, id]) => [path, playUrl(id)]));

// --- the Sheet ------------------------------------------------------------------

interface SheetMeta {
  sheets: { properties: { sheetId: number; title: string; gridProperties?: { columnCount?: number } }; protectedRanges?: SheetProtection[]; merges?: SheetMerge[]; conditionalFormats?: SheetFormatRule[] }[];
}

/** Bring collaborator edits from the ✎ columns (of the song tabs and the REVIEW tab) into the show. */
/** When each Sheet's REVIEW tab was last read (its id → ms): anything new in it since was typed after then. */
const lastRead = new Map<string, number>();
/** The same for its song tabs. */
const lastShowRead = new Map<string, number>();

/**
 * Say what a pull brought in from the Sheet (`before` → `after`), put down to `author` (else whoever edited the Sheet
 * since `since`), like an edit from another Mac. Noted in the show too, so the other Macs say so when it reaches them.
 */
async function noteSheetEdits(ssid: string, before: Show, after: Show, since: number | null, author?: SheetAuthor | null) {
  const typist = asEditor(author ?? await sheetEditor(ssid, since).catch(() => null), useStore.getState().user?.email);
  const found = editsBetween(before, after, editorKey(typist));
  if (!found) return;
  useStore.getState().setRemoteEdits((prev) => addEdits(prev, [typist], found));
  meta((x) => {
    // Song cells and comments read in the same pull, by the same person: one note.
    const was = x.sheet_pull;
    const next = sheetPull(found, typist);
    if (was && was.by.name === next.by.name && was.by.email === next.by.email && next.at - was.at < POLL_MS) {
      for (const [id, keys] of Object.entries(was.songs)) next.songs[id] = [...new Set([...keys, ...(next.songs[id] ?? [])])];
    }
    x.sheet_pull = next;
  });
}

async function pull(): Promise<void> {
  const { spreadsheet_id: ssid, tab_id, archive_tab_id, review_tab_id, published } = g();
  if (!ssid || !tab_id || !published) return;
  step("Checking the Sheet for edits");
  const readAt = Date.now();
  // REVIEW in the same read. A REVIEW tab someone deleted is made again by the push, so it mustn't stop the pull: then
  // Google refuses the range and the song tabs are read on their own.
  const tabs = songTabs(archive_tab_id);
  const all = review_tab_id
    ? await tabValues(ssid, [...tabs, REVIEW_TAB]).catch((e) => { if (/Google 400/.test(String(e))) return null; throw e; })
    : null;
  const values = all ? all.slice(0, tabs.length) : await tabValues(ssid, tabs);
  const review = all?.[tabs.length];
  const since = lastShowRead.get(ssid) ?? null;
  lastShowRead.set(ssid, readAt);
  const show = useStore.getState().show!;
  const diffs = values.map((v) => diffShowTab(show, published, v));
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
    await noteSheetEdits(ssid, show, useStore.getState().show!, since);
  }
  noteConflicts(conflicts);
  if (review) {
    const since = lastRead.get(ssid) ?? null;
    lastRead.set(ssid, readAt);
    await pullReviews(ssid, published, review, since);
  }
}

/** The song tabs: the running order, and the archive if it has one. */
const songTabs = (archiveTabId: number | undefined) => (archiveTabId ? [SHOW_TAB, ARCHIVE_TAB] : [SHOW_TAB]);

/** The cells of each of `tabs`, in one read. */
async function tabValues(ssid: string, tabs: string[]): Promise<unknown[][][]> {
  const res = await api<{ valueRanges: { values?: unknown[][] }[] }>("GET",
    `${SHEETS}/${ssid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${tabs.map((t) => `ranges=${enc(a1(t))}`).join("&")}`);
  return res.valueRanges.map((r) => r.values ?? []);
}

/** The song tabs' cells (and the archive's, if it has one). */
const showTabValues = (ssid: string, archiveTabId: number | undefined) => tabValues(ssid, songTabs(archiveTabId));

/**
 * Edits typed in the Sheet that no app has brought into the show yet (`show` is the show as it is in Drive): the cells
 * a pull would take. Only reads. Used while edits made offline wait to be approved, when nothing pulls the Sheet.
 */
export async function unpulledSheetEdits(show: Show): Promise<Edit[]> {
  const { spreadsheet_id: ssid, tab_id, archive_tab_id, published } = show.google ?? {};
  if (!ssid || !tab_id || !published) return [];
  return (await showTabValues(ssid, archive_tab_id)).flatMap((v) => diffShowTab(show, published, v).edits);
}

const READ_MARGIN_MS = 30 * 1000; // the Mac's clock and Google's may differ a little
const FIRST_READ_MS = 24 * 60 * 60 * 1000; // how far back to look for who typed something the first time the app reads the Sheet

/** Who most likely typed new, unnamed comments in the Sheet since `since`, from its revision history (see sheetAuthor). */
async function sheetEditor(ssid: string, since: number | null): Promise<ReturnType<typeof sheetAuthor>> {
  const revisions: SheetRevision[] = [];
  const fields = enc("nextPageToken,revisions(modifiedTime,lastModifyingUser(displayName,emailAddress,me))");
  let page: string | undefined;
  do {
    const res = await api<{ revisions?: SheetRevision[]; nextPageToken?: string }>("GET",
      `${DRIVE}/${ssid}/revisions?pageSize=1000&fields=${fields}${page ? `&pageToken=${enc(page)}` : ""}`);
    revisions.push(...(res.revisions ?? []));
    page = res.nextPageToken;
  } while (page);
  return sheetAuthor(revisions, (since ?? Date.now() - FIRST_READ_MS) - READ_MARGIN_MS, g().app_editors ?? []);
}

/** Bring in collaborators' comments, replies, ticks and edits from the REVIEW tab. */
async function pullReviews(ssid: string, published: Record<string, string | boolean>, values: unknown[][], since: number | null): Promise<void> {
  const edits = diffReviewTab(useStore.getState().show!, published, values);
  if (!edits.length) return;
  step("Bringing in comments from the Sheet");
  // First mark the Sheet: rows typed there get their new comment's id and replies are taken out of REPLY, so a pull that
  // runs again (the push after this one failing, say) doesn't bring them in twice. Straight after the read, so the rows
  // are still where it found them.
  const ids = new Map(edits.flatMap((e) => (e.kind === "new" ? [[e.row, newId("rev")] as const] : [])));
  const replyCol = values[0]?.map(String).indexOf("reply") ?? -1;
  const rowOf = new Map(values.map((r, i) => [String(r?.[0] ?? ""), i]));
  const data = [
    ...[...ids].map(([row, id]) => ({ range: `${a1(REVIEW_TAB)}!A${row + 1}`, values: [[id]] })),
    ...(replyCol < 0 ? [] : edits.flatMap((e) => {
      const row = e.kind === "reply" ? rowOf.get(e.id) : undefined;
      return row === undefined ? [] : [{ range: `${a1(REVIEW_TAB)}!${colLetter(replyCol)}${row + 1}`, values: [[""]] }];
    })),
  ];
  if (data.length) await api("POST", `${SHEETS}/${ssid}/values:batchUpdate`, { valueInputOption: "RAW", data });
  // A comment or reply that doesn't say who it's from is put down to whoever edited the Sheet since it was last read.
  const unnamed = edits.some((e) => (e.kind === "new" && !e.from) || (e.kind === "reply" && e.from === REPLY_FROM));
  const author = unnamed ? await sheetEditor(ssid, since).catch(() => null) : null;
  const before = useStore.getState().show!;
  useStore.getState().update((s) => applyReviewEdits(s, edits, ids, author));
  meta((x) => { for (const e of edits) if (e.kind === "set") x.published = { ...x.published, [`review|${e.id}|${e.col}`]: e.value }; });
  await noteSheetEdits(ssid, before, useStore.getState().show!, since, author);
}

/**
 * Keep the Sheet edits that clashed with the app in the show, each with whose app edit it clashed with (`by`, an email,
 * when this Mac can tell): only they're asked to pick. Every Mac with the show open can find the same clash, as can one
 * that only got the app edit from Drive. Also claims the clashes no one could put down to anyone, that were made here.
 */
function noteConflicts(conflicts: Conflict[]) {
  const st = useStore.getState();
  const me = st.user?.email.toLowerCase();
  const current = (st.show?.conflicts ?? {}) as Record<string, { by?: string }>;
  const fresh = conflicts.filter((c) => !(`show|${c.songId}|${c.colId}` in current));
  const claimed = me ? Object.keys(current).filter((key) => !current[key].by && changedHere(key)) : [];
  if (!fresh.length && !claimed.length) return;
  const by = new Map(fresh.map((c) => [`show|${c.songId}|${c.colId}`, appAuthor(`show|${c.songId}|${c.colId}`, me)]));
  st.updateQuiet((s) => {
    s.conflicts = { ...(s.conflicts ?? {}) };
    for (const c of fresh) {
      const who = by.get(`show|${c.songId}|${c.colId}`);
      s.conflicts[`show|${c.songId}|${c.colId}`] = { sheet: c.sheet, app: c.app, published: c.published, ...(who ? { by: who } : {}) };
    }
    for (const key of claimed) s.conflicts[key] = { ...(s.conflicts[key] as object), by: me };
  });
  if (claimed.length || (me && [...by.values()].includes(me))) st.setClashesOpen(true);
}

/**
 * Whether the app's value of a Sheet cell ("show|<song>|<column>") was changed on this Mac: it differs somewhere in the
 * undo history, onto which other people's edits from Drive are replayed (so theirs never show up there).
 */
function changedHere(key: string): boolean {
  const [, songId, colId] = key.split("|");
  const { show, past } = useStore.getState();
  const col = show?.columns.find((c) => c.id === colId);
  const song = show?.songs[songId];
  if (!show || !col || !song) return false;
  const now = sheetValue(show, col, song);
  return past.some((p) => !p.songs[songId] || sheetValue(p, col, p.songs[songId]) !== now);
}

/** Who made the app's value of a Sheet cell, as an email: `me` if it was changed here, else whoever's save from Drive last changed that field. */
function appAuthor(key: string, me: string | undefined): string | undefined {
  if (changedHere(key)) return me;
  const [, songId, colId] = key.split("|");
  const { show, remoteEdits } = useStore.getState();
  const col = show?.columns.find((c) => c.id === colId);
  const edits = remoteEdits?.songs[songId];
  if (!col || !edits || !edits.keys.some((k) => k === colId || (k === "colours" && col.type === "colour"))) return undefined;
  const who = remoteEdits!.by.find((e) => editorKey(e) === edits.by[edits.by.length - 1]);
  return who && !who.via && who.email ? who.email.toLowerCase() : undefined;
}

/** Why this Mac isn't writing the Sheet yet: its locked columns aren't open to this account. */
export const LOCKED_OUT = "The Sheet's locked columns aren't open to you yet. They open the next time someone who can already edit them has the show open (their app adds you); until then their app keeps the Sheet up to date.";
let lockedOut = false;

/**
 * Put this account on the show's app editors. Whichever Mac syncs the show writes every column, so each person who may
 * end up syncing goes on the lock's editors (and stays there, so a collaborator's sync doesn't lock out whoever made the
 * show). Added on every Mac, syncing or not: the show reaches the syncing Mac through Drive, and if its account can edit
 * the lock it adds this one on its next push. It's put in as this account signs in (someone may have shared it as
 * @gmail.com when Google knows it as @googlemail.com).
 */
function joinAppEditors() {
  const me = useStore.getState().user?.email.toLowerCase();
  if (me && !(g().app_editors ?? []).some((e) => e.toLowerCase() === me)) meta((x) => { x.app_editors = [...(x.app_editors ?? []).filter((e) => emailKey(e) !== emailKey(me)), me]; });
}

async function pushSheet(): Promise<void> {
  const { user } = useStore.getState();
  const ssid = g().spreadsheet_id!;
  joinAppEditors();
  const show = useStore.getState().show!;
  const { images, missing } = await ensureImages([...show.set_order, ...show.archive], reviewStills(show));
  const urls = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.url]));
  step("Updating the Sheet");
  // The running order on SHOW SHEET, archived songs on ARCHIVED SONGS: a song moves between them as it's archived or restored.
  const grids: [TabGrid, number][] = [[showTab(show, urls, clipUrls()), TAB_ID], [showTab(show, urls, clipUrls(), true), ARCHIVE_TAB_ID]];
  // REVIEW is added once there's a comment to put in it.
  const reviewing = Boolean(g().review_tab_id || show.reviews?.length);
  if (reviewing) grids.push([reviewTab(show, urls, clipUrls()), REVIEW_TAB_ID]);
  const metaRes = await api<SheetMeta>("GET", `${SHEETS}/${ssid}?fields=${enc(`sheets(properties(sheetId,title,gridProperties(columnCount)),merges,conditionalFormats(booleanRule(condition(values))),${PROTECTED_FIELDS})`)}`);
  const tabs = new Map(metaRes.sheets.map((s) => [s.properties.sheetId, s]));
  const reqs: object[] = [];
  const columnsChanged = new Set<number>();
  // Snapshot the show that's pushed, not the current one: an edit made while the push is in flight isn't in the
  // Sheet, and recording it as published would make the next pull read the Sheet's old value as a collaborator's edit.
  const pushed = snapshot(show);
  const existing = grids.filter(([, id]) => tabs.has(id));
  const read = existing.length ? await api<{ valueRanges: { values?: unknown[][] }[] }>("GET",
    `${SHEETS}/${ssid}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&${existing.map(([, id]) => `ranges=${enc(a1(tabs.get(id)!.properties.title))}`).join("&")}`)
    : { valueRanges: [] };
  for (const [i, [grid, id]] of grids.entries()) {
    const tab = tabs.get(id);
    if (!tab) {
      reqs.push(...structureRequests(grid, id));
      if (id === TAB_ID && tabs.has(0)) reqs.push({ deleteSheet: { sheetId: 0 } }); // the default "Sheet1"
      continue;
    }
    const sheet = read.valueRanges[existing.findIndex(([, eid]) => eid === id)]?.values ?? [];
    if (tab.properties.title !== grid.title) reqs.push({ updateSheetProperties: { properties: { sheetId: id, title: grid.title }, fields: "title" } });
    const headerIds = (sheet[0] ?? []).map(String);
    if (headerIds.join("|") !== grid.colIds.join("|")) {
      columnsChanged.add(id);
      reqs.push(...columnChangeRequests(grid, id, tab.properties.gridProperties?.columnCount ?? headerIds.length));
    } else reqs.push(...mergeUpdateRequests(grid, id, tab.merges ?? []), ...spareColumnRequests(grid, id, tab.properties.gridProperties?.columnCount ?? headerIds.length));
    const rowIds = sheet.slice(HEADER_ROWS).map((r) => (r?.[0] === undefined ? "" : String(r[0])));
    reqs.push(...reconcileRequests(reconcileRows(rowIds, grid.rowIds), id));
    // The ✎ cells the app hasn't changed are written as the Sheet has them (see withSheetValues). Changed columns put
    // cells under other columns, so then the app's are written.
    if (!columnsChanged.has(id)) {
      const keep = keptCells(grid, id === REVIEW_TAB_ID ? "review" : "show", pushed, g().published ?? {}, new Set(rowIds.filter(Boolean)));
      grids[i] = [withSheetValues(grid, keep, sheet), id];
    }
  }
  for (const [grid, id] of grids) reqs.push(...contentRequests(grid, id), ...formatRuleRequests(grid, id, tabs.get(id)?.conditionalFormats ?? []));
  try {
    await api("POST", `${SHEETS}/${ssid}:batchUpdate`, { requests: reqs });
  } catch (e) {
    if (!/protected cell or object/i.test(String(e))) throw e;
    lockedOut = true; // not an error: tried again each push until the lock lets this account in
    return;
  }
  lockedOut = false;
  meta((x) => { x.tab_id = TAB_ID; x.archive_tab_id = ARCHIVE_TAB_ID; if (reviewing) x.review_tab_id = REVIEW_TAB_ID; x.published = pushed; });
  // An image made on a Mac that hasn't uploaded it yet: the next poll pushes again, when it may be there.
  lastSheet = missing ? null : sheetFingerprint(show);
  await lockTabs(ssid, grids, user?.email ?? "", columnsChanged, metaRes);
  await pruneImages();
}

let lockRefused: string | null = null; // why Google last refused the tabs' lock, said once rather than every push
const PROTECTED_FIELDS = "protectedRanges(protectedRangeId,warningOnly,range,unprotectedRanges,editors)";

/**
 * Lock all but the ✎ columns of each tab, when they aren't locked that way already. Sent on its own after the push, so a
 * lock Google refuses never stops the sync. The ranges are the ones `before` the push read, unless it changed columns
 * (a column deleted can change them): then they're read fresh. The locks cover whole columns, so moving rows doesn't.
 */
async function lockTabs(ssid: string, grids: [TabGrid, number][], me: string, columnsChanged: Set<number>, before: SheetMeta) {
  // One address per account, your own last so its spelling wins (Google lists the one it knows the account by).
  const byAccount = new Map<string, string>();
  for (const e of [...(g().app_editors ?? []), me].filter(Boolean)) byAccount.set(emailKey(e), e.toLowerCase());
  const editors = [...byAccount.values()];
  step("Locking the Sheet's columns");
  try {
    const res = columnsChanged.size ? await api<SheetMeta>("GET", `${SHEETS}/${ssid}?fields=${enc(`sheets(properties(sheetId),${PROTECTED_FIELDS})`)}`) : before;
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

let videoRefused: string | null = null; // why Slides last refused to embed the clips, said once rather than every push

async function pushDeck(): Promise<void> {
  const show = useStore.getState().show!;
  const pid = g().presentation_id!;
  status({ deck: "drawing" });
  const { images } = await ensureImages(show.set_order);
  step("Redrawing the deck");
  const pres = await api<{ slides?: { objectId: string; pageElements?: { objectId: string }[] }[] }>("GET", `${SLIDES}/${pid}?fields=${enc("slides(objectId,pageElements(objectId))")}`);
  const existing = Object.fromEntries((pres.slides ?? []).map((s) => [s.objectId, (s.pageElements ?? []).map((e) => e.objectId)]));
  const rev = (g().slides_rev ?? 0) + 1;
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const draw = (embed: boolean) => deckRequests(show, rev, Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.url])), existing, today, g().clips ?? {}, embed);
  const reqs = draw(true);
  // Slides copies an image in from a URL Google can fetch, so each one is link-public only while it's inserted.
  const ids = Object.values(images).map((i) => i.id);
  let linked = false;
  try {
    for (const id of ids) await api("POST", `${DRIVE}/${id}/permissions?${ALL}`, { type: "anyone", role: "reader", allowFileDiscovery: false });
    if (ids.length) await new Promise((r) => setTimeout(r, 2000));
    try {
      await api("POST", `${SLIDES}/${pid}:batchUpdate`, { requests: reqs });
      videoRefused = null;
    } catch (e) {
      // Slides refuses the whole batch if it can't embed one video (not finished processing on Drive, say): link the clips instead.
      if (!reqs.some((r) => "createVideo" in r) || clashed(e)) throw e;
      await api("POST", `${SLIDES}/${pid}:batchUpdate`, { requests: draw(false) });
      const why = String(e).replace(/^Error: /, "");
      if (why !== videoRefused) useStore.getState().toast(`The deck links its clips for now: Google Slides couldn't embed them (${why})`);
      videoRefused = why;
      linked = true;
    }
  } finally {
    for (const id of ids) await api("DELETE", `${DRIVE}/${id}/permissions/anyoneWithLink?${ALL}`).catch(() => {});
  }
  lastDeck = deckFingerprint(show);
  const hash = lastDeck;
  meta((x) => { x.slides_rev = rev; x.deck_hash = linked ? "" : hash; }); // linked clips: try the videos again next time the show opens
  status({ deck: "idle" });
}

// --- scheduling -------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve();
let lastSheet: string | null = null;
let lastDeck: string | null = null;
let generation = 0; // bumps when the open show changes, so stale jobs stop

function sheetFingerprint(show: Show): string {
  return JSON.stringify([show.name, show.columns, show.set_order, show.archive,
    Object.values(show.songs).map((s) => [s.id, s.fields, s.statuses, s.colours, s.hero, s.images, s.segues_into_next, s.clips]), show.google?.clips, show.reviews,
    (show.records ?? []).map((r) => [r.id, r.image_col, r.label]), // which clip column a record's clips are in, and what they're called
    show.google?.app_editors, // someone new using the show in the app: push, so the lock lets them in
    show.google?.slides_url]); // the banner links to the deck
}

let retryTimer: number | undefined; // set while waiting to try again after a failed sync
let failures = 0; // syncs failed in a row: each waits longer before trying again
let clashes = 0; // syncs in a row another Mac's push got in the way of
let leading = false; // this Mac holds the show's sync lease, so it's the one that syncs

/**
 * Google refusing a push because another Mac with the show open pushed the same change between this one reading the
 * Sheet or deck and writing to it: a conditional format or slide element that's gone, or one made twice. Only the Mac
 * holding the sync lease pushes, but two can meet while the lease changes hands, when someone presses Sync now, or
 * with an older app that pushes every save. Read again and it goes through.
 */
export const clashed = (e: unknown) => /Google 400: .*(No conditional format|could not be found|should be unique)/i.test(String(e));

/**
 * Run a sync job in turn, if this Mac syncs the show (or someone asked for it here: `force`). While a retry waits, only a
 * full sync (`syncNow`) runs: the retry does the rest.
 */
function run(job: () => Promise<void>, full = false, force = false) {
  const gen = generation;
  queue = queue.then(async () => {
    if (gen !== generation || !useStore.getState().show) return;
    if (!leading && !force) return;
    if (retryTimer !== undefined && !full) return;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    status({ state: "syncing", step: null, retryAt: null, by: null });
    try {
      await job();
      failures = 0;
      clashes = 0;
      if (gen === generation) status({ state: "ok", message: lockedOut ? LOCKED_OUT : null, lastSync: Date.now(), step: null });
    } catch (e) {
      if (gen !== generation) return;
      if (clashed(e) && clashes++ < MAX_CLASHES) {
        retryTimer = window.setTimeout(() => { if (gen === generation) syncNow(); }, CLASH_RETRY_MS * (1 + Math.random()));
        status({ state: "syncing", step: "Another Mac is syncing this show too, so trying again", deck: "idle", retryAt: null });
        return;
      }
      // One retry at a time, waiting longer each time: a retry for every failed job kept an account over Google's
      // per-minute quota, so it never came back.
      const quota = /Google 429/.test(String(e));
      const wait = Math.min((quota ? QUOTA_RETRY_MS : RETRY_MS) * 2 ** failures++, MAX_RETRY_MS);
      retryTimer = window.setTimeout(() => { if (gen === generation) syncNow(); }, wait);
      status({ state: "error", message: String(e).replace(/^Error: /, ""), deck: "idle", step: null, retryAt: Date.now() + wait });
    }
  });
}

/** Pull, then push the Sheet if anything changed (or always, with `force`, which also syncs from this Mac when another holds the lease). */
export function syncNow(force = false) {
  run(async () => {
    await ensureFiles();
    await resolveClips();
    await pull();
    const show = useStore.getState().show!;
    if (force || sheetFingerprint(show) !== lastSheet || !g().tab_id) await pushSheet();
    if (force || deckFingerprint(show) !== lastDeck) await pushDeck();
  }, true, force);
}

/**
 * Take or renew the show's sync lease, if no other Mac holds it: this Mac syncs while it holds it. One that takes it
 * over syncs straight away; one that doesn't says whose Mac does. The first time the lease can't be read (an older
 * Drive permission, say), this Mac syncs, as every Mac used to.
 */
async function checkLease(bundle: string, gen: number, first: boolean) {
  const user = useStore.getState().user;
  if (!user) return;
  let holder: Lease | null | "unknown";
  try {
    holder = await holdLease(folderIdOf(bundle), user.email, user.name, !lockedOut);
  } catch {
    if (!first) return; // couldn't look: carry on as before
    holder = "unknown";
  }
  if (gen !== generation) return;
  const was = leading;
  leading = holder === "unknown" || holder?.mac === THIS_MAC;
  if (leading && !was) return syncNow();
  if (leading || !holder || holder === "unknown") return; // nobody holds it (just let go): it's looked at again shortly
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  status({ state: "ok", message: `${holder.name}'s app is keeping the Sheet and deck up to date. This Mac takes over if they close the show.`, by: holder.name, step: null, retryAt: null, deck: "idle" });
}

/** Run the sync engine while a show is open (desktop app, signed in). */
export function useGoogleSync() {
  const bundle = useStore((s) => s.bundle);
  const user = useStore((s) => s.user);
  const readOnly = useStore((s) => s.readOnly);
  const connection = useStore((s) => s.connection);
  useEffect(() => {
    generation++;
    lastSheet = null;
    lockedOut = false;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    failures = 0;
    clashes = 0;
    leading = false;
    lastDeck = useStore.getState().show?.google?.deck_hash ?? null; // don't redraw an unchanged deck on open
    if (!bundle || !user) return status({ state: "off", message: null, by: null });
    if (readOnly) return status({ state: "off", message: "Read only", by: null });
    if (!backend.isDesktop) return status({ state: "off", message: "Google sync runs in the desktop app", by: null });
    if (connection === "offline") return status({ state: "off", message: "Offline", by: null });
    if (connection === "back") return status({ state: "off", message: "Waiting for your offline changes", by: null }); // the Sheet mustn't get them before they're approved
    const gen = generation;
    status({ state: "syncing", message: null, step: "Checking which Mac syncs the show", by: null, retryAt: null });
    joinAppEditors();
    checkLease(bundle, gen, true);
    const lease = window.setInterval(() => checkLease(bundle, gen, false), LEASE_EVERY_MS);
    const letGo = () => { if (leading) releaseLease(folderIdOf(bundle)).catch(() => {}); };
    window.addEventListener("beforeunload", letGo);
    let sheetTimer: number | undefined;
    let deckTimer: number | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      if (!s.show || s.show === prev.show || !leading) return;
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
      window.clearInterval(lease);
      window.removeEventListener("beforeunload", letGo);
      letGo();
      leading = false;
    };
  }, [bundle, user, readOnly, connection]);
}

// App state. Every edit goes through `update`, which clones the show, applies the change and
// records the previous version for undo. Saving is wired up in App (it watches `version`).
import { create } from "zustand";
import type { GoogleUser, ThumbCandidate } from "./backend";
import type { Show } from "./model/types";

export type View = "songs" | "media" | "comments" | "share" | "sheet" | "import" | "settings" | "prefs"; // settings = this show; prefs = the app
export type SaveState = "saved" | "saving" | "unsaved" | "error";
export type MediaTab = "add" | "inbox";
export type SongsLayout = "grid" | "list" | "present"; // present: one song at a time, full size

/** A clip being cut (or audio being linked) in the background after an import. */
export interface Job {
  id: string;
  label: string; // the song name
  recordId?: string; // the show record it's cutting from
  kind?: "clip" | "thumbnail"; // what it's making: cutting a clip, or lining up a song's thumbnail choices
  progress: number; // 0–1
  status: "queued" | "running" | "done" | "error";
  error?: string;
}

/** A song waiting for someone to pick its still from a record (Thumbnails only): the best few frames, as previews. */
export interface StillPick {
  id: string;
  songId: string;
  recordId: string;
  mark: { in: number; out: number };
  candidates: ThumbCandidate[]; // times are seconds into the record
  replaces?: string; // the still it takes the place of ("Pick best stills" again)
  current?: number; // the candidate the song uses meanwhile (its top frame, filed when lined up)
  auto?: boolean; // `replaces` is that top frame, not one someone chose
  saving?: boolean;
  finding?: boolean; // its frames are still being found (picking again from the Media page)
}

/** Pseudo song id for the show-level workspace (show records, show audio, watch folders). */
export const SHOW_ID = "__show";
const HISTORY_LIMIT = 200;

interface State {
  user: GoogleUser | null;
  authChecked: boolean;
  show: Show | null;
  bundle: string | null;
  readOnly: string | null; // why the open show can't be edited (it isn't in your Google Drive), or null
  others: { email: string; name: string }[]; // who else has the show open
  version: number; // bumps on every change; App saves when it moves
  past: Show[];
  future: Show[];
  saveState: SaveState;
  saveError: string | null;
  view: View;
  mediaTab: MediaTab;
  songsLayout: SongsLayout;
  selectedSongId: string | null; // the Sheet view's cursor
  selectedColId: string | null;
  drawerSongId: string | null; // song detail panel
  drawerFocus: string | null; // a field to focus when the panel opens
  importFiles: string[] | null; // files waiting for "What is this media?"
  importSource: { kind: "record" | "audio"; id: string } | null; // an existing record or show audio to split into songs
  importSeq: number; // bumps on every startImport so the import page starts fresh
  jobs: Job[];
  stillPicks: StillPick[];
  columnsOpen: boolean;
  toasts: { id: number; text: string }[];

  setUser(user: GoogleUser | null): void;
  load(show: Show, bundle: string, readOnly?: string | null): void;
  setOthers(others: { email: string; name: string }[]): void;
  close(): void;
  setBundle(path: string): void; // the show was moved
  update(fn: (show: Show) => void): void;
  /** Change bookkeeping (Google sync ids, what was pushed) without an undo step. */
  updateQuiet(fn: (show: Show) => void): void;
  undo(): void;
  redo(): void;
  select(songId: string | null, colId?: string | null): void;
  setView(view: View): void;
  setMediaTab(tab: MediaTab): void;
  setSongsLayout(layout: SongsLayout): void;
  /** Open a song's detail panel, optionally focusing a field (a column id or a section name). */
  focusSong(songId: string, field?: string): void;
  closeDrawer(): void;
  startImport(files: string[], source?: { kind: "record" | "audio"; id: string }): void;
  endImport(): void;
  /** Go to the import flow's last step: the thumbnails waiting to be picked, one song at a time. */
  openPicks(focus?: string): void;
  /** The pick to show first when the picker opens. */
  pickFocus: string | null;
  setJobs(fn: (jobs: Job[]) => Job[]): void;
  setStillPicks(fn: (picks: StillPick[]) => StillPick[]): void;
  setColumnsOpen(open: boolean): void;
  setSaveState(state: SaveState, error?: string | null): void;
  toast(text: string): void;
}

let toastId = 0;

export const useStore = create<State>((set, get) => ({
  user: null,
  authChecked: false,
  show: null,
  bundle: null,
  readOnly: null,
  others: [],
  version: 0,
  past: [],
  future: [],
  saveState: "saved",
  saveError: null,
  view: "songs",
  mediaTab: "add",
  songsLayout: "grid",
  selectedSongId: null,
  selectedColId: null,
  drawerSongId: null,
  drawerFocus: null,
  importFiles: null,
  importSource: null,
  importSeq: 0,
  jobs: [],
  stillPicks: [],
  pickFocus: null,
  columnsOpen: false,
  toasts: [],

  setUser(user) {
    set({ user, authChecked: true });
  },
  load(show, bundle, readOnly = null) {
    set({ show, bundle, readOnly, others: [], past: [], future: [], saveState: "saved", saveError: null, view: "songs", mediaTab: "add",
          selectedSongId: show.set_order[0] ?? null, selectedColId: "name", drawerSongId: null, importFiles: null, importSource: null, jobs: [], stillPicks: [] });
  },
  setBundle(bundle) {
    set({ bundle, readOnly: null });
  },
  setOthers(others) {
    set({ others });
  },
  close() {
    set({ show: null, bundle: null, readOnly: null, others: [], past: [], future: [], selectedSongId: null, drawerSongId: null, importFiles: null, stillPicks: [], view: "songs" });
  },
  update(fn) {
    const { show, past, version, readOnly } = get();
    if (!show) return;
    if (readOnly) return get().toast("Read only: move this show into Google Drive to edit it");
    const next = structuredClone(show);
    fn(next);
    set({ show: next, past: [...past.slice(-HISTORY_LIMIT + 1), show], future: [], version: version + 1, saveState: "unsaved" });
  },
  updateQuiet(fn) {
    const { show, version, readOnly } = get();
    if (!show || readOnly) return;
    const next = structuredClone(show);
    fn(next);
    set({ show: next, version: version + 1, saveState: "unsaved" });
  },
  // Undo and redo never roll back sync bookkeeping: the Sheet and deck still exist.
  undo() {
    const { show, past, future, version } = get();
    if (!show || past.length === 0) return;
    set({ show: { ...past[past.length - 1], google: show.google }, past: past.slice(0, -1), future: [show, ...future], version: version + 1, saveState: "unsaved" });
  },
  redo() {
    const { show, past, future, version } = get();
    if (!show || future.length === 0) return;
    set({ show: { ...future[0], google: show.google }, past: [...past, show], future: future.slice(1), version: version + 1, saveState: "unsaved" });
  },
  select(songId, colId) {
    set((s) => ({ selectedSongId: songId, selectedColId: colId === undefined ? s.selectedColId : colId }));
  },
  setView(view) {
    set({ view, drawerSongId: null });
  },
  setMediaTab(mediaTab) {
    set({ mediaTab });
  },
  setSongsLayout(songsLayout) {
    set({ songsLayout });
  },
  focusSong(songId, field) {
    set({ drawerSongId: songId, drawerFocus: field ?? null, selectedSongId: songId });
  },
  closeDrawer() {
    set({ drawerSongId: null, drawerFocus: null });
  },
  startImport(files, source) {
    set((s) => ({ importFiles: files, importSource: source ?? null, importSeq: s.importSeq + 1, view: "import", drawerSongId: null, pickFocus: null }));
  },
  endImport() {
    set({ importFiles: null, importSource: null });
  },
  openPicks(focus) {
    set((s) => ({ importFiles: null, importSource: null, importSeq: s.importSeq + 1, view: "import", drawerSongId: null, pickFocus: focus ?? null }));
  },
  setJobs(fn) {
    set((s) => ({ jobs: fn(s.jobs) }));
  },
  setStillPicks(fn) {
    set((s) => ({ stillPicks: fn(s.stillPicks) }));
  },
  setColumnsOpen(open) {
    set({ columnsOpen: open });
  },
  setSaveState(saveState, error = null) {
    set({ saveState, saveError: error });
  },
  toast(text) {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2600);
  },
}));

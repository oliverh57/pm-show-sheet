// App state. Every edit goes through `update`, which clones the show, applies the change and
// records the previous version for undo. Saving is wired up in App (it watches `version`).
import { create } from "zustand";
import type { Show } from "./model/types";

export type View = "songs" | "inbox" | "sheet";
export type SaveState = "saved" | "saving" | "unsaved" | "error";
export type MediaType = "show_record" | "song_record" | "show_audio" | "song_audio" | "renders" | "watch_folder";
export interface AddMediaPreset {
  type?: MediaType;
  songId?: string | null;
  files?: string[];
}

/** Pseudo song id for the show-level workspace (show records, show audio, watch folders). */
export const SHOW_ID = "__show";
const HISTORY_LIMIT = 200;

interface State {
  show: Show | null;
  bundle: string | null;
  version: number; // bumps on every change; App saves when it moves
  past: Show[];
  future: Show[];
  saveState: SaveState;
  saveError: string | null;
  view: View;
  selectedSongId: string | null;
  selectedColId: string | null;
  focusSection: { section: string; at: number } | null;
  addMedia: AddMediaPreset | null;
  columnsOpen: boolean;

  load(show: Show, bundle: string): void;
  close(): void;
  update(fn: (show: Show) => void): void;
  undo(): void;
  redo(): void;
  select(songId: string | null, colId?: string | null): void;
  setView(view: View): void;
  /** Open a song in the Songs view and scroll its workspace to a section. */
  focusSong(songId: string, section?: string): void;
  openAddMedia(preset?: AddMediaPreset): void;
  closeAddMedia(): void;
  setColumnsOpen(open: boolean): void;
  setSaveState(state: SaveState, error?: string | null): void;
}

export const useStore = create<State>((set, get) => ({
  show: null,
  bundle: null,
  version: 0,
  past: [],
  future: [],
  saveState: "saved",
  saveError: null,
  view: "songs",
  selectedSongId: null,
  selectedColId: null,
  focusSection: null,
  addMedia: null,
  columnsOpen: false,

  load(show, bundle) {
    set({ show, bundle, past: [], future: [], saveState: "saved", saveError: null, view: "songs",
          selectedSongId: show.set_order[0] ?? SHOW_ID, selectedColId: "name" });
  },
  close() {
    set({ show: null, bundle: null, past: [], future: [], selectedSongId: null, addMedia: null });
  },
  update(fn) {
    const { show, past, version } = get();
    if (!show) return;
    const next = structuredClone(show);
    fn(next);
    set({ show: next, past: [...past.slice(-HISTORY_LIMIT + 1), show], future: [], version: version + 1, saveState: "unsaved" });
  },
  undo() {
    const { show, past, future, version } = get();
    if (!show || past.length === 0) return;
    set({ show: past[past.length - 1], past: past.slice(0, -1), future: [show, ...future], version: version + 1, saveState: "unsaved" });
  },
  redo() {
    const { show, past, future, version } = get();
    if (!show || future.length === 0) return;
    set({ show: future[0], past: [...past, show], future: future.slice(1), version: version + 1, saveState: "unsaved" });
  },
  select(songId, colId) {
    set((s) => ({ selectedSongId: songId, selectedColId: colId === undefined ? s.selectedColId : colId }));
  },
  setView(view) {
    set({ view });
  },
  focusSong(songId, section) {
    set({ view: "songs", selectedSongId: songId, focusSection: section ? { section, at: Date.now() } : null });
  },
  openAddMedia(preset = {}) {
    set({ addMedia: preset });
  },
  closeAddMedia() {
    set({ addMedia: null });
  },
  setColumnsOpen(open) {
    set({ columnsOpen: open });
  },
  setSaveState(saveState, error = null) {
    set({ saveState, saveError: error });
  },
}));

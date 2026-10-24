// Render folders (Depence export folders feeding the render inbox) are this Mac only: their paths only
// make sense here, so they're kept in this Mac's app storage per show, not in the shared show file.
import { useEffect } from "react";
import { create } from "zustand";
import { backend } from "./backend";
import { fileName, newId } from "./model/ops";
import type { WatchFolder } from "./model/types";
import { useStore } from "./store";

const KEY = "pm.watchFolders";

function load(): Record<string, WatchFolder[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, WatchFolder[]>;
  } catch {
    return {};
  }
}

const useLocal = create<{ byShow: Record<string, WatchFolder[]> }>(() => ({ byShow: load() }));

function save(showId: string, folders: WatchFolder[]) {
  const byShow = { ...useLocal.getState().byShow, [showId]: folders };
  useLocal.setState({ byShow });
  try { localStorage.setItem(KEY, JSON.stringify(byShow)); } catch { /* storage unavailable */ }
}

const EMPTY: WatchFolder[] = [];

/** The open show's render folders on this Mac. */
export function useWatchFolders(): WatchFolder[] {
  const showId = useStore((s) => s.show?.id);
  return useLocal((s) => (showId ? s.byShow[showId] : undefined) ?? EMPTY);
}

export function watchFolders(): WatchFolder[] {
  const showId = useStore.getState().show?.id;
  return (showId && useLocal.getState().byShow[showId]) || EMPTY;
}

/** Watch a folder, with the song and category its renders are for (a folder already watched takes the new ones). */
export function linkWatchFolder(path: string, opts: Pick<WatchFolder, "song_id" | "image_col"> = {}) {
  const showId = useStore.getState().show?.id;
  if (!showId) return;
  const current = watchFolders();
  if (current.some((w) => w.path === path)) return save(showId, current.map((w) => (w.path === path ? { ...w, ...opts } : w)));
  save(showId, [...current, { id: newId("wf"), path, label: fileName(path), added_at: new Date().toISOString(), ...opts }]);
}

export function unlinkWatchFolder(id: string) {
  const showId = useStore.getState().show?.id;
  if (showId) save(showId, watchFolders().filter((w) => w.id !== id));
}

/**
 * Shows from before render folders were per Mac kept them in the show file. Take the ones that exist on
 * this Mac, and take them all out of the show file.
 */
export function useAdoptWatchFolders() {
  const show = useStore((s) => s.show);
  const readOnly = useStore((s) => s.readOnly);
  const legacy = show?.watch_folders;
  useEffect(() => {
    if (!legacy?.length || readOnly) return;
    (async () => {
      for (const f of legacy) {
        const here = await backend.listFolder(f.path, []).then(() => true, () => false);
        if (here) linkWatchFolder(f.path);
      }
      useStore.getState().updateQuiet((s) => { delete s.watch_folders; });
    })();
  }, [legacy, readOnly]);
}

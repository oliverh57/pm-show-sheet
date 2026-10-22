import { useEffect, useRef, useState } from "react";
import "@fontsource/lexend/400.css";
import "@fontsource/lexend/600.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto-mono/400.css";
import "./App.css";
import logo from "./assets/logo.png";
import { backend, IMAGE_EXTENSIONS, sampleShow } from "./backend";
import { AddMediaDialog, guessType } from "./components/AddMediaDialog";
import { ColumnsDialog } from "./components/ColumnsDialog";
import { DraftInput } from "./components/fields";
import { Grid } from "./components/Grid";
import { RenderInbox } from "./components/RenderInbox";
import { SongCards } from "./components/SongCards";
import { SongWorkspace } from "./components/SongWorkspace";
import { UpdateBar, VersionLine } from "./components/UpdateBar";
import { addImages, addWatchFolder, extension, newId, newShow } from "./model/ops";
import type { Show } from "./model/types";
import { SHOW_ID, useStore, type View } from "./store";
import { useAutoUpdate, useUpdates } from "./updates";

const LAST_BUNDLE_KEY = "pm.lastBundle";
const SAVE_DELAY_MS = 600;

function rememberBundle(path: string) {
  try { localStorage.setItem(LAST_BUNDLE_KEY, path); } catch { /* storage unavailable */ }
}
function lastBundle(): string | null {
  try { return localStorage.getItem(LAST_BUNDLE_KEY); } catch { return null; }
}
function baseName(path: string) {
  return path.split("/").pop() ?? path;
}

export default function App() {
  const show = useStore((s) => s.show);
  const view = useStore((s) => s.view);
  const columnsOpen = useStore((s) => s.columnsOpen);
  const addMedia = useStore((s) => s.addMedia);
  useAutosave();
  useShortcuts();
  useFileDrop();
  useAutoUpdate();

  if (!show) return <><UpdateBar /><Welcome /></>;
  return (
    <div className="app">
      <UpdateBar />
      <Toolbar />
      {view === "songs" && (
        <main className="songs-view">
          <SongCards />
          <SongWorkspace />
        </main>
      )}
      {view === "inbox" && <RenderInbox />}
      {view === "sheet" && <main className="sheet-view"><Grid /></main>}
      {columnsOpen && <ColumnsDialog />}
      {addMedia && <AddMediaDialog />}
    </div>
  );
}

function useAutosave() {
  const version = useStore((s) => s.version);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (version === 0) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(saveNow, SAVE_DELAY_MS);
  }, [version]);
}

async function saveNow() {
  const { show, bundle, setSaveState } = useStore.getState();
  if (!show || !bundle) return;
  setSaveState("saving");
  try {
    await backend.save(bundle, show);
    // Only mark saved if nothing changed while we were writing.
    if (useStore.getState().show === show) setSaveState("saved");
  } catch (e) {
    setSaveState("error", String(e));
  }
}

const VIEW_KEYS: Record<string, View> = { "1": "songs", "2": "inbox", "3": "sheet" };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const { undo, redo, setView, openAddMedia, show } = useStore.getState();
      if (!show) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !inField) (e.shiftKey ? redo : undo)();
      else if (key === "s") saveNow();
      else if (key === "i") openAddMedia();
      else if (VIEW_KEYS[key]) setView(VIEW_KEYS[key]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Files dropped from Finder. Images dropped on a song are added to it straight away; folders
 * dropped on the render inbox become watch folders; everything else opens Add media pre-filled.
 */
function useFileDrop() {
  useEffect(() => backend.onFileDrop(async (paths, x, y) => {
    const { bundle, view, selectedSongId, update, focusSong, openAddMedia, addMedia } = useStore.getState();
    if (!bundle || paths.length === 0) return;
    if (addMedia) return openAddMedia({ ...addMedia, files: [...(addMedia.files ?? []), ...paths] });
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-song-id]");
    const songId = target?.dataset.songId ?? null;
    const allImages = paths.every((p) => IMAGE_EXTENSIONS.includes(extension(p)));
    if (songId && allImages) {
      const rels = await Promise.all(paths.map((p) => backend.importMedia(bundle, p, "renders")));
      update((s) => addImages(s, songId, rels));
      return focusSong(songId, "renders");
    }
    const type = guessType(paths, Boolean(songId));
    if (view === "inbox" && type === "watch_folder") return update((s) => { for (const p of paths) addWatchFolder(s, p); });
    openAddMedia({ type, songId: songId ?? (selectedSongId !== SHOW_ID ? selectedSongId : null), files: paths });
  }), []);
}

function Toolbar() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const view = useStore((s) => s.view);
  const saveState = useStore((s) => s.saveState);
  const saveError = useStore((s) => s.saveError);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const { update, undo, redo, setColumnsOpen, setView, openAddMedia, close } = useStore.getState();
  const appVersion = useUpdates((s) => s.current);

  return (
    <header className="toolbar">
      <img src={logo} className="logo" alt="PIXELMAPPERS" />
      {appVersion && <span className="app-version">v{appVersion}</span>}
      <DraftInput className="show-name" value={show.name} onCommit={(v) => update((s) => { s.name = v.toUpperCase(); })} />
      <span className={`save save-${saveState}`} title={saveError ?? bundle}>
        {{ saved: "Saved", saving: "Saving…", unsaved: "Unsaved", error: "Save failed" }[saveState]}
      </span>
      <div className="spacer" />
      <nav className="views">
        {([["songs", "Songs"], ["inbox", "Render inbox"], ["sheet", "Sheet"]] as [View, string][]).map(([id, label], i) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)} title={`⌘${i + 1}`}>{label}</button>
        ))}
      </nav>
      <button className="primary add-media-btn" onClick={() => openAddMedia()} title="⌘I">+ Add media</button>
      <div className="spacer" />
      <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">Undo</button>
      <button onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">Redo</button>
      <button onClick={() => setColumnsOpen(true)}>Columns</button>
      <button onClick={async () => { await saveNow(); close(); }} title={bundle}>Close</button>
    </header>
  );
}

function Welcome() {
  const load = useStore((s) => s.load);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const last = backend.isDesktop ? lastBundle() : null; // browser preview shows don't outlive the page

  async function run(fn: () => Promise<void>) {
    setError(null);
    try { await fn(); } catch (e) { setError(String(e)); }
  }

  async function createFrom(show: Show, fileName: string) {
    const path = await backend.chooseNewBundle(fileName);
    if (!path) return;
    await backend.create(path, show);
    rememberBundle(path);
    load(show, path);
  }

  async function openPath(path: string) {
    const show = await backend.open(path);
    rememberBundle(path);
    load(show, path);
  }

  return (
    <div className="welcome">
      <img src={logo} className="welcome-logo" alt="PIXELMAPPERS" />
      <h1>SHOW SHEET</h1>
      <div className="welcome-card">
        <label className="field">
          <span className="field-label">NEW SHOW</span>
          <input autoFocus placeholder="e.g. ARTIST | VENUE 2026" value={name} onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && name.trim() && run(() => createFrom(newShow(name.trim()), name.trim()))} />
        </label>
        <button className="primary" disabled={!name.trim()} onClick={() => run(() => createFrom(newShow(name.trim()), name.trim()))}>
          Create show…
        </button>
        <div className="welcome-actions">
          <button onClick={() => run(async () => { const p = await backend.chooseBundle(); if (p) await openPath(p); })}>Open show…</button>
          {last && <button onClick={() => run(() => openPath(last))} title={last}>Reopen {baseName(last)}</button>}
          <button onClick={() => run(() => createFrom({ ...structuredClone(sampleShow), id: newId("show") }, "Sample show"))}>
            Try the sample show…
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {!backend.isDesktop && <p className="muted small">Browser preview: shows live in memory only. Run the desktop app to save bundles.</p>}
      </div>
      <VersionLine />
    </div>
  );
}

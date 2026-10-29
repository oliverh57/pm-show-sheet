import { useEffect, useRef, useState } from "react";
import "@fontsource/lexend/400.css";
import "@fontsource/lexend/600.css";
import "@fontsource/roboto-mono/400.css";
import "./App.css";
import { backend, IMAGE_EXTENSIONS } from "./backend";
import { AppSettings, HomeSettings } from "./components/AppSettings";
import { ColumnsDialog } from "./components/ColumnsDialog";
import { ToolsSetup, useToolsCheck } from "./components/ToolsSetup";
import { Home } from "./components/Home";
import { ImportPage } from "./components/ImportPage";
import { MediaPage } from "./components/MediaPage";
import { CommentsPage } from "./components/Comments";
import { SettingsPage, SharePage, SheetPage } from "./components/OtherPages";
import { ClashBanner, OfflineBanner, ReadOnlyBanner, Sidebar, Toasts } from "./components/Shell";
import { RemoteEditsNotice } from "./components/RemoteEdits";
import { SignIn } from "./components/SignIn";
import { SongDrawer } from "./components/SongDrawer";
import { SongsPage } from "./components/SongsPage";
import { UpdateBar, WhatsNew } from "./components/UpdateBar";
import { TransferProgress } from "./components/TransferProgress";
import { addImages, deptCategory, ensureCategory, extension, keepResolvedDays, resolvedToTidy, tidyResolved } from "./model/ops";
import { useAdoptWatchFolders } from "./watchFolders";
import { useStore, type View } from "./store";
import { useAutoUpdate } from "./updates";
import { applyCacheLimit } from "./storage";
import { watchDownloads } from "./drive/media";
import { useGoogleSync } from "./google/sync";
import { goOffline, isOffline, pushShow, useDriveLive } from "./drive/live";
import { holdEdits } from "./drive/show";

const SAVE_DELAY_MS = 600;

export default function App() {
  const user = useStore((s) => s.user);
  const authChecked = useStore((s) => s.authChecked);
  const show = useStore((s) => s.show);
  const view = useStore((s) => s.view);
  const columnsOpen = useStore((s) => s.columnsOpen);
  const drawerSongId = useStore((s) => s.drawerSongId);
  const importSeq = useStore((s) => s.importSeq);
  const dragging = useFileDrop();
  const [toolsReady, skipTools] = useToolsCheck(Boolean(user));
  useAuthCheck();
  useAutosave();
  useShortcuts();
  useAutoUpdate();
  useGoogleSync();
  useDriveLive();
  useAdoptWatchFolders();
  useTidyResolved();
  useEffect(() => { applyCacheLimit().catch(() => {}); }, []);
  useEffect(() => watchDownloads(), []);

  if (!authChecked) return null;
  if (!user) return <div className="app"><UpdateBar /><WhatsNew /><SignIn /></div>;
  if (!show && toolsReady === null) return null;
  if (!show && !toolsReady) return <div className="app"><UpdateBar /><WhatsNew /><ToolsSetup onDone={skipTools} /></div>;
  if (!show) return <div className="app"><UpdateBar /><WhatsNew />{view === "prefs" ? <HomeSettings /> : <Home />}<TransferProgress /><Toasts /></div>;

  const page = { songs: <SongsPage />, media: <MediaPage />, comments: <CommentsPage />, import: <ImportPage key={importSeq} />, share: <SharePage />, sheet: <SheetPage />, settings: <SettingsPage />, prefs: <AppSettings /> }[view];
  return (
    <div className="app">
      <UpdateBar />
      <WhatsNew />
      <div className="shell">
        <Sidebar onClose={closeShow} />
        <section className="main">
          <ReadOnlyBanner />
          <OfflineBanner />
          <ClashBanner />
          <div className="main-scroll" id="main-scroll">{page}</div>
        </section>
      </div>
      {drawerSongId && show.songs[drawerSongId] && <SongDrawer key={drawerSongId} />}
      {columnsOpen && <ColumnsDialog />}
      {dragging && <div className="drop-overlay">Drop to add media</div>}
      <RemoteEditsNotice />
      <TransferProgress />
      <Toasts />
    </div>
  );
}

const TIDY_EVERY_MS = 60 * 60 * 1000;

/** Delete resolved comments older than the show keeps them: when it opens, when the setting changes, and hourly. */
function useTidyResolved() {
  const showId = useStore((s) => s.show?.id);
  const keep = useStore((s) => (s.show ? keepResolvedDays(s.show) : null));
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    if (!showId || readOnly) return;
    const tidy = () => {
      const { show, updateQuiet, toast } = useStore.getState();
      if (!show) return;
      const { expired, unstamped } = resolvedToTidy(show);
      if (!expired.length && !unstamped) return;
      updateQuiet((s) => { tidyResolved(s); });
      const days = keepResolvedDays(show);
      if (expired.length) toast(`Deleted ${expired.length} comment${expired.length === 1 ? "" : "s"} resolved over ${days} day${days === 1 ? "" : "s"} ago`);
    };
    tidy();
    const t = window.setInterval(tidy, TIDY_EVERY_MS);
    return () => window.clearInterval(t);
  }, [showId, keep, readOnly]);
}

async function closeShow() {
  await saveNow();
  useStore.getState().close();
}

function useAuthCheck() {
  useEffect(() => {
    backend.currentUser().then((u) => useStore.getState().setUser(u), () => useStore.getState().setUser(null));
  }, []);
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

/**
 * Save the show on this Mac (so nothing's lost offline), then upload it to Google Drive, merging anyone else's save.
 * Offline, the save stays on this Mac, held until it's approved once Drive is back.
 */
async function saveNow() {
  const { show, bundle, setSaveState, readOnly, connection } = useStore.getState();
  if (!show || !bundle || readOnly || useStore.getState().saveState === "saved") return;
  const offline = backend.isDesktop && connection !== "online";
  setSaveState("saving");
  try {
    await backend.save(bundle, show);
    if (offline) await holdEdits(bundle);
    else if (backend.isDesktop) await pushShow(bundle, show);
    // An edit while saving made it "unsaved" again, and saves again in a moment.
    if (useStore.getState().saveState === "saving") setSaveState(offline ? "offline" : "saved");
  } catch (e) {
    if (isOffline(e)) {
      await holdEdits(bundle).catch(() => {});
      goOffline();
    }
    if (useStore.getState().saveState === "saving") setSaveState(isOffline(e) ? "offline" : "error", isOffline(e) ? null : String(e));
  }
}

const VIEW_KEYS: Record<string, View> = { "1": "songs", "2": "media", "3": "share", "4": "sheet" };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { undo, redo, setView, show, drawerSongId, closeDrawer } = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key === ",") { e.preventDefault(); return setView("prefs"); }
      if (!show) return;
      if (e.key === "Escape" && drawerSongId && !document.querySelector(".modal-backdrop")) return closeDrawer();
      if (!(e.metaKey || e.ctrlKey)) return;
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const key = e.key.toLowerCase();
      if (key === "z" && !inField) (e.shiftKey ? redo : undo)();
      else if (key === "s") saveNow();
      else if (key === "i") { setView("media"); useStore.getState().setMediaTab("add"); }
      else if (VIEW_KEYS[key]) setView(VIEW_KEYS[key]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Files dropped from Finder. Images dropped on a song card go straight onto that song; folders dropped
 * on the render inbox become watch folders; everything else goes to "What is this media?".
 */
function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => backend.onFileDrop(async (paths, x, y) => {
    const { bundle, update, focusSong, startImport, toast } = useStore.getState();
    if (!bundle || paths.length === 0) return;
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-song-id]");
    const songId = target?.dataset.songId ?? null;
    const allImages = paths.every((p) => IMAGE_EXTENSIONS.includes(extension(p)));
    if (songId && allImages) {
      const rels = await Promise.all(paths.map((p) => backend.importMedia(bundle, p, "renders")));
      update((s) => addImages(s, songId, rels, ensureCategory(s, deptCategory("CONTENT"))));
      toast(`Added ${rels.length} image${rels.length === 1 ? "" : "s"}`);
      return focusSong(songId, "media");
    }
    startImport(paths); // folders dropped on the inbox too: they're asked their song and category
  }, (over) => setDragging(over && Boolean(useStore.getState().show))), []);
  return dragging;
}

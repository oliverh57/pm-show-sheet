// Everything that touches the file system goes through here. In the desktop app it calls the
// Rust commands in src-tauri/src/lib.rs; in a plain browser (vite dev preview) it keeps bundles in
// memory so the UI can still be worked on.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { InboxState, MediaInfo, Show } from "./model/types";
import sample from "./model/sample_show.json";

export type MediaKind = "renders" | "grabs" | "clips" | "layout" | "inspo";
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "tif", "tiff", "webp", "gif", "heic"];

export interface FolderFile {
  path: string;
  name: string;
  size: number;
  modified_ms: number;
}

export type FileKind = "video" | "audio" | "image";
const FILTERS: Record<FileKind, { name: string; extensions: string[] }> = {
  video: { name: "Video", extensions: ["mp4", "mov", "m4v", "mxf", "avi", "mkv"] },
  audio: { name: "Audio", extensions: ["wav", "aif", "aiff", "mp3", "m4a", "flac", "aac"] },
  image: { name: "Images", extensions: IMAGE_EXTENSIONS },
};

export interface Backend {
  isDesktop: boolean;
  chooseNewBundle(defaultName: string): Promise<string | null>;
  chooseBundle(): Promise<string | null>;
  chooseImages(): Promise<string[]>;
  chooseFiles(kind: FileKind, multiple: boolean): Promise<string[]>;
  chooseFolder(title: string): Promise<string | null>;
  listFolder(folder: string, extensions: string[]): Promise<FolderFile[]>;
  probe(path: string): Promise<MediaInfo>;
  readInbox(bundle: string): Promise<InboxState>;
  writeInbox(bundle: string, inbox: InboxState): Promise<void>;
  /** URL the webview can load for any file on disk (images, video, audio). */
  fileUrl(path: string): string;
  create(path: string, show: Show): Promise<void>;
  open(path: string): Promise<Show>;
  save(path: string, show: Show): Promise<void>;
  importMedia(bundle: string, source: string, kind: MediaKind): Promise<string>;
  mediaUrl(bundle: string, relative: string): string;
  confirm(message: string): Promise<boolean>;
  /** Files dropped from Finder, with the drop point in CSS pixels. Returns an unsubscribe function. */
  onFileDrop(cb: (paths: string[], x: number, y: number) => void): () => void;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function withExtension(path: string): string {
  return path.endsWith(".showsheet") ? path : `${path}.showsheet`;
}

const desktop: Backend = {
  isDesktop: true,
  async chooseNewBundle(defaultName) {
    const path = await saveDialog({ title: "Create show", defaultPath: `${defaultName}.showsheet` });
    return path ? withExtension(path) : null;
  },
  async chooseBundle() {
    const path = await openDialog({ title: "Open a .showsheet show", directory: true, multiple: false });
    return typeof path === "string" ? path : null;
  },
  async chooseImages() {
    const paths = await openDialog({ title: "Add images", multiple: true, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    return Array.isArray(paths) ? paths : paths ? [paths] : [];
  },
  async chooseFiles(kind, multiple) {
    const paths = await openDialog({ title: `Choose ${FILTERS[kind].name.toLowerCase()}`, multiple, filters: [FILTERS[kind]] });
    return Array.isArray(paths) ? paths : paths ? [paths] : [];
  },
  async chooseFolder(title) {
    const path = await openDialog({ title, directory: true, multiple: false });
    return typeof path === "string" ? path : null;
  },
  async listFolder(folder, extensions) {
    return (await invoke("list_folder", { folder, extensions })) as FolderFile[];
  },
  async probe(path) {
    try {
      return (await invoke("probe_media", { path })) as MediaInfo;
    } catch {
      return { available: false };
    }
  },
  async readInbox(bundle) {
    return ((await invoke("side_read", { bundle, name: "inbox.json" })) as InboxState | null) ?? {};
  },
  async writeInbox(bundle, inbox) {
    await invoke("side_write", { bundle, name: "inbox.json", value: inbox });
  },
  fileUrl(path) {
    return convertFileSrc(path);
  },
  async create(path, show) {
    await invoke("bundle_create", { path, project: show });
  },
  async open(path) {
    return (await invoke("bundle_open", { path })) as Show;
  },
  async save(path, show) {
    await invoke("bundle_save", { path, project: show });
  },
  async importMedia(bundle, source, kind) {
    return (await invoke("media_import", { bundle, source, kind })) as string;
  },
  mediaUrl(bundle, relative) {
    return convertFileSrc(`${bundle}/${relative}`);
  },
  async confirm(message) {
    return ask(message, { title: "PM Show Sheet", kind: "warning" });
  },
  onFileDrop(cb) {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const ratio = window.devicePixelRatio || 1;
          cb(event.payload.paths, event.payload.position.x / ratio, event.payload.position.y / ratio);
        }
      })
      .then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

const memory = new Map<string, Show>();
// In `npm run dev` the Vite server can list and serve files inside the project folder (see vite.config.ts),
// so the browser preview can exercise records, audio and the render inbox with the example content.
const DEV = import.meta.env.DEV;
const askPath = (title: string) => (DEV ? window.prompt(`${title}\n(browser preview: paste an absolute path inside the project folder)`) : null);
const browser: Backend = {
  isDesktop: false,
  async chooseNewBundle(defaultName) {
    return `/preview/${defaultName}.showsheet`;
  },
  async chooseBundle() {
    const path = "/preview/Sample.showsheet";
    if (!memory.has(path)) memory.set(path, structuredClone(sample) as Show);
    return path;
  },
  async chooseImages() {
    const p = askPath("Image path");
    return p ? [p] : [];
  },
  async chooseFiles() {
    const p = askPath("File path");
    return p ? [p] : [];
  },
  async chooseFolder(title) {
    return askPath(title);
  },
  async listFolder(folder, extensions) {
    if (!DEV) return [];
    const res = await fetch(`/__pm/list?folder=${encodeURIComponent(folder)}&ext=${extensions.join(",")}`);
    return res.ok ? res.json() : [];
  },
  async probe(path) {
    if (!DEV) return { available: false };
    const res = await fetch(`/__pm/probe?path=${encodeURIComponent(path)}`);
    return res.ok ? res.json() : { available: false };
  },
  async readInbox(bundle) {
    try { return JSON.parse(sessionStorage.getItem(`inbox:${bundle}`) ?? "{}"); } catch { return {}; }
  },
  async writeInbox(bundle, inbox) {
    try { sessionStorage.setItem(`inbox:${bundle}`, JSON.stringify(inbox)); } catch { /* preview only */ }
  },
  fileUrl(path) {
    return DEV ? `/@fs${encodeURI(path)}` : "";
  },
  async create(path, show) {
    memory.set(path, structuredClone(show));
  },
  async open(path) {
    const show = memory.get(path);
    if (!show) throw new Error(`No show at ${path}`);
    return structuredClone(show);
  },
  async save(path, show) {
    memory.set(path, structuredClone(show));
  },
  async importMedia(_bundle, source) {
    return source; // preview doesn't copy: the absolute path is used in place
  },
  mediaUrl(_bundle, relative) {
    return relative.startsWith("/") ? browser.fileUrl(relative) : "";
  },
  async confirm(message) {
    return window.confirm(message);
  },
  onFileDrop() {
    return () => {};
  },
};

export const backend: Backend = isTauri ? desktop : browser;
export const sampleShow = sample as Show;

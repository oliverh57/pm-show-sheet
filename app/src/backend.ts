// Everything that touches the file system goes through here. In the desktop app it calls the
// Rust commands in src-tauri/src/lib.rs; in a plain browser (vite dev preview) it keeps bundles in
// memory so the UI can still be worked on.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { downloadDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { showCover } from "./model/ops";
import type { CropRect, InboxState, LtcResult, MediaInfo, Show, TcBlock } from "./model/types";
import sample from "./model/sample_show.json";

export type MediaKind = "renders" | "grabs" | "clips" | "layout" | "inspo";
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "tif", "tiff", "webp", "gif", "heic"];

export interface FolderFile {
  path: string;
  name: string;
  size: number;
  modified_ms: number;
}


export interface ToolsStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
}

export interface ToolsProgress {
  phase: "download" | "install"; // install: unpacking and checking they run
  received: number; // bytes
  total: number;
}

export interface GoogleUser {
  name: string;
  email: string;
  picture?: string | null;
}

/** A show bundle as listed on the All shows page. */
export interface ShowSummary {
  path: string;
  name: string;
  venue?: string | null;
  date?: string | null;
  songs: number;
  cover?: string | null; // absolute path of the show's main image (else the first song's hero render)
  modified_ms: number;
  where?: string; // where it is in Google Drive: "My Drive", "Shared drives / X", "Shared with you by Sam"
  canEdit?: boolean;
}

/** A file's metadata from the Drive API (whichever fields were asked for). */
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  parents?: string[];
  properties?: Record<string, string>;
  capabilities?: { canEdit?: boolean; canAddChildren?: boolean };
  driveId?: string;
  ownedByMe?: boolean;
  sharingUser?: { displayName?: string; emailAddress?: string };
  owners?: { displayName?: string; emailAddress?: string }[];
  lastModifyingUser?: DriveUser;
}

/** Someone, as the Drive API names them. `me` is the signed-in user. */
export interface DriveUser { displayName?: string; emailAddress?: string; me?: boolean }

/** JSON files kept beside a show's project.json on this Mac: the render inbox, and the Drive copy's manifest and base. */
export type SideFile = "inbox.json" | ".drive.json" | "base.json" | ".remote.json";

export type FileKind = "video" | "audio" | "image";
export interface ThumbCandidate { time: number; path: string; score: number }
const FILTERS: Record<FileKind, { name: string; extensions: string[] }> = {
  video: { name: "Video", extensions: ["mp4", "mov", "m4v", "mxf", "avi", "mkv"] },
  audio: { name: "Audio", extensions: ["wav", "aif", "aiff", "mp3", "m4a", "flac", "aac"] },
  image: { name: "Images", extensions: IMAGE_EXTENSIONS },
};

export interface Backend {
  isDesktop: boolean;
  chooseImages(): Promise<string[]>;
  chooseFiles(kind: FileKind, multiple: boolean): Promise<string[]>;
  chooseMedia(): Promise<string[]>; // any video, audio or image files
  chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
  listFolder(folder: string, extensions: string[]): Promise<FolderFile[]>;
  probe(path: string): Promise<MediaInfo>;
  readInbox(bundle: string): Promise<InboxState>;
  writeInbox(bundle: string, inbox: InboxState): Promise<void>;
  /** URL the webview can load for any file on disk (images, video, audio). */
  fileUrl(path: string): string;
  /** URL a <video> or <audio> plays a file on disk from: any size, seekable (see src-tauri/src/stream.rs). */
  streamUrl(path: string): string;
  create(path: string, show: Show): Promise<void>;
  open(path: string): Promise<Show>;
  save(path: string, show: Show): Promise<void>;
  importMedia(bundle: string, source: string, kind: MediaKind): Promise<string>;
  mediaUrl(bundle: string, relative: string): string;
  confirm(message: string): Promise<boolean>;
  /** Files dropped from Finder, with the drop point in CSS pixels; `onHover` says when files are over the window. Returns an unsubscribe function. */
  onFileDrop(cb: (paths: string[], x: number, y: number) => void, onHover?: (over: boolean) => void): () => void;

  // Google sign-in (see src-tauri/src/google.rs)
  googleConfigured(): Promise<boolean>;
  chooseGoogleClient(): Promise<boolean>; // pick the OAuth client JSON once per Mac
  currentUser(): Promise<GoogleUser | null>;
  signIn(): Promise<GoogleUser>;
  signOut(): Promise<void>;

  // ffmpeg and ffprobe (see src-tauri/src/tools.rs)
  toolsStatus(): Promise<ToolsStatus>;
  /** Download and install ffmpeg and ffprobe in the background. Rejects with "cancelled" after `cancelInstallTools`. */
  installTools(onProgress?: (p: ToolsProgress) => void): Promise<void>;
  cancelInstallTools(): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Move files the app made in a show (bundle-relative, under media/) to the Trash. */
  trashFiles(bundle: string, paths: string[]): Promise<void>;
  openWeb(url: string): Promise<void>;

  // Timecode and clips (see src-tauri/src/ltc.rs and lib.rs)
  ltcScan(path: string, onProgress?: (fraction: number) => void): Promise<LtcResult>;
  /**
   * `ltcChannel`: the record's LTC channel, kept in the clip on one side; the clip's name then ends `_LTC-L` or `_LTC-R`.
   * `cuts`: pauses (seconds into `source`) left out of the clip, which jumps over each with GAP CUT drawn on it.
   * `burnIn`: the record's LTC and the song, drawn as a card in the clip's bottom-right corner (see src-tauri/src/burnin.rs),
   * unless `tc` is false (then only for the GAP CUT notices).
   */
  cutClip(job: string, bundle: string, source: string, start: number, end: number, cuts: [number, number][], name: string, ltcChannel: number | null,
    burnIn: { fps: number; blocks: TcBlock[]; song: string; number: string | null; tc: boolean } | null, onProgress?: (fraction: number) => void): Promise<string>;
  grabFrame(bundle: string, source: string, time: number, name: string): Promise<string>;
  /** Crop an image into media/crops/ (`crop` in fractions of the picture). Returns the bundle-relative path. */
  cropImage(bundle: string, source: string, crop: CropRect, name: string): Promise<string>;
  /** Ask where to save a copy of a file, starting in Downloads with `defaultName`. */
  chooseSavePath(defaultName: string): Promise<string | null>;
  /** Save a copy of `source` at `dest`. `dropChannel` takes the LTC channel out; `audioOnly` writes just the audio, as WAV. */
  saveCopy(job: string, source: string, dest: string, dropChannel: number | null, audioOnly: boolean, onProgress?: (fraction: number) => void): Promise<void>;
  /** The best few frames of `start`–`end` for a thumbnail (bright, sharp, colourful), as preview JPEGs outside the show. */
  thumbCandidates(source: string, start: number, end: number, count: number): Promise<ThumbCandidate[]>;

  // Google APIs as the signed-in user (see google.rs). Desktop only.
  googleApi<T = unknown>(method: string, url: string, body?: unknown): Promise<T>;
  /** Upload to Drive (into `parent`, or replacing `fileId`); images are downsized to `maxPx`. Returns the file id. */
  googleUpload(path: string, name: string, parent: string | null, fileId: string | null, maxPx?: number): Promise<string>;

  // Shows in Google Drive, copied to this Mac (see src-tauri/src/drive.rs and src/drive/). Desktop only.
  /** The folder on this Mac holding each show's copy, as shows/<Drive folder id>. */
  driveCacheRoot(): Promise<string>;
  /** Download a Drive file (or one `revision` of it) into a show's copy. */
  driveDownload(fileId: string, dest: string, revision?: string): Promise<void>;
  /** Upload a file: new in `parent` (named `name`), or new content for `fileId`. */
  driveUpload(path: string, to: { name?: string; parent?: string; fileId?: string; properties?: Record<string, string> }): Promise<DriveFile>;
  /** Download any of a show's files (bundle-relative) that aren't on this Mac yet. Returns a note for each that couldn't be. */
  driveFetch(bundle: string, paths: string[]): Promise<string[]>;
  /** Delete downloaded files (bundle-relative, under media/) from a show's copy; they stay in Drive. Returns how many. */
  driveEvict(bundle: string, paths: string[]): Promise<number>;
  /** Delete a show's whole copy from this Mac. */
  driveForget(bundle: string): Promise<void>;
  /** Every show copied to this Mac, as absolute paths of their folders. */
  driveCachedShows(): Promise<string[]>;
  /** Bytes the shows folder takes up on this Mac. */
  driveCacheSize(): Promise<number>;
  /** Open the shows folder in Finder. */
  driveOpenCache(): Promise<void>;
  /** What the shows folder takes up, and the size of the disk it's on and what's free there, in bytes. */
  driveStorage(): Promise<{ cache: number; total: number; free: number }>;
  /** The most the shows folder may take up (0: no limit): over it, the media used longest ago is deleted. Trims it now; returns the bytes freed. */
  driveSetCacheLimit(bytes: number): Promise<number>;
  /** Which of these absolute paths are files on this Mac. */
  pathsExist(paths: string[]): Promise<boolean[]>;
  readJson<T>(bundle: string, name: SideFile): Promise<T | null>;
  writeJson(bundle: string, name: SideFile, value: unknown): Promise<void>;
}

/** Listen to a Rust progress event for one id while `run` is in flight. */
async function withProgress<T>(event: string, id: string, onProgress: ((f: number) => void) | undefined, run: () => Promise<T>): Promise<T> {
  const unlisten = onProgress ? await listen<{ id: string; fraction: number }>(event, (e) => e.payload.id === id && onProgress(e.payload.fraction)) : null;
  try {
    return await run();
  } finally {
    unlisten?.();
  }
}

let previewToolsInstalled = false;
let previewToolsCancel = false;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const desktop: Backend = {
  isDesktop: true,
  async chooseImages() {
    const paths = await openDialog({ title: "Add images", multiple: true, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    return Array.isArray(paths) ? paths : paths ? [paths] : [];
  },
  async chooseFiles(kind, multiple) {
    const paths = await openDialog({ title: `Choose ${FILTERS[kind].name.toLowerCase()}`, multiple, filters: [FILTERS[kind]] });
    return Array.isArray(paths) ? paths : paths ? [paths] : [];
  },
  async chooseMedia() {
    const all = Object.values(FILTERS).flatMap((f) => f.extensions);
    const paths = await openDialog({ title: "Add media", multiple: true, filters: [{ name: "Media", extensions: all }, ...Object.values(FILTERS)] });
    return Array.isArray(paths) ? paths : paths ? [paths] : [];
  },
  async chooseFolder(title, defaultPath) {
    const path = await openDialog({ title, directory: true, multiple: false, defaultPath });
    return typeof path === "string" ? path : null;
  },
  async listFolder(folder, extensions) {
    return (await invoke("list_folder", { folder, extensions })) as FolderFile[];
  },
  async probe(path) {
    try {
      await local(path);
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
    // A show's media comes through the media server, which downloads it from Drive the first time it's shown.
    return inShows(path) ? desktop.streamUrl(path) : convertFileSrc(path);
  },
  streamUrl(path) {
    return mediaBase ? mediaBase + path.split("/").map(encodeURIComponent).join("/") : convertFileSrc(path);
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
    return desktop.fileUrl(relative.startsWith("/") ? relative : `${bundle}/${relative}`);
  },
  async confirm(message) {
    return ask(message, { title: "PM Show Sheet", kind: "warning" });
  },
  onFileDrop(cb, onHover) {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const type = event.payload.type;
        if (type === "enter" || type === "over") onHover?.(true);
        else onHover?.(false);
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
  async googleConfigured() {
    return (await invoke("google_client_configured")) as boolean;
  },
  async chooseGoogleClient() {
    const path = await openDialog({ title: "Choose the Google OAuth client file (client_secret….json)", multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return false;
    await invoke("google_set_client", { path });
    return true;
  },
  async currentUser() {
    return (await invoke("google_current_user")) as GoogleUser | null;
  },
  async signIn() {
    return (await invoke("google_sign_in")) as GoogleUser;
  },
  async signOut() {
    await invoke("google_sign_out");
  },
  async toolsStatus() {
    return (await invoke("tools_status")) as ToolsStatus;
  },
  async installTools(onProgress) {
    const unlisten = onProgress ? await listen<ToolsProgress>("tools-install-progress", (e) => onProgress(e.payload)) : null;
    try {
      await invoke("tools_install");
    } finally {
      unlisten?.();
    }
  },
  async cancelInstallTools() {
    await invoke("tools_install_cancel");
  },
  async reveal(path) {
    await revealItemInDir(path);
  },
  async trashFiles(bundle, paths) {
    if (paths.length) await invoke("bundle_trash_files", { bundle, paths });
  },
  async openWeb(url) {
    await openUrl(url);
  },
  async ltcScan(path, onProgress) {
    return withProgress("ltc-progress", path, onProgress, async () => (await invoke("ltc_scan", { path })) as LtcResult);
  },
  async cutClip(job, bundle, source, start, end, cuts, name, ltcChannel, burnIn, onProgress) {
    await local(source);
    return withProgress("clip-progress", job, onProgress, async () => (await invoke("clip_cut", { job, bundle, source, start, end, cuts, name, ltcChannel, burnIn })) as string);
  },
  async grabFrame(bundle, source, time, name) {
    await local(source);
    return (await invoke("frame_grab", { bundle, source, time, name })) as string;
  },
  async cropImage(bundle, source, crop, name) {
    await local(source);
    return (await invoke("image_crop", { bundle, source, ...crop, name })) as string;
  },
  async thumbCandidates(source, start, end, count) {
    await local(source);
    return (await invoke("thumb_candidates", { source, start, end, count })) as ThumbCandidate[];
  },
  async chooseSavePath(defaultName) {
    const ext = defaultName.includes(".") ? defaultName.split(".").pop()! : "";
    const defaultPath = await downloadDir().then((dir) => join(dir, defaultName)).catch(() => defaultName);
    const path = await saveDialog({ title: "Save a copy", defaultPath, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
    return path ?? null;
  },
  async saveCopy(job, source, dest, dropChannel, audioOnly, onProgress) {
    await local(source);
    await withProgress("save-progress", job, onProgress, () => invoke("media_save", { job, source, dest, dropChannel, audioOnly }));
  },
  async googleApi<T>(method: string, url: string, body?: unknown) {
    return (await invoke("google_api", { method, url, body: body ?? null })) as T;
  },
  async googleUpload(path, name, parent, fileId, maxPx) {
    return (await invoke("google_upload", { path, name, parent, fileId, maxPx: maxPx ?? null })) as string;
  },
  async driveCacheRoot() {
    return (await invoke("drive_cache_root")) as string;
  },
  async driveDownload(fileId, dest, revision) {
    await invoke("drive_download", { fileId, dest, revision: revision ?? null });
  },
  async driveUpload(path, to) {
    return (await invoke("drive_upload", { path, name: to.name ?? null, parent: to.parent ?? null, fileId: to.fileId ?? null, properties: to.properties ?? null })) as DriveFile;
  },
  async driveFetch(bundle, paths) {
    return paths.length ? ((await invoke("drive_fetch", { bundle, paths })) as string[]) : [];
  },
  async driveEvict(bundle, paths) {
    return paths.length ? ((await invoke("drive_evict", { bundle, paths })) as number) : 0;
  },
  async driveForget(bundle) {
    await invoke("drive_forget", { bundle });
  },
  async driveCachedShows() {
    return (await invoke("drive_cached_shows")) as string[];
  },
  async driveCacheSize() {
    return (await invoke("drive_cache_size")) as number;
  },
  async driveOpenCache() {
    await invoke("drive_open_cache");
  },
  async driveStorage() {
    return (await invoke("drive_storage")) as { cache: number; total: number; free: number };
  },
  async driveSetCacheLimit(bytes) {
    return (await invoke("drive_set_cache_limit", { bytes })) as number;
  },
  async pathsExist(paths) {
    return paths.length ? ((await invoke("paths_exist", { paths })) as boolean[]) : [];
  },
  async readJson<T>(bundle: string, name: SideFile) {
    return (await invoke("side_read", { bundle, name })) as T | null;
  },
  async writeJson(bundle, name, value) {
    await invoke("side_write", { bundle, name, value });
  },
};

const memory = new Map<string, Show>();
// In `npm run dev` the Vite server can list and serve files inside the project folder (see vite.config.ts),
// so the browser preview can exercise records, audio and the render inbox with the example content.
const DEV = import.meta.env.DEV;
const askPath = (title: string) => (DEV ? window.prompt(`${title}\n(browser preview: paste an absolute path inside the project folder)`) : null);
const browser: Backend = {
  isDesktop: false,
  async chooseImages() {
    const p = askPath("Image path");
    return p ? [p] : [];
  },
  async chooseFiles() {
    const p = askPath("File path");
    return p ? [p] : [];
  },
  async chooseMedia() {
    const p = askPath("Media file path");
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
  streamUrl(path) {
    return browser.fileUrl(path);
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
  async googleConfigured() {
    return true;
  },
  async chooseGoogleClient() {
    return true;
  },
  async currentUser() {
    try { return JSON.parse(sessionStorage.getItem("preview-user") ?? "null"); } catch { return null; }
  },
  async signIn() {
    await new Promise((r) => setTimeout(r, 400));
    const user = { name: "Preview User", email: "preview@example.com", picture: null };
    try { sessionStorage.setItem("preview-user", JSON.stringify(user)); } catch { /* preview only */ }
    return user;
  },
  async signOut() {
    try { sessionStorage.removeItem("preview-user"); } catch { /* preview only */ }
  },
  async toolsStatus() {
    // ?noffmpeg previews the ffmpeg setup guide; add ?ffmpegfail to see a failed download.
    const have = previewToolsInstalled || !new URLSearchParams(location.search).has("noffmpeg");
    return { ffmpeg: have, ffprobe: have };
  },
  async installTools(onProgress) {
    previewToolsCancel = false;
    const total = 56_713_400;
    for (let received = 0; received < total; received = Math.min(total, received + 1_400_000)) {
      await new Promise((r) => setTimeout(r, 100));
      if (previewToolsCancel) throw "cancelled";
      if (received > total / 2 && new URLSearchParams(location.search).has("ffmpegfail")) {
        throw "The download of ffprobe stopped. Check the internet connection and try again.";
      }
      onProgress?.({ phase: "download", received, total });
    }
    onProgress?.({ phase: "install", received: total, total });
    await new Promise((r) => setTimeout(r, 900));
    previewToolsInstalled = true;
  },
  async cancelInstallTools() {
    previewToolsCancel = true;
  },
  async reveal() {},
  async trashFiles() {},
  async openWeb(url) {
    window.open(url, "_blank");
  },
  async ltcScan(path, onProgress) {
    // Preview stand-in: the Overmono record's TC map from DESIGN.md Appendix A. The real scan is in Rust.
    for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 120)); onProgress?.(i / 10); }
    if (!/\b(L?TC)\b/i.test(path) || /NO TIMECODE/i.test(path)) return { channel: null, fps: null, blocks: [], duration: 5700 };
    return PREVIEW_LTC;
  },
  async cutClip(_job, _bundle, source, start, end, _cuts, _name, _keep, _burnIn, onProgress) {
    for (let i = 1; i <= 8; i++) { await new Promise((r) => setTimeout(r, 80)); onProgress?.(i / 8); }
    return `${source}#t=${start},${end}`; // preview doesn't cut: it points at the source
  },
  async grabFrame() {
    throw new Error("Frame grabs need the desktop app");
  },
  async cropImage() {
    throw new Error("Cropping needs the desktop app");
  },
  async thumbCandidates() {
    return [];
  },
  async chooseSavePath(defaultName) {
    return defaultName;
  },
  async saveCopy(_job, source, dest, dropChannel, audioOnly) {
    if (dropChannel !== null || audioOnly) throw new Error("Taking the timecode out needs the desktop app");
    const a = Object.assign(document.createElement("a"), { href: browser.fileUrl(source), download: dest });
    a.click();
  },
  async googleApi() {
    throw new Error("Google sync needs the desktop app");
  },
  async googleUpload() {
    throw new Error("Google sync needs the desktop app");
  },
  async driveCacheRoot() {
    return "/preview/shows";
  },
  async driveDownload() {
    throw new Error("Google Drive needs the desktop app");
  },
  async driveUpload() {
    throw new Error("Google Drive needs the desktop app");
  },
  async driveFetch() {
    return [];
  },
  async driveEvict() {
    return 0;
  },
  async driveForget() {},
  async driveCachedShows() {
    return [];
  },
  async driveCacheSize() {
    return 0;
  },
  async driveOpenCache() {},
  async driveStorage() {
    return { cache: 0, total: 0, free: 0 };
  },
  async driveSetCacheLimit() {
    return 0;
  },
  async pathsExist(paths) {
    return paths.map(() => true);
  },
  async readJson<T>(bundle: string, name: SideFile) {
    try { return JSON.parse(sessionStorage.getItem(`${name}:${bundle}`) ?? "null") as T | null; } catch { return null; }
  },
  async writeJson(bundle, name, value) {
    try { sessionStorage.setItem(`${name}:${bundle}`, JSON.stringify(value)); } catch { /* preview only */ }
  },
};

/** The browser preview's All shows: the sample show, and any made in this session. */
export async function previewShows(): Promise<ShowSummary[]> {
  const sampleAt = "/preview/shows/Sample";
  if (!memory.has(sampleAt)) memory.set(sampleAt, structuredClone(sample) as Show);
  return [...memory.entries()].map(([path, show]) => {
    const hero = showCover(show);
    return { path, name: show.name, venue: show.venue, date: show.date, songs: show.set_order.length, cover: hero?.startsWith("/") ? hero : null,
      modified_ms: Date.now(), where: "My Drive › Pixelmappers Show Sheets", canEdit: true };
  });
}

const PREVIEW_LTC: LtcResult = (() => {
  const map: [string, string][] = [["0:00", "02:00"], ["5:40", "01:30"], ["10:40", "00:20"], ["14:20", "04:00"], ["18:00", "09:00"], ["22:20", "22:00"],
    ["26:50", "11:00"], ["30:50", "11:30"], ["34:00", "18:00"], ["38:50", "00:10"], ["43:40", "04:30"], ["48:20", "00:30"], ["55:20", "03:30"],
    ["58:50", "05:00"], ["61:40", "10:00"], ["66:20", "23:00"], ["74:20", "21:00"], ["79:00", "02:30"], ["84:30", "20:00"]];
  const secs = (ms: string) => { const [m, s] = ms.split(":").map(Number); return m * 60 + s; };
  const blocks = map.map(([ft, tc], i) => {
    const start = secs(ft) + 35;
    const end = (i < map.length - 1 ? secs(map[i + 1][0]) : 88 * 60 + 50) + 35;
    return { file_start: start, file_end: end, tc_start: `${tc}:00:00`, tc_end: `${tc}:${String(Math.floor((end - start) / 60)).padStart(2, "0")}:00` };
  });
  return { channel: 1, fps: 25, blocks, duration: 89 * 60 + 25 };
})();

export const backend: Backend = isTauri ? desktop : browser;

let mediaBase: string | null = null;
let showsRoot: string | null = null; // where shows are copied from Google Drive (see src/drive/show.ts)
/** Start what the backend needs before the app shows: the desktop app's local video server, and where shows are copied. */
export async function initBackend() {
  if (!isTauri) return;
  mediaBase = await invoke<string>("media_server").catch(() => null);
  showsRoot = await invoke<string>("drive_cache_root").catch(() => null);
}

/** A file in a show's copy, which may still be only in Google Drive (made on another Mac). */
const inShows = (path: string) => showsRoot !== null && path.startsWith(`${showsRoot}/`);

/** Download a show's file from Drive if it isn't on this Mac yet, before ffmpeg or Rust reads it. */
async function local(path: string): Promise<void> {
  if (!inShows(path)) return;
  const rest = path.slice(showsRoot!.length + 1);
  const cut = rest.indexOf("/");
  if (cut < 0) return;
  const notes = (await invoke("drive_fetch", { bundle: `${showsRoot}/${rest.slice(0, cut)}`, paths: [rest.slice(cut + 1)] })) as string[];
  if (notes.length) throw new Error(`Couldn't download it from Google Drive: ${notes[0]}`);
}
export const sampleShow = sample as Show;

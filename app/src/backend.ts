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
import type { CropRect, InboxState, LtcResult, MediaInfo, Show } from "./model/types";
import sample from "./model/sample_show.json";

export type MediaKind = "renders" | "grabs" | "clips" | "layout" | "inspo";
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "tif", "tiff", "webp", "gif", "heic"];

export interface FolderFile {
  path: string;
  name: string;
  size: number;
  modified_ms: number;
}

export interface DriveStatus {
  installed: boolean;
  accounts: string[]; // "" for the old /Volumes/GoogleDrive mount
}

export interface ToolsStatus {
  ffmpeg: boolean;
  ffprobe: boolean;
  brew: boolean; // Homebrew, which installs them
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
}

export type FileKind = "video" | "audio" | "image";
/** Where a file's content is: see src-tauri/src/files.rs. */
export type FileState = "local" | "online" | "uploading" | "missing" | "na";
export interface ThumbCandidate { time: number; path: string; score: number }
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

  // Shows in Google Drive (see src-tauri/src/shows.rs)
  showsFolder(email: string | null): Promise<string | null>;
  /** Whether Google Drive for desktop is installed, and the accounts it's signed in to. */
  driveStatus(): Promise<DriveStatus>;
  /** Open the Google Drive app, to sign in. */
  openDriveApp(): Promise<void>;

  // ffmpeg and ffprobe (see src-tauri/src/tools.rs)
  toolsStatus(): Promise<ToolsStatus>;
  /** `brew install ffmpeg` in the background; `onLine` gets each line of brew's output. */
  installTools(onLine?: (line: string) => void): Promise<void>;
  /** Open a Terminal script that installs Homebrew (asking for the Mac password) and then ffmpeg. */
  installToolsInTerminal(): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  listShows(folder: string): Promise<ShowSummary[]>;
  showSummaries(paths: string[]): Promise<ShowSummary[]>;
  /** Every show in Google Drive (My Drive and shared drives); `onFound` gets each one as soon as it's found. */
  scanShows(email: string | null, hints: string[], onFound: (s: ShowSummary) => void): Promise<ShowSummary[]>;
  /** The Drive item id of a synced file or folder, for links to drive.google.com. */
  driveItemId(path: string): Promise<string | null>;
  /** Say this Mac has the show open; returns who else does. */
  presenceBeat(bundle: string, email: string, name: string): Promise<{ email: string; name: string; at: number }[]>;
  presenceLeave(bundle: string, email: string): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Move a show bundle (and everything in it) to the Trash. */
  trashBundle(path: string): Promise<void>;
  /** Move files the app made in a show (bundle-relative, under media/) to the Trash. */
  trashFiles(bundle: string, paths: string[]): Promise<void>;
  /** Move a show bundle into another folder; returns its new path. */
  moveBundle(path: string, folder: string): Promise<string>;
  /** Rename a show bundle to `<stem>.showsheet` in its folder; returns its new path. */
  renameBundle(path: string, stem: string): Promise<string>;
  openWeb(url: string): Promise<void>;

  // Timecode and clips (see src-tauri/src/ltc.rs and lib.rs)
  ltcScan(path: string, onProgress?: (fraction: number) => void): Promise<LtcResult>;
  /** `ltcChannel`: the record's LTC channel, kept in the clip on one side; the clip's name then ends `_LTC-L` or `_LTC-R`. */
  cutClip(job: string, bundle: string, source: string, start: number, end: number, name: string, ltcChannel: number | null, onProgress?: (fraction: number) => void): Promise<string>;
  grabFrame(bundle: string, source: string, time: number, name: string): Promise<string>;
  /** Crop an image into media/crops/ (`crop` in fractions of the picture). Returns the bundle-relative path. */
  cropImage(bundle: string, source: string, crop: CropRect, name: string): Promise<string>;
  /** Ask where to save a copy of a file, starting in Downloads with `defaultName`. */
  chooseSavePath(defaultName: string): Promise<string | null>;
  /** Save a copy of `source` at `dest`. `dropChannel` takes the LTC channel out; `audioOnly` writes just the audio, as WAV. */
  saveCopy(job: string, source: string, dest: string, dropChannel: number | null, audioOnly: boolean, onProgress?: (fraction: number) => void): Promise<void>;
  /** The best few frames of `start`–`end` for a thumbnail (bright, sharp, colourful), as preview JPEGs outside the show. */
  thumbCandidates(source: string, start: number, end: number, count: number): Promise<ThumbCandidate[]>;

  // Cloud files (see src-tauri/src/files.rs)
  fileStates(paths: string[]): Promise<Record<string, FileState>>;
  /** Make files online only; returns a note for each one that couldn't be. */
  makeOnlineOnly(paths: string[]): Promise<string[]>;
  makeAvailable(paths: string[]): Promise<void>;

  // Google APIs as the signed-in user (see google.rs). Desktop only.
  googleApi<T = unknown>(method: string, url: string, body?: unknown): Promise<T>;
  /** Upload to Drive (into `parent`, or replacing `fileId`); images are downsized to `maxPx`. Returns the file id. */
  googleUpload(path: string, name: string, parent: string | null, fileId: string | null, maxPx?: number): Promise<string>;
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
    return convertFileSrc(`${bundle}/${relative}`);
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
  async showsFolder(email) {
    return (await invoke("drive_shows_folder", { email })) as string | null;
  },
  async driveStatus() {
    return (await invoke("drive_status")) as DriveStatus;
  },
  async openDriveApp() {
    await invoke("drive_open_app");
  },
  async toolsStatus() {
    return (await invoke("tools_status")) as ToolsStatus;
  },
  async installTools(onLine) {
    const unlisten = onLine ? await listen<string>("tools-install-log", (e) => onLine(e.payload)) : null;
    try {
      await invoke("tools_install");
    } finally {
      unlisten?.();
    }
  },
  async installToolsInTerminal() {
    await invoke("tools_install_in_terminal");
  },
  async ensureFolder(path) {
    await invoke("ensure_folder", { path });
  },
  async listShows(folder) {
    return (await invoke("shows_list", { folder })) as ShowSummary[];
  },
  async showSummaries(paths) {
    return (await invoke("shows_summaries", { paths })) as ShowSummary[];
  },
  async scanShows(email, hints, onFound) {
    const unlisten = await listen<ShowSummary>("show-found", (e) => onFound(e.payload));
    try {
      return (await invoke("shows_scan", { email, hints })) as ShowSummary[];
    } finally {
      unlisten();
    }
  },
  async driveItemId(path) {
    return (await invoke("drive_item_id", { path })) as string | null;
  },
  async presenceBeat(bundle, email, name) {
    return (await invoke("presence_beat", { bundle, email, name })) as { email: string; name: string; at: number }[];
  },
  async presenceLeave(bundle, email) {
    await invoke("presence_leave", { bundle, email });
  },
  async reveal(path) {
    await revealItemInDir(path);
  },
  async moveBundle(path, folder) {
    return (await invoke("bundle_move", { path, folder })) as string;
  },
  async renameBundle(path, stem) {
    return (await invoke("bundle_rename", { path, stem })) as string;
  },
  async trashBundle(path) {
    await invoke("bundle_trash", { path });
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
  async cutClip(job, bundle, source, start, end, name, ltcChannel, onProgress) {
    return withProgress("clip-progress", job, onProgress, async () => (await invoke("clip_cut", { job, bundle, source, start, end, name, ltcChannel })) as string);
  },
  async grabFrame(bundle, source, time, name) {
    return (await invoke("frame_grab", { bundle, source, time, name })) as string;
  },
  async cropImage(bundle, source, crop, name) {
    return (await invoke("image_crop", { bundle, source, ...crop, name })) as string;
  },
  async thumbCandidates(source, start, end, count) {
    return (await invoke("thumb_candidates", { source, start, end, count })) as ThumbCandidate[];
  },
  async chooseSavePath(defaultName) {
    const ext = defaultName.includes(".") ? defaultName.split(".").pop()! : "";
    const defaultPath = await downloadDir().then((dir) => join(dir, defaultName)).catch(() => defaultName);
    const path = await saveDialog({ title: "Save a copy", defaultPath, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
    return path ?? null;
  },
  async saveCopy(job, source, dest, dropChannel, audioOnly, onProgress) {
    await withProgress("save-progress", job, onProgress, () => invoke("media_save", { job, source, dest, dropChannel, audioOnly }));
  },
  async fileStates(paths) {
    const list = (await invoke("file_states", { paths })) as { path: string; state: FileState }[];
    return Object.fromEntries(list.map((f) => [f.path, f.state]));
  },
  async makeOnlineOnly(paths) {
    return (await invoke("make_online_only", { paths })) as string[];
  },
  async makeAvailable(paths) {
    await invoke("make_available", { paths });
  },
  async googleApi<T>(method: string, url: string, body?: unknown) {
    return (await invoke("google_api", { method, url, body: body ?? null })) as T;
  },
  async googleUpload(path, name, parent, fileId, maxPx) {
    return (await invoke("google_upload", { path, name, parent, fileId, maxPx: maxPx ?? null })) as string;
  },
};

const memory = new Map<string, Show>();
const previewOnline = new Set<string>();
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
  async showsFolder() {
    return PREVIEW_FOLDER;
  },
  async driveStatus() {
    // ?nodrive previews the Drive setup guide.
    const missing = new URLSearchParams(location.search).has("nodrive");
    return { installed: !missing, accounts: missing ? [] : ["preview@example.com"] };
  },
  async openDriveApp() {},
  async toolsStatus() {
    // ?noffmpeg previews the ffmpeg setup guide; add ?nobrew for the Terminal route.
    const q = new URLSearchParams(location.search);
    const have = previewToolsInstalled || !q.has("noffmpeg");
    return { ffmpeg: have, ffprobe: have, brew: !q.has("nobrew") };
  },
  async installTools(onLine) {
    for (const line of ["==> Fetching ffmpeg", "==> Pouring ffmpeg--7.1.arm64_sequoia.bottle.tar.gz", "🍺  /opt/homebrew/Cellar/ffmpeg/7.1"]) {
      await new Promise((r) => setTimeout(r, 700));
      onLine?.(line);
    }
    previewToolsInstalled = true;
  },
  async installToolsInTerminal() {},
  async ensureFolder() {},
  async listShows(folder) {
    if (folder === PREVIEW_FOLDER && !memory.has(`${PREVIEW_FOLDER}/Sample.showsheet`)) {
      memory.set(`${PREVIEW_FOLDER}/Sample.showsheet`, structuredClone(sample) as Show);
    }
    return browser.showSummaries([...memory.keys()].filter((p) => p.startsWith(`${folder}/`)));
  },
  async scanShows(_email, _hints, onFound) {
    const found = await browser.listShows(PREVIEW_FOLDER);
    found.forEach(onFound);
    return found;
  },
  async driveItemId() {
    return null;
  },
  async presenceBeat() {
    return [];
  },
  async presenceLeave() {},
  async showSummaries(paths) {
    return paths.filter((p) => memory.has(p)).map((path) => {
      const show = memory.get(path)!;
      const hero = showCover(show);
      return { path, name: show.name, venue: show.venue, date: show.date, songs: show.set_order.length, cover: hero?.startsWith("/") ? hero : null, modified_ms: Date.now() };
    });
  },
  async reveal() {},
  async trashBundle(path) {
    memory.delete(path);
  },
  async trashFiles() {},
  async moveBundle(path, folder) {
    const to = `${folder}/${path.split("/").pop()}`;
    if (memory.has(to)) throw new Error("There's already a show with that name there");
    memory.set(to, memory.get(path)!);
    memory.delete(path);
    return to;
  },
  async renameBundle(path, stem) {
    const folder = path.split("/").slice(0, -1).join("/");
    let to = `${folder}/${stem}.showsheet`;
    for (let n = 2; memory.has(to) && to !== path; n++) to = `${folder}/${stem} ${n}.showsheet`;
    if (to !== path) { memory.set(to, memory.get(path)!); memory.delete(path); }
    return to;
  },
  async openWeb(url) {
    window.open(url, "_blank");
  },
  async ltcScan(path, onProgress) {
    // Preview stand-in: the Overmono record's TC map from DESIGN.md Appendix A. The real scan is in Rust.
    for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 120)); onProgress?.(i / 10); }
    if (!/\b(L?TC)\b/i.test(path) || /NO TIMECODE/i.test(path)) return { channel: null, fps: null, blocks: [], duration: 5700 };
    return PREVIEW_LTC;
  },
  async cutClip(_job, _bundle, source, start, end, _name, _keep, onProgress) {
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
  async fileStates(paths) {
    return Object.fromEntries(paths.map((p) => [p, (previewOnline.has(p) ? "online" : "local") as FileState]));
  },
  async makeOnlineOnly(paths) {
    paths.forEach((p) => previewOnline.add(p));
    return [];
  },
  async makeAvailable(paths) {
    paths.forEach((p) => previewOnline.delete(p));
  },
  async googleApi() {
    throw new Error("Google sync needs the desktop app");
  },
  async googleUpload() {
    throw new Error("Google sync needs the desktop app");
  },
};

const PREVIEW_FOLDER = "/Users/preview/Library/CloudStorage/GoogleDrive-preview@example.com/My Drive/Pixelmappers Show Sheets";
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
/** Start what the backend needs before the app shows: the desktop app's local video server. */
export async function initBackend() {
  if (isTauri) mediaBase = await invoke<string>("media_server").catch(() => null);
}
export const sampleShow = sample as Show;

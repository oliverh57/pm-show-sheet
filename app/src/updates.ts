// Background updates from GitHub Releases (see .github/workflows/release.yml).
// The app checks on launch and every few hours, downloads and installs quietly, then offers a
// restart. Each update is verified against the public key in tauri.conf.json before installing.
import { useEffect } from "react";
import { create } from "zustand";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type UpdateStatus = "idle" | "checking" | "downloading" | "ready" | "up-to-date" | "error";

interface UpdateState {
  current: string | null;
  status: UpdateStatus;
  version: string | null; // the version downloaded or being downloaded
  notes: string | null;
  progress: number | null; // 0–1 while downloading, if the size is known
  error: string | null;
  lastChecked: number | null;
}

export const useUpdates = create<UpdateState>(() => ({
  current: null, status: "idle", version: null, notes: null, progress: null, error: null, lastChecked: null,
}));

let running = false;

/** Check GitHub; if there's a newer version, download and install it, ready for the next restart. */
export async function checkForUpdates(): Promise<void> {
  if (!isTauri || running || useUpdates.getState().status === "ready") return;
  running = true;
  useUpdates.setState({ status: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      useUpdates.setState({ status: "up-to-date", lastChecked: Date.now() });
      return;
    }
    useUpdates.setState({ status: "downloading", version: update.version, notes: update.body ?? null, progress: null });
    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total) useUpdates.setState({ progress: received / total });
      }
    });
    useUpdates.setState({ status: "ready", progress: 1, lastChecked: Date.now() });
  } catch (e) {
    useUpdates.setState({ status: "error", error: String(e), lastChecked: Date.now() });
  } finally {
    running = false;
  }
}

export async function restartToUpdate(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Mount once at the top of the app. Development builds never auto-update. */
export function useAutoUpdate() {
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then((current) => useUpdates.setState({ current }));
    if (import.meta.env.DEV) return;
    checkForUpdates();
    const timer = window.setInterval(checkForUpdates, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);
}

// Online only: files in Google Drive (or Dropbox) can be removed from this Mac and stay in the cloud,
// downloading again when they're opened. See src-tauri/src/files.rs.
import { useCallback, useEffect, useState } from "react";
import { backend, type FileState } from "../backend";
import { useStore } from "../store";
import { Icon } from "./icons";

const POLL_MS = 8000; // uploads finish in the background, so look again now and then

export function useFileStates(paths: string[]): [Record<string, FileState>, () => void] {
  const [states, setStates] = useState<Record<string, FileState>>({});
  const key = paths.join("\n");
  const refresh = useCallback(() => {
    if (!key) return setStates({});
    backend.fileStates(key.split("\n")).then(setStates).catch(() => {});
  }, [key]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);
  return [states, refresh];
}

/**
 * "Online only" for files on this Mac, "Download" for online-only ones. Nothing for files outside the cloud.
 * `compact`: one cloud icon for a row of a list, blue while the file is online only (click to toggle).
 */
export function CloudButton({ paths, states, refresh, all, compact }: { paths: string[]; states: Record<string, FileState>; refresh: () => void; all?: boolean; compact?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const known = paths.map((p) => states[p]).filter((s) => s && s !== "na" && s !== "missing");
  if (!known.length) return null;
  const local = paths.filter((p) => states[p] === "local");
  const online = paths.filter((p) => states[p] === "online");
  const uploading = known.length > 0 && known.every((s) => s === "uploading");

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast(String(e).replace(/^Error: /, "")); }
    setBusy(false);
    refresh();
  }
  if (compact) {
    if (uploading) return <button className="icon on" disabled title="Uploading to Google Drive…"><Icon name="upload" size="sm" /></button>;
    return local.length
      ? <button className="icon" disabled={busy} title="On this Mac and in Google Drive. Click to make it online only (removes the download from this Mac)."
                onClick={() => run(async () => { const notes = await backend.makeOnlineOnly(local); if (notes.length) toast(notes.join(" · ")); })}><Icon name="cloud" size="sm" /></button>
      : <button className="icon on" disabled={busy} title="Online only. Click to download it to this Mac." onClick={() => run(() => backend.makeAvailable(online))}><Icon name="cloud" size="sm" /></button>;
  }
  if (uploading) return <button className="sm ghost" disabled title="It can be made online only once it's in Google Drive">Uploading…</button>;
  if (local.length) {
    return (
      <button className="sm" disabled={busy} title="Remove the download from this Mac. It stays in the cloud and downloads again when it's opened."
              onClick={() => run(async () => {
                const notes = await backend.makeOnlineOnly(local);
                toast(notes.length ? notes.join(" · ") : `${local.length === 1 ? "Online only" : `${local.length} files are online only`}`);
              })}>
        <Icon name="cloud" size="sm" /> {busy ? "Working…" : all ? "Make all online only" : "Online only"}
      </button>
    );
  }
  return (
    <button className="sm" disabled={busy} title="Download to this Mac" onClick={() => run(() => backend.makeAvailable(online))}>
      <Icon name="download" size="sm" /> {busy ? "Downloading…" : all ? "Download all" : "Download"}
    </button>
  );
}

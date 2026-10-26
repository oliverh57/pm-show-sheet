// Downloads: a show's clips and images are in Google Drive, and the copy on this Mac can be removed, downloading
// again when it's shown. See src/storage.ts.
import { useCallback, useEffect, useState } from "react";
import { download, type FileState, fileStates, removeDownloads } from "../storage";
import { useStore } from "../store";
import { Icon } from "./icons";

const POLL_MS = 8000; // uploads finish in the background, so look again now and then

export function useFileStates(paths: string[]): [Record<string, FileState>, () => void] {
  const bundle = useStore((s) => s.bundle);
  const [states, setStates] = useState<Record<string, FileState>>({});
  const key = paths.join("\n");
  const refresh = useCallback(() => {
    if (!key || !bundle) return setStates({});
    fileStates(bundle, key.split("\n")).then(setStates).catch(() => {});
  }, [key, bundle]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);
  return [states, refresh];
}

/**
 * "Remove download" for a show's files on this Mac, "Download" for ones only in Drive. Nothing for records and audio.
 * `compact`: one cloud icon for a row of a list, blue while the file is only in Drive (click to toggle).
 */
export function CloudButton({ paths, states, refresh, all, compact }: { paths: string[]; states: Record<string, FileState>; refresh: () => void; all?: boolean; compact?: boolean }) {
  const toast = useStore((s) => s.toast);
  const bundle = useStore((s) => s.bundle);
  const [busy, setBusy] = useState(false);
  const known = paths.map((p) => states[p]).filter((s) => s && s !== "na" && s !== "missing");
  if (!known.length || !bundle) return null;
  const local = paths.filter((p) => states[p] === "local");
  const online = paths.filter((p) => states[p] === "online");
  const uploading = known.length > 0 && known.every((s) => s === "uploading");

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast(String(e).replace(/^Error: /, "")); }
    setBusy(false);
    refresh();
  }
  const remove = () => run(async () => {
    const n = await removeDownloads(bundle!, local);
    if (!compact) toast(n === 1 ? "Removed from this Mac" : `Removed ${n} files from this Mac`);
  });
  const fetchAll = () => run(() => download(bundle!, online));
  if (compact) {
    if (uploading) return <button className="icon on" disabled title="Uploading to Google Drive…"><Icon name="upload" size="sm" /></button>;
    return local.length
      ? <button className="icon" disabled={busy} title="On this Mac and in Google Drive. Click to remove it from this Mac (it downloads again when it's shown)." onClick={remove}><Icon name="cloud" size="sm" /></button>
      : <button className="icon on" disabled={busy} title="In Google Drive only. Click to download it to this Mac." onClick={fetchAll}><Icon name="cloud" size="sm" /></button>;
  }
  if (uploading) return <button className="sm ghost" disabled title="It can be removed from this Mac once it's in Google Drive">Uploading…</button>;
  if (local.length) {
    return (
      <button className="sm" disabled={busy} title="Remove the download from this Mac. It stays in Google Drive and downloads again when it's shown." onClick={remove}>
        <Icon name="cloud" size="sm" /> {busy ? "Working…" : all ? "Remove all downloads" : "Remove download"}
      </button>
    );
  }
  return (
    <button className="sm" disabled={busy} title="Download to this Mac" onClick={fetchAll}>
      <Icon name="download" size="sm" /> {busy ? "Downloading…" : all ? "Download all" : "Download"}
    </button>
  );
}

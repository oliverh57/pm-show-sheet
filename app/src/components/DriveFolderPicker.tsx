// Choosing a folder in Google Drive (for a new show, or moving one): My Drive, each shared drive, and folders shared
// with you that you can add to. Shows themselves (.showsheet folders) aren't offered as places to put a show.
import { useEffect, useState } from "react";
import type { DriveFile } from "../backend";
import { api, createFolder, FOLDER, lit, search } from "../drive/api";
import { SHOW_EXT } from "../drive/list";
import type { DriveFolder } from "../library";
import { GoogleDriveMark, Icon } from "./icons";

interface Place { id: string; name: string }
const TOP: Place = { id: "", name: "Google Drive" };

async function placesIn(at: Place[]): Promise<Place[]> {
  const here = at[at.length - 1];
  if (!here.id) {
    const drives = await api<{ drives?: { id: string; name: string }[] }>("GET", "https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)")
      .then((r) => r.drives ?? []).catch(() => []);
    const shared = await search(`sharedWithMe and mimeType = '${FOLDER}' and trashed = false`, "id,name,capabilities(canAddChildren)")
      .then((fs) => fs.filter((f) => f.capabilities?.canAddChildren && !f.name?.endsWith(SHOW_EXT)))
      .catch(() => [] as DriveFile[]);
    return [{ id: "root", name: "My Drive" }, ...drives, ...shared.map((f) => ({ id: f.id, name: `${f.name} (shared with you)` }))];
  }
  const folders = await search(`${lit(here.id)} in parents and mimeType = '${FOLDER}' and trashed = false`, "id,name");
  return folders.filter((f) => !f.name?.endsWith(SHOW_EXT)).map((f) => ({ id: f.id, name: f.name ?? "Folder" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function DriveFolderPicker({ title, action, onPick, onClose }: { title: string; action: string; onPick: (f: DriveFolder & { id: string }) => void; onClose: () => void }) {
  const [path, setPath] = useState<Place[]>([TOP]);
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const here = path[path.length - 1];
  const label = path.slice(1).map((p) => p.name.replace(/ \(shared with you\)$/, "")).join(" › ");

  useEffect(() => {
    let live = true;
    setPlaces(null);
    setError(null);
    placesIn(path).then((p) => live && setPlaces(p), (e) => live && setError(String(e).replace(/^Error: /, "")));
    return () => { live = false; };
  }, [path]);

  async function makeFolder() {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    try {
      const made = await createFolder(name, here.id);
      setNaming(null);
      setPath([...path, { id: made.id, name }]);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow drive-picker" role="dialog" aria-label={title}>
        <div className="modal-head"><div><h3>{title}</h3><p className="crumbs">
          {path.map((p, i) => (
            <span key={p.id || "top"}>{i > 0 && " › "}<button className="link" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>{p.name.replace(/ \(shared with you\)$/, "")}</button></span>
          ))}
        </p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <div className="folder-list">
            {places === null && !error && <div className="muted small"><span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> Looking…</div>}
            {places?.map((p) => (
              <button key={p.id} className="folder-row" onDoubleClick={() => setPath([...path, p])} onClick={() => setPath([...path, p])}>
                {here.id ? <Icon name="folder" size="sm" /> : <GoogleDriveMark />}<span>{p.name}</span><Icon name="chevR" size="sm" />
              </button>
            ))}
            {places?.length === 0 && <div className="muted small">No folders here.</div>}
          </div>
          {naming !== null && (
            <div className="row2" style={{ marginTop: 10 }}>
              <input autoFocus placeholder="Folder name" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") makeFolder(); if (e.key === "Escape") setNaming(null); }} />
              <button className="sm" onClick={makeFolder}>Make folder</button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot">
          {here.id && naming === null && <button className="sm ghost hint" onClick={() => setNaming("")}><Icon name="plus" size="sm" /> New folder</button>}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!here.id} onClick={() => onPick({ id: here.id, label })}>{action}</button>
        </div>
      </div>
    </div>
  );
}

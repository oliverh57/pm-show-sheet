// Render inbox: everything in the watch folders, culled Lightroom-style.
// P approve (copies the render into the assigned song) · X reject · U clear · ←→↑↓ move ·
// Space/Enter big view · Esc back · 1–9 assign to running-order song 1–9.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, IMAGE_EXTENSIONS, type FolderFile } from "../backend";
import { addImages, addWatchFolder, groupSessions, removeWatchFolder, setHero } from "../model/ops";
import type { InboxState } from "../model/types";
import { SHOW_ID, useStore } from "../store";

type Filter = "todo" | "approved" | "rejected" | "all";
type Item = FolderFile & { folderId: string };
const POLL_MS = 5000;
const THUMB_WIDTH = 220;

export function RenderInbox() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const selected = useStore((s) => s.selectedSongId);
  const update = useStore((s) => s.update);
  const folders = show.watch_folders ?? [];

  const [items, setItems] = useState<Item[]>([]);
  const [inbox, setInbox] = useState<InboxState>({});
  const [filter, setFilter] = useState<Filter>("todo");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loupe, setLoupe] = useState(false);
  const [songId, setSongId] = useState<string>(selected && selected !== SHOW_ID ? selected : show.set_order[0] ?? "");
  const [makeHero, setMakeHero] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keyed on paths so a new (but equal) folders array doesn't restart polling.
  const folderKey = folders.map((f) => `${f.id}=${f.path}`).join("|");
  const refresh = useCallback(async () => {
    const current = useStore.getState().show?.watch_folders ?? [];
    const lists = await Promise.all(current.map(async (f) => {
      try {
        return (await backend.listFolder(f.path, IMAGE_EXTENSIONS)).map((x) => ({ ...x, folderId: f.id }));
      } catch {
        return [];
      }
    }));
    setItems(lists.flat().sort((a, b) => a.modified_ms - b.modified_ms));
  }, [folderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    backend.readInbox(bundle).then(setInbox);
  }, [bundle]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const visible = useMemo(() => items.filter((it) => {
    const flag = inbox[it.path]?.flag;
    return filter === "all" || (filter === "todo" ? !flag : flag === filter);
  }), [items, inbox, filter]);
  const sessions = useMemo(() => groupSessions(visible), [visible]);
  const counts = useMemo(() => ({
    todo: items.filter((i) => !inbox[i.path]).length,
    approved: items.filter((i) => inbox[i.path]?.flag === "approved").length,
    rejected: items.filter((i) => inbox[i.path]?.flag === "rejected").length,
    all: items.length,
  }), [items, inbox]);

  const index = visible.findIndex((v) => v.path === cursor);
  const current = index >= 0 ? visible[index] : visible[0];
  useEffect(() => {
    if (!current && visible.length === 0) setLoupe(false);
  }, [current, visible.length]);
  useEffect(() => {
    if (current) gridRef.current?.querySelector(`[data-path="${CSS.escape(current.path)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  async function persist(next: InboxState) {
    setInbox(next);
    await backend.writeInbox(bundle, next);
  }

  /** After flagging, move to the next item that's still visible under the current filter. */
  function advance(from: Item) {
    const i = visible.findIndex((v) => v.path === from.path);
    const next = visible[i + 1] ?? visible[i - 1];
    setCursor(next && next.path !== from.path ? next.path : null);
  }

  async function approve(it: Item) {
    if (!songId) return setMessage("Choose which song this render is for first (song list on the right, or keys 1–9).");
    try {
      const existing = inbox[it.path];
      const rel = existing?.imported_as ?? (await backend.importMedia(bundle, it.path, "renders"));
      update((s) => {
        addImages(s, songId, [rel]);
        if (makeHero) setHero(s, songId, rel);
      });
      await persist({ ...inbox, [it.path]: { flag: "approved", song_id: songId, imported_as: rel } });
      setMessage(`Approved for ${show.songs[songId]?.fields.name ?? "song"}`);
      if (filter === "todo") advance(it);
    } catch (e) {
      setMessage(String(e));
    }
  }

  async function reject(it: Item) {
    await persist({ ...inbox, [it.path]: { ...inbox[it.path], flag: "rejected" } });
    if (filter === "todo") advance(it);
  }

  async function clear(it: Item) {
    const next = { ...inbox };
    delete next[it.path];
    await persist(next);
  }

  async function addFolder() {
    const path = await backend.chooseFolder("Choose the folder Depence exports renders into");
    if (path) update((s) => { addWatchFolder(s, path); });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || !current || e.metaKey || e.ctrlKey) return;
    const perRow = Math.max(1, Math.floor((gridRef.current?.clientWidth ?? THUMB_WIDTH) / (THUMB_WIDTH + 10)));
    const go = (d: number) => setCursor(visible[Math.max(0, Math.min(visible.length - 1, (index < 0 ? 0 : index) + d))]?.path ?? null);
    const key = e.key.toLowerCase();
    if (key === "arrowright") go(1);
    else if (key === "arrowleft") go(-1);
    else if (key === "arrowdown") go(loupe ? 1 : perRow);
    else if (key === "arrowup") go(loupe ? -1 : -perRow);
    else if (key === "p") approve(current);
    else if (key === "x") reject(current);
    else if (key === "u") clear(current);
    else if (key === " " || key === "enter") setLoupe(!loupe);
    else if (key === "escape") setLoupe(false);
    else if (/^[1-9]$/.test(key) && show.set_order[Number(key) - 1]) setSongId(show.set_order[Number(key) - 1]);
    else return;
    e.preventDefault();
  }

  const songName = (id?: string) => (id ? show.songs[id]?.fields.name : "") ?? "";
  const flagOf = (it: Item) => inbox[it.path]?.flag;

  return (
    <div className="inbox" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <aside className="inbox-side">
        <h3>WATCH FOLDERS</h3>
        {folders.map((f) => (
          <div key={f.id} className="watch">
            <span title={f.path}>{f.label}</span>
            <button className="icon" onClick={() => update((s) => removeWatchFolder(s, f.id))} title="Stop watching">×</button>
          </div>
        ))}
        <button onClick={addFolder} disabled={!backend.isDesktop}>+ Watch a folder…</button>
        <h3>SHOW</h3>
        {(["todo", "approved", "rejected", "all"] as Filter[]).map((f) => (
          <button key={f} className={`filter ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            <span>{{ todo: "To review", approved: "Approved", rejected: "Rejected", all: "All" }[f]}</span><span className="muted">{counts[f]}</span>
          </button>
        ))}
        <div className="keys muted small">
          <b>P</b> approve · <b>X</b> reject · <b>U</b> clear<br />
          <b>←→↑↓</b> move · <b>Space</b> big view<br />
          <b>1–9</b> assign to song 1–9 in the running order
        </div>
      </aside>

      <main className="inbox-main" ref={gridRef}>
        {folders.length === 0 && (
          <div className="inbox-empty">
            <h2>No watch folders yet</h2>
            <p className="muted">Add the folder Depence exports renders into. Every still that lands there shows up here to approve or reject.</p>
            <button className="primary" onClick={addFolder} disabled={!backend.isDesktop}>+ Watch a folder…</button>
          </div>
        )}
        {folders.length > 0 && visible.length === 0 && <div className="inbox-empty muted">Nothing {filter === "todo" ? "left to review" : `in “${filter}”`}.</div>}
        {loupe && current ? (
          <div className="loupe" onDoubleClick={() => setLoupe(false)}>
            <img src={backend.fileUrl(current.path)} alt="" />
            <div className="loupe-bar">
              <span>{current.name}</span><span className="muted">{index + 1} / {visible.length}</span>
              {flagOf(current) && <span className={`flag ${flagOf(current)}`}>{flagOf(current)}{inbox[current.path]?.song_id ? ` · ${songName(inbox[current.path].song_id)}` : ""}</span>}
            </div>
          </div>
        ) : sessions.map((group, gi) => (
          <section key={gi} className="session">
            <h3>{new Date(group[0].modified_ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              <span className="muted"> · {group.length} renders</span></h3>
            <div className="thumbs">
              {group.map((it) => (
                <figure key={it.path} data-path={it.path} className={`thumb-tile ${current?.path === it.path ? "cursor" : ""} ${flagOf(it) ?? ""}`}
                        onClick={() => setCursor(it.path)} onDoubleClick={() => { setCursor(it.path); setLoupe(true); }}>
                  <img src={backend.fileUrl(it.path)} alt="" loading="lazy" draggable={false} />
                  <figcaption>
                    <span className="fname">{it.name}</span>
                    {flagOf(it) === "approved" && <span className="flag approved">✓ {songName(inbox[it.path]?.song_id)}</span>}
                    {flagOf(it) === "rejected" && <span className="flag rejected">✕</span>}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </main>

      <aside className="inbox-detail">
        {current ? (
          <>
            {!loupe && <img className="preview" src={backend.fileUrl(current.path)} alt="" />}
            <strong className="fname">{current.name}</strong>
            <span className="muted small">{new Date(current.modified_ms).toLocaleString()} · {(current.size / 1e6).toFixed(1)} MB</span>
            <label className="field">
              <span className="field-label">FOR SONG</span>
              <select value={songId} onChange={(e) => setSongId(e.target.value)}>
                <option value="">Choose song…</option>
                {show.set_order.map((id, i) => <option key={id} value={id}>{i < 9 ? `${i + 1} · ` : ""}{show.songs[id].fields.name}</option>)}
                {show.archive.length > 0 && <optgroup label="Archive">{show.archive.map((id) => <option key={id} value={id}>{show.songs[id].fields.name}</option>)}</optgroup>}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={makeHero} onChange={() => setMakeHero(!makeHero)} /> Make it the song's hero</label>
            <div className="row-actions">
              <button className="primary" onClick={() => approve(current)}>Approve (P)</button>
              <button onClick={() => reject(current)}>Reject (X)</button>
              {flagOf(current) && <button className="link" onClick={() => clear(current)}>Clear (U)</button>}
            </div>
            {message && <p className="muted small">{message}</p>}
          </>
        ) : <p className="muted">Select a render.</p>}
      </aside>
    </div>
  );
}

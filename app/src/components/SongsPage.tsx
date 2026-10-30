// The running order as cards (or a list, or presented one song at a time: PresentPage). Drag a card to reorder; the others slide out of the way.
// Drop on Archive to take a song out of the set, drag an archived song back to restore it. Archived songs are cards (or rows) too, unnumbered.
// Each card shows the show's note fields (Lighting, Camera…) and what media the song has.
// The bar at the top searches the songs; when nothing matches, Enter adds what was typed as a new song.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend } from "../backend";
import {
  addCustomField, addSongWith, archiveSong, DEFAULT_SET_LIST_FORMAT, deleteSong, fieldLabel, moveSong, noteFields, parseSetList,
  SET_LIST_FIELDS, type FieldKind, type SetListField,
  hasColumn, openReviews, parseTc, restoreSong, songAudio, songRecords,
} from "../model/ops";
import { swatchFill } from "../model/gels";
import type { Show, Song } from "../model/types";
import { useStore } from "../store";
import { PresentPage } from "./PresentPage";
import { ReaperButton } from "./ReaperExport";
import { CommentBadge } from "./Review";
import { SongSaveMenu } from "./SaveCopy";
import { Icon } from "./icons";
import { FIELD_KINDS, localOptions, OptionsEditor } from "./fields";

const FIELD_SUGGESTIONS: { label: string; kind: FieldKind; options?: string[] }[] = [
  { label: "Automation", kind: "longtext" }, { label: "Video", kind: "longtext" }, { label: "Content", kind: "longtext" },
  { label: "SFX", kind: "longtext" }, { label: "Staging", kind: "longtext" }, { label: "MD", kind: "longtext" },
  { label: "Laser colour", kind: "palette" }, { label: "Automation trim", kind: "choice", options: ["Out", "Trim 1", "Trim 2", "Deck"] },
];

interface DragState {
  id: string;
  from: "set" | "archive";
  x0: number;
  y0: number;
  started: boolean;
  offX: number;
  offY: number;
  ghost: HTMLElement | null;
  lastTarget: string | null;
  lastAt: number;
}

export function SongsPage() {
  const show = useStore((s) => s.show)!;
  const layout = useStore((s) => s.songsLayout);
  const drawerSongId = useStore((s) => s.drawerSongId);
  const { update, setSongsLayout, focusSong, startImport, toast } = useStore.getState();
  const [preview, setPreviewState] = useState<string[] | null>(null);
  const previewRef = useRef<string[] | null>(null);
  const setPreview = (next: string[] | null) => { previewRef.current = next; setPreviewState(next); };
  const [dragId, setDragId] = useState<string | null>(null);
  const [archiveOver, setArchiveOver] = useState(false);
  const [restoreTarget, setRestoreState] = useState<{ id: string; after: boolean } | null>(null);
  const restoreRef = useRef<{ id: string; after: boolean } | null>(null);
  const setRestoreTarget = (t: { id: string; after: boolean } | null) => { restoreRef.current = t; setRestoreState(t); };
  const [modal, setModal] = useState<"paste" | "field" | null>(null);
  const [query, setQuery] = useState("");
  const addRef = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const rects = useRef<Map<string, DOMRect> | null>(null);
  const suppressClick = useRef(false);

  const order = preview ?? show.set_order;
  const n = show.set_order.length;
  const typed = splitTyped(query);
  const searching = Boolean(typed.name);
  const hits = (ids: string[]) => (searching ? ids.filter((id) => songMatches(show.songs[id], typed.name)) : ids);
  const shown = hits(order);
  const shownArchive = hits(show.archive);
  const noMatch = searching && shown.length === 0 && shownArchive.length === 0;
  // The archive's cards line up with the set's: as many columns as the set has, though its box is a little narrower.
  const [cols, setCols] = useState(0);
  useEffect(() => {
    const el = cardsRef.current;
    if (!el || layout !== "grid") return;
    const count = () => setCols(getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout, n === 0]);
  // FLIP: slide cards from where they were to where the new preview order puts them.
  useLayoutEffect(() => {
    const before = rects.current;
    rects.current = null;
    if (!before || !cardsRef.current) return;
    for (const el of cardsRef.current.querySelectorAll<HTMLElement>("[data-card-id]")) {
      const id = el.dataset.cardId!;
      const a = before.get(id);
      if (!a || id === drag.current?.id) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth;
      el.style.transition = "transform .24s cubic-bezier(.2,.7,.2,1)";
      el.style.transform = "";
    }
  }, [preview]);

  function measure() {
    const m = new Map<string, DOMRect>();
    cardsRef.current?.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => m.set(el.dataset.cardId!, el.getBoundingClientRect()));
    rects.current = m;
  }

  function onPointerDown(e: React.PointerEvent, id: string, from: "set" | "archive") {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button:not(.grip), input, select, textarea")) return;
    drag.current = { id, from, x0: e.clientX, y0: e.clientY, started: false, offX: 0, offY: 0, ghost: null, lastTarget: null, lastAt: 0 };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      const el = document.querySelector<HTMLElement>(`[data-drag-id="${CSS.escape(d.id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      d.started = true;
      d.offX = d.x0 - r.left;
      d.offY = d.y0 - r.top;
      d.ghost = el.cloneNode(true) as HTMLElement;
      d.ghost.classList.add("drag-ghost");
      Object.assign(d.ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
      document.body.appendChild(d.ghost);
      document.body.classList.add("is-dragging");
      setDragId(d.id);
      if (d.from === "set") setPreview([...useStore.getState().show!.set_order]);
    }
    d.ghost!.style.left = `${e.clientX - d.offX}px`;
    d.ghost!.style.top = `${e.clientY - d.offY}px`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    setArchiveOver(d.from === "set" && Boolean(under?.closest(".archive")));
    const card = under?.closest<HTMLElement>(".cards [data-card-id], .list [data-card-id]");
    if (!card || card.dataset.cardId === d.id) return d.from === "archive" && !card ? setRestoreTarget(null) : undefined;
    const box = card.getBoundingClientRect();
    const after = useStore.getState().songsLayout === "grid" ? e.clientX > box.left + box.width / 2 : e.clientY > box.top + box.height / 2;
    const targetId = card.dataset.cardId!;
    if (d.from === "archive") return setRestoreTarget({ id: targetId, after });
    const now = performance.now();
    if (d.lastTarget === targetId && now - d.lastAt < 220) return;
    const cur = previewRef.current;
    if (!cur) return;
    const next = cur.filter((x) => x !== d.id);
    next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, d.id);
    if (next.join() === cur.join()) return;
    d.lastTarget = targetId;
    d.lastAt = now;
    measure();
    setPreview(next);
  }

  function onUp(e: PointerEvent) {
    window.removeEventListener("pointermove", onMove);
    const d = drag.current;
    drag.current = null;
    if (!d?.started) return;
    d.ghost?.remove();
    document.body.classList.remove("is-dragging");
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, 50);
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const current = useStore.getState().show!;
    if (d.from === "set" && under?.closest(".archive")) {
      update((s) => archiveSong(s, d.id));
      toast(`${current.songs[d.id]?.fields.name || "Song"} moved to the archive`);
    } else if (d.from === "set") {
      const cur = previewRef.current;
      if (cur && cur.join() !== current.set_order.join()) update((s) => moveSong(s, d.id, "set_order", cur.indexOf(d.id)));
    } else if (under?.closest(".cards, .list")) {
      const t = restoreRef.current;
      const target = t && current.set_order.indexOf(t.id) >= 0 ? current.set_order.indexOf(t.id) + (t.after ? 1 : 0) : current.set_order.length;
      update((s) => moveSong(s, d.id, "set_order", target));
    }
    setPreview(null);
    setDragId(null);
    setArchiveOver(false);
    setRestoreTarget(null);
  }

  const open = (id: string, field?: string) => {
    if (!suppressClick.current) focusSong(id, field);
  };

  function addFromBar() {
    if (!typed.name) return;
    update((s) => { addSongWith(s, typed.name, typed.tc); });
    toast(`Added ${typed.name}`);
    setQuery("");
  }

  async function fromShowAudio() {
    const paths = await backend.chooseFiles("audio", false);
    if (paths.length) startImport(paths);
  }

  const toggle = (
    <div className="seg">
      <button className={layout === "grid" ? "on" : ""} onClick={() => setSongsLayout("grid")}><Icon name="grid" size="sm" /> Cards</button>
      <button className={layout === "list" ? "on" : ""} onClick={() => setSongsLayout("list")}><Icon name="list" size="sm" /> List</button>
      <button className={layout === "present" ? "on" : ""} onClick={() => setSongsLayout("present")}><Icon name="slides" size="sm" /> Present</button>
    </div>
  );
  if (layout === "present") return <PresentPage toggle={toggle} />;

  const dropClass = (id: string) => (restoreTarget?.id === id ? (restoreTarget.after ? "drop-after" : "drop-before") : "");

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Running order</h1><div className="sub">{n ? "Drag to reorder" : "Add the songs in the set"}</div></div>
        <div className="acts">
          {n > 0 && <ReaperButton />}
          {toggle}
        </div>
      </div>

      <div className="addbar">
        <span className="plus"><Icon name={n ? "search" : "plus"} /></span>
        <input ref={addRef} autoFocus={n === 0} value={query} aria-label="Search or add a song"
               placeholder={n ? "Search songs, or add one (name, then TC if you have it)" : "Add a song (name, then TC if you have it)"}
               onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === "Enter" && noMatch) addFromBar();
                 else if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); }
               }} />
        {query && <button className="icon" title="Clear the search (Esc)" onClick={() => { setQuery(""); addRef.current?.focus(); }}><Icon name="x" size="sm" /></button>}
        {searching && !noMatch && <button className="ghost sm" title={`Add “${typed.name}” even though other songs match`} onClick={addFromBar}><Icon name="plus" size="sm" /> Add as new</button>}
        {noMatch && <button className="primary sm" onClick={addFromBar}><Icon name="plus" size="sm" /> Add “{typed.name}”{typed.tc && ` at ${typed.tc}`} <span className="kbd">↵</span></button>}
        <span className="sep" />
        <button className="ghost sm" onClick={() => setModal("paste")}><Icon name="copy" size="sm" /> Paste set list</button>
        <button className="ghost sm" onClick={fromShowAudio}><Icon name="radio" size="sm" /> From show audio</button>
      </div>

      {n === 0 && show.archive.length === 0 ? (
        <div className="empty">
          <div className="ic"><Icon name="music" size="xl" /></div>
          <h3>No songs yet</h3>
          <p>Type them above, paste a list, or read them from the show audio.</p>
          <div className="opts">
            <button onClick={() => setModal("paste")}><Icon name="copy" /> Paste a set list</button>
            <button onClick={fromShowAudio}><Icon name="radio" /> From show audio</button>
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar2">
            {searching
              ? <div className="stats">{noMatch ? <span>No songs match “{typed.name}”. Press <span className="kbd">↵</span> to add it to the set.</span>
                                                  : <span><b>{shown.length + shownArchive.length}</b> of {n + show.archive.length} songs match</span>}</div>
              : <Stats show={show} />}
          </div>

          {layout === "grid" ? (
            <div className="cards" ref={cardsRef}>
              {shown.map((id) => (
                <SongCard key={id} show={show} song={show.songs[id]} position={order.indexOf(id) + 1} last={order.indexOf(id) === order.length - 1}
                          selected={drawerSongId === id} placeholder={dragId === id} dropClass={dropClass(id)}
                          onPointerDown={(e) => onPointerDown(e, id, "set")} onOpen={(field) => open(id, field)} />
              ))}
              {noMatch
                ? <button className="ghost-card" onClick={addFromBar}><div><Icon name="plus" size="lg" />Add “{typed.name}”</div></button>
                : !searching && <button className="ghost-card" onClick={() => addRef.current?.focus()}><div><Icon name="plus" size="lg" />Add song</div></button>}
            </div>
          ) : (
            <div className="list" ref={cardsRef}>
              {shown.map((id) => (
                <SongRow key={id} show={show} song={show.songs[id]} position={order.indexOf(id) + 1} selected={drawerSongId === id} placeholder={dragId === id}
                         dropClass={dropClass(id)} onPointerDown={(e) => onPointerDown(e, id, "set")} onOpen={() => open(id)} />
              ))}
            </div>
          )}

          {(!searching || shownArchive.length > 0) && <div className={`archive ${archiveOver ? "over" : ""}`}>
            <h3><Icon name="archive" /> Archive</h3>
            <div className="hint">Drag songs here to take them out of the set</div>
            <div className={`pool ${layout === "grid" ? "pool-cards" : "pool-rows"}`} style={layout === "grid" && cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
              {shownArchive.map((id) => layout === "grid"
                ? <SongCard key={id} show={show} song={show.songs[id]} position={null} last selected={drawerSongId === id} placeholder={dragId === id} dropClass=""
                            onPointerDown={(e) => onPointerDown(e, id, "archive")} onOpen={(field) => open(id, field)} onRestore={() => update((s) => restoreSong(s, id))} />
                : <SongRow key={id} show={show} song={show.songs[id]} position={null} selected={drawerSongId === id} placeholder={dragId === id} dropClass=""
                           onPointerDown={(e) => onPointerDown(e, id, "archive")} onOpen={() => open(id)} onRestore={() => update((s) => restoreSong(s, id))} />)}
            </div>
          </div>}

          <div className="songs-foot">
            <button className="sm" onClick={() => setModal("field")}><Icon name="plus" size="sm" /> Custom field</button>
          </div>
        </>
      )}

      {modal === "paste" && <PasteDialog onClose={() => setModal(null)} />}
      {modal === "field" && <NoteFieldDialog onClose={() => setModal(null)} />}
    </div>
  );
}

/** What's typed in the bar: a song name, then a TC if there is one ("Opener 01:00:00:00", "Opener, 1:00"). */
function splitTyped(text: string): { name: string; tc: string } {
  const v = text.trim();
  const m = v.match(/^(.*?)[,\s]+(\d{1,2}:\d{2}(?::\d{2}:\d{2})?)\s*$/);
  return { name: (m ? m[1] : v).replace(/,\s*$/, "").trim() || v, tc: m ? parseTc(m[2]) ?? "" : "" };
}

/** A song matches a search when its name, or any of its fields (TC, audio version, notes…), contains every word typed. */
function songMatches(song: Song | undefined, q: string): boolean {
  if (!song) return false;
  const text = Object.values(song.fields).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => text.includes(w));
}

function Stats({ show }: { show: Show }) {
  const ids = show.set_order;
  const tc = ids.filter((id) => show.songs[id]?.fields.tc).length;
  const clips = ids.filter((id) => (show.songs[id]?.clips ?? []).length > 0).length;
  return (
    <div className="stats">
      <span><b>{ids.length}</b> songs</span><i>·</i><span><b>{tc}</b> with timecode</span><i>·</i>
      <span><b>{clips}</b> with clips</span><i>·</i><span><b>{show.archive.length}</b> archived</span>
    </div>
  );
}

interface CardProps {
  show: Show;
  song: Song;
  /** Place in the running order; null for an archived song. */
  position: number | null;
  selected: boolean;
  placeholder: boolean;
  dropClass: string;
  onPointerDown: (e: React.PointerEvent) => void;
  /** Archived songs only: put it back at the end of the set. */
  onRestore?: () => void;
}

function SongCard({ show, song, position, last, selected, placeholder, dropClass, onPointerDown, onOpen, onRestore }: CardProps & { last: boolean; onOpen: (field?: string) => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const renders = (song.gallery ?? (song.hero ? [song.hero] : [])).length;
  const audio = songAudio(show, song.id)[0]?.version || song.fields.audio;
  const version = hasColumn(show, "audio") && audio; // shown while the show has AUDIO VERSION
  const clips = (song.clips ?? []).length + songRecords(show, song.id).length;
  return (
    <div className={["scard", position === null && "archived", selected && "sel", placeholder && "placeholder", dropClass].filter(Boolean).join(" ")}
         data-card-id={song.id} data-drag-id={song.id} data-song-id={song.id}
         onPointerDown={onPointerDown} onClick={() => onOpen()}>
      <div className="media" data-col="hero gallery">{song.hero ? <img src={backend.mediaUrl(bundle, song.hero)} alt="" draggable={false} /> : <div className="ph"><Icon name="music" /></div>}</div>
      <CommentBadge count={openReviews(show, song.id)} onClick={() => useStore.getState().focusSong(song.id, "comments")} />
      <SongSaveMenu show={show} bundle={bundle} song={song} />
      <button className="grip" title={position === null ? "Drag into the set" : "Drag to reorder"} tabIndex={-1}><Icon name="grip" size="sm" /></button>
      <div className="body">
        <div className="title">{position !== null && <span className="num" data-col="moved">{String(position).padStart(2, "0")}</span>}<span className="t" data-col="name">{song.fields.name || "Untitled"}</span></div>
        <div className="meta">
          {song.fields.tc ? <span className="chip tc" data-col="tc">{song.fields.tc}</span> : <span className="chip missing" data-col="tc">No TC</span>}
          {version && <span className="chip" data-col="audio">{version}</span>}
          {song.fields.bpm && <span className="chip" data-col="bpm">{song.fields.bpm} BPM</span>}
          {song.segues_into_next && <span className="chip accent" data-col="segues_into_next"><Icon name="link" size="sm" />Segue</span>}
        </div>
        <div className="notes">
          <button className={`nline ${song.colours.length ? "has" : ""}`} data-col="colours" onClick={(e) => { e.stopPropagation(); onOpen("colours"); }}
                  title={song.colours.map((c) => c.label || c.hex).join(", ")}>
            <span className="k">Colours</span>
            {song.colours.length
              ? <span className="card-swatches">{song.colours.map((c, i) => <span key={i} style={{ background: swatchFill(c) }} />)}</span>
              : <span className="v">+ Add</span>}
          </button>
        </div>
        <div className="foot">
          <span className={renders ? "on" : ""} data-col="gallery"><Icon name="image" />{renders || ""}</span>
          <span className={audio ? "on" : ""}><Icon name="music" /></span>
          <span className={clips ? "on" : ""} data-col="clips records"><Icon name="film" />{clips ? `${clips}` : ""}</span>
          {onRestore && <button className="icon restore" title="Back into the set" onClick={(e) => { e.stopPropagation(); onRestore(); }}><Icon name="undo" size="sm" /></button>}
        </div>
      </div>
      {song.segues_into_next && !last && <span className="segue" title="Segues into the next song"><Icon name="arrowR" /></span>}
    </div>
  );
}

function SongRow({ show, song, position, selected, placeholder, dropClass, onPointerDown, onOpen, onRestore }: CardProps & { onOpen: () => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const update = useStore((s) => s.update);
  const audio = songAudio(show, song.id)[0]?.version || song.fields.audio;
  const renders = (song.gallery ?? []).length || (song.hero ? 1 : 0);
  const clips = (song.clips ?? []).length;
  async function remove() {
    if (await backend.confirm(`Delete "${song.fields.name || "this song"}"?`)) update((s) => deleteSong(s, song.id));
  }
  return (
    <div className={["lrow", selected && "sel", placeholder && "placeholder", dropClass].filter(Boolean).join(" ")}
         data-card-id={song.id} data-drag-id={song.id} data-song-id={song.id} onPointerDown={onPointerDown} onClick={onOpen}>
      <button className="grip ghost" tabIndex={-1}><Icon name="grip" /></button>
      <span className="n" data-col="moved">{position !== null && String(position).padStart(2, "0")}</span>
      <span className="th">{song.hero ? <img src={backend.mediaUrl(bundle, song.hero)} alt="" draggable={false} /> : <span className="ph"><Icon name="music" /></span>}<CommentBadge count={openReviews(show, song.id)} /></span>
      <span className="nm"><span data-col="name">{song.fields.name || "Untitled"}</span>{song.segues_into_next && <span className="pill" data-col="segues_into_next">SEGUE</span>}</span>
      {song.fields.tc ? <span className="chip tc" data-col="tc">{song.fields.tc}</span> : <span className="chip missing" data-col="tc">No TC</span>}
      <span className="muted small" data-col="audio">{hasColumn(show, "audio") ? audio || "—" : ""}</span>
      <span className="icons"><span className={renders ? "on" : ""}><Icon name="image" /></span><span className={audio ? "on" : ""}><Icon name="music" /></span><span className={clips ? "on" : ""}><Icon name="film" /></span></span>
      <span><SongSaveMenu show={show} bundle={bundle} song={song} /></span>
      {onRestore
        ? <button className="icon" title="Back into the set" onClick={(e) => { e.stopPropagation(); onRestore(); }}><Icon name="undo" size="sm" /></button>
        : <button className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); remove(); }}><Icon name="trash" size="sm" /></button>}
    </div>
  );
}

const FORMAT_KEY = "pm.setListFormat";
const FIELD_NAMES: Record<SetListField, string> = { name: "Name", tc: "TC", bpm: "BPM", version: "Version" };
function savedFormat(): SetListField[] {
  try {
    const v = JSON.parse(localStorage.getItem(FORMAT_KEY) ?? "null");
    if (Array.isArray(v) && v.length && v.every((f) => SET_LIST_FIELDS.includes(f))) return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_SET_LIST_FORMAT;
}

function PasteDialog({ onClose }: { onClose: () => void }) {
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState("");
  const [format, setFormatState] = useState<SetListField[]>(savedFormat);
  const rows = parseSetList(text, format);
  const setFormat = (next: SetListField[]) => {
    setFormatState(next);
    try { localStorage.setItem(FORMAT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  /** Put `field` in slot `i` ("" clears it); a field already used elsewhere swaps into the old slot. */
  function pick(i: number, field: SetListField | "") {
    const next: (SetListField | "")[] = [...format];
    const was = next.indexOf(field as SetListField);
    if (field && was >= 0) next[was] = next[i] ?? "";
    next[i] = field;
    setFormat(next.filter((f): f is SetListField => Boolean(f)));
  }
  function add() {
    update((s) => { for (const r of rows) addSongWith(s, r.name, r.tc, r.version, r.bpm); });
    toast(`Added ${rows.length} song${rows.length === 1 ? "" : "s"}`);
    onClose();
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Paste a set list">
        <div className="modal-head"><div><h3>Paste a set list</h3><p>One song per line, in this order:</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <div className="format-row">
            {[0, 1, 2, 3].map((i) => (
              <select key={i} value={format[i] ?? ""} onChange={(e) => pick(i, e.target.value as SetListField | "")} disabled={i > format.length}>
                <option value="">—</option>
                {SET_LIST_FIELDS.map((f) => <option key={f} value={f}>{FIELD_NAMES[f]}</option>)}
              </select>
            ))}
            <button className="ghost sm" onClick={() => setFormat(DEFAULT_SET_LIST_FORMAT)}>Reset</button>
          </div>
          <textarea autoFocus className="mono" rows={9} value={text} onChange={(e) => setText(e.target.value)} style={{ fontSize: 12.5 }} />
          {rows.length > 0 && (
            <div className="paste-preview">
              {rows.map((r, i) => (
                <div key={i}><span className="n">{i + 1}</span><span className="nm">{r.name}</span>{r.tc && <span className="chip tc">{r.tc}</span>}{r.version && <span className="chip">{r.version}</span>}{r.bpm && <span className="chip">{r.bpm} BPM</span>}</div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!rows.length} onClick={add}>{rows.length ? `Add ${rows.length} song${rows.length === 1 ? "" : "s"}` : "Add songs"}</button></div>
      </div>
    </div>
  );
}

function NoteFieldDialog({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<FieldKind>("longtext");
  const [options, setOptions] = useState<string[]>([]);
  const hidden = show.columns.filter((c) => c.type === "longtext" && !c.on_card);
  const have = new Set([...noteFields(show), ...show.columns.filter((c) => c.type === "palette" || c.type === "choice")].map((c) => fieldLabel(c).toLowerCase()));
  const ready = Boolean(label.trim()) && (kind !== "choice" || options.length > 0);
  function add() {
    if (!ready) return;
    update((s) => { addCustomField(s, label.trim(), kind, options); });
    toast(`Added “${label.trim()}” to every song`);
    onClose();
  }
  function suggest(x: (typeof FIELD_SUGGESTIONS)[number]) {
    setLabel(x.label);
    setKind(x.kind);
    if (x.options) setOptions(x.options);
  }
  function showExisting(colId: string) {
    update((s) => { const c = s.columns.find((x) => x.id === colId); if (c) c.on_card = true; });
    onClose();
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-label="New custom field">
        <div className="modal-head"><div><h3>New custom field</h3><p>Added to every song, and editable in the Sheet.</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Field name" />
          <div className="seg kind-seg" role="radiogroup" aria-label="What the field holds">
            {FIELD_KINDS.map((k) => <button key={k.id} role="radio" aria-checked={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>{k.label}</button>)}
          </div>
          <p className="kind-hint">{FIELD_KINDS.find((k) => k.id === kind)!.hint}</p>
          {kind === "choice" && (
            <>
              <div className="label">Options</div>
              <OptionsEditor options={options} {...localOptions(options, setOptions)} />
            </>
          )}
          <div className="chips" style={{ marginTop: 12 }}>
            {FIELD_SUGGESTIONS.filter((x) => !have.has(x.label.toLowerCase())).map((x) => <button key={x.label} className="sm" onClick={() => suggest(x)}>{x.label}</button>)}
          </div>
          {hidden.length > 0 && (
            <>
              <div className="label" style={{ marginTop: 16 }}>Or show an existing column</div>
              <div className="chips">{hidden.map((c) => <button key={c.id} className="sm ghost" onClick={() => showExisting(c.id)}>{fieldLabel(c)}</button>)}</div>
            </>
          )}
        </div>
        <div className="modal-foot"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!ready} onClick={add}>Add field</button></div>
      </div>
    </div>
  );
}

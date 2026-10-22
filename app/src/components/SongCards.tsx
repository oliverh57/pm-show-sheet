// The running order as cards. Drag the ⋮⋮ handle (or ⌥↑/⌥↓) to reorder; drop below the
// archive header to archive. Each card shows what's been added to the song so gaps stand out.
import { useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import { textOn } from "../model/gels";
import { addSong, cellValue, moveSong, showAudio, showRecords, songAudio, songRecords } from "../model/ops";
import type { ListName, Show, Song } from "../model/types";
import { SHOW_ID, useStore } from "../store";

interface Drag {
  songId: string;
  overId: string | null; // a song id, or "__set_end" / "__archive_start"
  after: boolean;
}

export function SongCards() {
  const show = useStore((s) => s.show)!;
  const selected = useStore((s) => s.selectedSongId);
  const select = useStore((s) => s.select);
  const update = useStore((s) => s.update);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const order = useMemo(() => [...show.set_order, ...(archiveOpen ? show.archive : [])], [show, archiveOpen]);

  function targetAt(clientY: number): { id: string; after: boolean } | null {
    const els = listRef.current?.querySelectorAll<HTMLElement>("[data-drop]") ?? [];
    for (const el of els) {
      const box = el.getBoundingClientRect();
      if (clientY >= box.top && clientY <= box.bottom) return { id: el.dataset.drop!, after: clientY > box.top + box.height / 2 };
    }
    return null;
  }

  function drop() {
    if (!drag?.overId || drag.overId === drag.songId) return setDrag(null);
    const { songId, overId, after } = drag;
    setDrag(null);
    let list: ListName;
    let index: number;
    if (overId === "__set_end") {
      list = "set_order";
      index = show.set_order.filter((x) => x !== songId).length;
    } else if (overId === "__archive_start") {
      list = after ? "archive" : "set_order";
      index = after ? 0 : show.set_order.filter((x) => x !== songId).length;
    } else {
      list = show.set_order.includes(overId) ? "set_order" : "archive";
      index = show[list].indexOf(overId) + (after ? 1 : 0);
      const from = show[list].indexOf(songId);
      if (from >= 0 && from < index) index -= 1;
    }
    update((s) => moveSong(s, songId, list, index));
  }

  function nudge(songId: string, delta: number) {
    const list: ListName = show.set_order.includes(songId) ? "set_order" : "archive";
    const i = show[list].indexOf(songId);
    const j = i + delta;
    if (j < 0 || j >= show[list].length) return;
    update((s) => moveSong(s, songId, list, j));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey && selected && selected !== SHOW_ID) return nudge(selected, delta);
    const ids = [SHOW_ID, ...order];
    const i = ids.indexOf(selected ?? SHOW_ID);
    select(ids[Math.max(0, Math.min(ids.length - 1, i + delta))]);
  }

  const card = (id: string, position: number, archived: boolean) => (
    <SongCard key={id} show={show} song={show.songs[id]} position={position} archived={archived}
              selected={selected === id} dragging={drag?.songId === id}
              dropClass={drag?.overId === id ? (drag.after ? "drop-after" : "drop-before") : ""}
              onSelect={() => select(id)}
              onGripDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                setDrag({ songId: id, overId: null, after: false });
                select(id);
              }}
              onGripMove={(e) => {
                if (!drag) return;
                const hit = targetAt(e.clientY);
                setDrag({ ...drag, overId: hit?.id ?? null, after: hit?.after ?? false });
              }}
              onGripUp={drop} />
  );

  return (
    <div className="cards" ref={listRef} tabIndex={0} onKeyDown={onKeyDown}>
      <ShowCard show={show} selected={selected === SHOW_ID} onSelect={() => select(SHOW_ID)} />

      <div className="cards-head">
        <span>RUNNING ORDER</span><span className="muted">{show.set_order.length} songs</span>
      </div>
      {show.set_order.map((id, i) => card(id, i + 1, false))}
      <AddSong list="set_order" dropId="__set_end" dropClass={drag?.overId === "__set_end" ? "drop-before" : ""} />

      <button className={`cards-head archive-head ${drag?.overId === "__archive_start" ? (drag.after ? "drop-after" : "drop-before") : ""}`}
              data-drop="__archive_start" onClick={() => setArchiveOpen(!archiveOpen)}>
        <span>{archiveOpen ? "▾" : "▸"} SONG ARCHIVE</span><span className="muted">{show.archive.length} songs</span>
      </button>
      {archiveOpen && show.archive.map((id, i) => card(id, i + 1, true))}
      {archiveOpen && <AddSong list="archive" />}
      <p className="muted small cards-hint">Drag ⋮⋮ to reorder · ⌥↑ ⌥↓ moves the selected song · drop files from Finder onto a card</p>
    </div>
  );
}

function ShowCard({ show, selected, onSelect }: { show: Show; selected: boolean; onSelect: () => void }) {
  const records = showRecords(show).length;
  const audio = showAudio(show)[0];
  const folders = (show.watch_folders ?? []).length;
  return (
    <button className={`show-card ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="show-card-title">SHOW MEDIA</span>
      <span className="chips">
        <Chip n={records} label="show record" />
        {audio ? <span className="chip on">AUDIO {audio.version}</span> : <span className="chip">no show audio</span>}
        <Chip n={folders} label="watch folder" />
      </span>
    </button>
  );
}

function Chip({ n, label }: { n: number; label: string }) {
  return <span className={`chip ${n ? "on" : ""}`}>{n || "no"} {label}{n === 1 ? "" : "s"}</span>;
}

interface CardProps {
  show: Show;
  song: Song;
  position: number;
  archived: boolean;
  selected: boolean;
  dragging: boolean;
  dropClass: string;
  onSelect: () => void;
  onGripDown: (e: React.PointerEvent) => void;
  onGripMove: (e: React.PointerEvent) => void;
  onGripUp: () => void;
}

function SongCard({ show, song, position, archived, selected, dragging, dropClass, onSelect, onGripDown, onGripMove, onGripUp }: CardProps) {
  const bundle = useStore((s) => s.bundle)!;
  const tcCol = show.columns.find((c) => c.type === "tc");
  const tc = tcCol ? String(cellValue(show, tcCol, song)) : "";
  const ticks = show.columns.filter((c) => c.type === "tick");
  const renders = (song.gallery ?? (song.hero ? [song.hero] : [])).length;
  const audio = songAudio(show, song.id);
  const records = songRecords(show, song.id).length;
  const notes = show.sessions.reduce((n, s) => n + s.notes.filter((x) => x.song_id === song.id && !x.done).length, 0);

  return (
    <div className={["card", selected && "selected", archived && "archived", dragging && "dragging", dropClass].filter(Boolean).join(" ")}
         data-drop={song.id} data-song-id={song.id} onMouseDown={onSelect}>
      <div className="grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} title="Drag to reorder">⋮⋮</div>
      <div className="card-main">
        <div className="card-title">
          <span className="pos">{position}</span>
          {song.fields.num && <span className="num">#{song.fields.num}</span>}
          <span className="name">{song.fields.name || <em className="muted">Untitled</em>}</span>
        </div>
        <div className="card-meta">
          {tc && <span className="mono">{tc}</span>}
          {(audio[0]?.version || song.fields.audio) && <span className="chip on">AUDIO {audio[0]?.version || song.fields.audio}</span>}
          {song.segues_into_next && <span className="muted">→ segues</span>}
        </div>
        <div className="card-meta">
          {ticks.map((t) => <span key={t.id} className={`dot ${song.statuses[t.id] ? "on" : ""}`}>{t.label}</span>)}
          {song.colours.map((c, i) => <span key={i} className="mini-swatch" style={{ background: c.hex, color: textOn(c.hex) }}>{c.label}</span>)}
        </div>
        <div className="chips">
          <Chip n={renders} label="render" />
          <Chip n={audio.length} label="audio file" />
          <Chip n={records} label="record" />
          {notes > 0 && <span className="chip warn">{notes} open note{notes === 1 ? "" : "s"}</span>}
        </div>
      </div>
      <div className="card-thumb">
        {song.hero ? <img src={backend.mediaUrl(bundle, song.hero)} alt="" draggable={false} /> : <span>NO RENDER</span>}
      </div>
    </div>
  );
}

function AddSong({ list, dropId, dropClass = "" }: { list: ListName; dropId?: string; dropClass?: string }) {
  const update = useStore((s) => s.update);
  const select = useStore((s) => s.select);
  const [name, setName] = useState("");
  function add() {
    if (!name.trim()) return;
    let id = "";
    update((s) => { id = addSong(s, list, undefined, name.trim()); });
    select(id);
    setName("");
  }
  return (
    <div className={`add-song ${dropClass}`} data-drop={dropId}>
      <input placeholder={list === "archive" ? "+ Add a song to the archive" : "+ Add a song (type a name, Enter)"} value={name}
             onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
    </div>
  );
}

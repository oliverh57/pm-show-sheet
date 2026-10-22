// Song workspace sections that edit one song: details, colours, renders, notes.
import { useState } from "react";
import { backend } from "../backend";
import { GELS, searchGels, textOn } from "../model/gels";
import {
  addImages, addNote, addSession, archiveSong, deleteNote, deleteSong, isTextColumn, listOf,
  MAX_SWATCHES, removeImage, restoreSong, setField, setHero, toggleStatus,
} from "../model/ops";
import type { Show, Song } from "../model/types";
import { SHOW_ID, useStore } from "../store";
import { DraftInput } from "./fields";

export function Overview({ show, song }: { show: Show; song: Song }) {
  const update = useStore((s) => s.update);
  const select = useStore((s) => s.select);
  const archived = listOf(show, song.id) === "archive";
  const ticks = show.columns.filter((c) => c.type === "tick");
  const textCols = show.columns.filter(isTextColumn);

  async function remove() {
    if (await backend.confirm(`Delete "${song.fields.name || "this song"}"? Its notes stay, unlinked from any song.`)) {
      const next = show.set_order.find((id) => id !== song.id) ?? null;
      update((s) => deleteSong(s, song.id));
      select(next ?? SHOW_ID);
    }
  }

  return (
    <div className="stack">
      {ticks.length > 0 && (
        <div className="ticks">
          {ticks.map((c) => (
            <label key={c.id} className={`tick-chip ${song.statuses[c.id] ? "on" : ""}`}>
              <input type="checkbox" checked={Boolean(song.statuses[c.id])} onChange={() => update((s) => toggleStatus(s, song.id, c.id))} />
              {c.label}
            </label>
          ))}
        </div>
      )}
      {textCols.map((c) => (
        <label key={c.id} className="field">
          <span className={`field-label dept-text-${c.dept}`}>{c.editable ? "✎ " : ""}{c.label}</span>
          <DraftInput value={song.fields[c.id] ?? ""} multiline={c.type === "longtext"} mono={c.type === "tc"}
                      placeholder={c.type === "tc" ? "HH:MM:SS:FF" : ""}
                      onCommit={(v) => update((s) => setField(s, song.id, c.id, v))} />
        </label>
      ))}
      <label className="check">
        <input type="checkbox" checked={Boolean(song.segues_into_next)}
               onChange={() => update((s) => { s.songs[song.id].segues_into_next = !s.songs[song.id].segues_into_next; })} />
        Segues into the next song (next song's TC shows "Cont.")
      </label>
      <div className="row-actions">
        {archived
          ? <button onClick={() => update((s) => restoreSong(s, song.id))}>Restore to set list</button>
          : <button onClick={() => update((s) => archiveSong(s, song.id))}>Move to archive</button>}
        <button className="danger" onClick={remove}>Delete song</button>
      </div>
    </div>
  );
}

export function Colours({ song }: { song: Song }) {
  const update = useStore((s) => s.update);
  const [query, setQuery] = useState("");
  const full = song.colours.length >= MAX_SWATCHES;
  const gels = searchGels(query);

  const edit = (fn: (s: Song) => void) => update((show) => fn(show.songs[song.id]));

  return (
    <div className="stack">
      <div className="swatches">
        {song.colours.map((sw, i) => (
          <div key={i} className="swatch-edit">
            <label className="swatch" style={{ background: sw.hex, color: textOn(sw.hex) }} title="Pick a custom colour">
              <input type="color" value={sw.hex} onChange={(e) => edit((s) => { s.colours[i].hex = e.target.value.toUpperCase(); })} />
              {sw.label}
            </label>
            <DraftInput value={sw.label ?? ""} placeholder="Label" onCommit={(v) => edit((s) => { s.colours[i].label = v; })} />
            <div className="swatch-tools">
              <button className="icon" disabled={i === 0} onClick={() => edit((s) => { [s.colours[i - 1], s.colours[i]] = [s.colours[i], s.colours[i - 1]]; })}>←</button>
              <button className="icon" onClick={() => edit((s) => { s.colours.splice(i, 1); })} title="Remove">×</button>
            </div>
          </div>
        ))}
        {song.colours.length === 0 && <p className="muted">No colours yet. Pick from the gel library below.</p>}
      </div>
      <label className="field">
        <span className="field-label">COLOUR REF</span>
        <DraftInput value={song.fields.colref ?? ""} placeholder="e.g. Red then sea green"
                    onCommit={(v) => update((s) => setField(s, song.id, "colref", v))} />
      </label>
      <div className="gel-head">
        <span className="field-label">GEL LIBRARY {full && <em className="muted">(max {MAX_SWATCHES} swatches)</em>}</span>
        <input className="search" placeholder="Search L201, CTB, congo…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="gels">
        {gels.map((g) => (
          <button key={g.code} className="gel" disabled={full} title={`${g.code} ${g.name}`}
                  onClick={() => edit((s) => { s.colours.push({ hex: g.hex, label: g.code }); })}>
            <span className="gel-chip" style={{ background: g.hex }} />
            <span className="gel-code">{g.code}</span>
            <span className="gel-name">{g.name}</span>
          </button>
        ))}
        <button className="gel" disabled={full} onClick={() => edit((s) => { s.colours.push({ hex: "#808080", label: "" }); })}>
          <span className="gel-chip custom">+</span><span className="gel-code">Custom</span><span className="gel-name">Any hex</span>
        </button>
      </div>
      <p className="muted small">Swatch colours are approximate ({GELS.length} gels). Eyedropping from a render comes with the render inbox.</p>
    </div>
  );
}

export function Media({ song }: { song: Song }) {
  const bundle = useStore((s) => s.bundle)!;
  const update = useStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  const gallery = song.gallery ?? (song.hero ? [song.hero] : []);

  async function choose() {
    setError(null);
    try {
      const paths = await backend.chooseImages();
      const rels = await Promise.all(paths.map((p) => backend.importMedia(bundle, p, "renders")));
      if (rels.length) update((s) => addImages(s, song.id, rels));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="stack">
      {song.hero && <div className="hero-box"><img src={backend.mediaUrl(bundle, song.hero)} alt="" /></div>}
      <div className="dropzone">
        {backend.isDesktop ? (song.hero ? "Drop more renders here or onto the song's card" : "No render yet. Drop images here or onto the song's card") : "Adding images needs the desktop app"}
        {backend.isDesktop && <button onClick={choose}>Choose images…</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {gallery.length > 0 && (
        <div className="gallery">
          {gallery.map((p) => (
            <figure key={p} className={p === song.hero ? "is-hero" : ""}>
              <img src={backend.mediaUrl(bundle, p)} alt="" />
              <figcaption>
                {p === song.hero ? <span className="pill">HERO</span>
                  : <button className="link" onClick={() => update((s) => setHero(s, song.id, p))}>Make hero</button>}
                <button className="link" onClick={() => update((s) => removeImage(s, song.id, p))}>Remove</button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="muted small">Images are copied into the show's media/renders folder. The hero is what the Sheet and slide show.</p>
    </div>
  );
}

export function Notes({ show, song }: { show: Show; song: Song }) {
  const update = useStore((s) => s.update);
  const [sessionId, setSessionId] = useState(show.sessions[show.sessions.length - 1]?.id ?? "");
  const [text, setText] = useState("");
  const [newSession, setNewSession] = useState("");

  const notesBySession = show.sessions.map((s) => ({ session: s, notes: s.notes.filter((n) => n.song_id === song.id) }));

  function add() {
    if (!text.trim() || !sessionId) return;
    update((s) => { addNote(s, sessionId, song.id, text.trim()); });
    setText("");
  }

  function createSession() {
    if (!newSession.trim()) return;
    let id = "";
    update((s) => { id = addSession(s, newSession.trim()); });
    setSessionId(id);
    setNewSession("");
  }

  const editNote = (noteId: string, fn: (n: Show["sessions"][number]["notes"][number]) => void) =>
    update((s) => { for (const ses of s.sessions) for (const n of ses.notes) if (n.id === noteId) fn(n); });

  return (
    <div className="stack">
      <div className="note-add">
        <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          {show.sessions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input placeholder="New note for this song… (Enter)" value={text} onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && add()} />
      </div>
      <div className="note-add">
        <input placeholder="New session, e.g. 17/10 AM RUN" value={newSession} onChange={(e) => setNewSession(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && createSession()} />
        <button onClick={createSession}>Add session</button>
      </div>
      {notesBySession.map(({ session, notes }) => notes.length > 0 && (
        <section key={session.id} className="note-group">
          <h3>{session.label}</h3>
          {notes.map((n) => (
            <div key={n.id} className={`note ${n.done ? "done" : ""}`}>
              <input type="checkbox" checked={n.done} onChange={() => editNote(n.id, (x) => { x.done = !x.done; })} title="Done" />
              <div className="note-main">
                <DraftInput value={n.text} multiline onCommit={(v) => editNote(n.id, (x) => { x.text = v; })} />
                <div className="note-meta">
                  <DraftInput value={n.tc} placeholder="TC" mono onCommit={(v) => editNote(n.id, (x) => { x.tc = v; })} />
                  <DraftInput value={n.from} placeholder="From" onCommit={(v) => editNote(n.id, (x) => { x.from = v; })} />
                  <DraftInput value={n.assignee} placeholder="Assigned to" onCommit={(v) => editNote(n.id, (x) => { x.assignee = v; })} />
                  {n.source === "sheet" && <span className="pill">FROM SHEET</span>}
                  <button className="icon" onClick={() => update((s) => deleteNote(s, n.id))} title="Delete note">×</button>
                </div>
              </div>
            </div>
          ))}
        </section>
      ))}
      {notesBySession.every((g) => g.notes.length === 0) && <p className="muted">No notes for this song yet.</p>}
    </div>
  );
}

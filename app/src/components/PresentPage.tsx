// Present: the running order one song at a time. The song's images, clips and records in a big viewer, its audio
// playable, and every field laid out by category and editable in place. The songs run along the bottom; ← → move.
// The media and audio on screen can be saved (downloaded), as from the media viewer. The side panel's Comments tab
// has the comments on the image or clip on screen (as in the media viewer); the thumbnails show which have open ones.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { backend } from "../backend";
import { deptColour, deptList, deptName, fieldLabel, fieldSwatches, isFieldColumn, openReviews, setField, songAudio, toggleStatus } from "../model/ops";
import { swatchFill } from "../model/gels";
import type { ColourSwatch, ColumnDef, Show, Song } from "../model/types";
import { useStore } from "../store";
import { DraftInput, FieldInput } from "./fields";
import { Icon } from "./icons";
import { infoLine } from "./MediaLists";
import { itemComments, mediaOf, reviewTarget } from "./MediaViewer";
import { MediaPlayer } from "./Player";
import { CommentBadge, Review } from "./Review";
import { SaveCopy, SongSaveMenu } from "./SaveCopy";
import { Colours, FieldSwatches } from "./SongSections";

const CORE_FIELDS = new Set(["num", "name", "tc", "bpm", "audio"]);
type InfoTab = "info" | "comments";

export function PresentPage({ toggle }: { toggle: ReactNode }) {
  const show = useStore((s) => s.show)!;
  const selected = useStore((s) => s.selectedSongId);
  const select = useStore((s) => s.select);
  const order = show.set_order;
  const index = Math.max(0, selected ? order.indexOf(selected) : 0);
  const song = show.songs[order[index]];
  const go = (i: number) => order.length && select(order[Math.min(order.length - 1, Math.max(0, i))]);
  const [tab, setTab] = useState<InfoTab>("info"); // kept from song to song

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, video, audio, [contenteditable]")) return;
      const { drawerSongId, show: s, selectedSongId } = useStore.getState();
      if (drawerSongId || document.querySelector(".modal-backdrop") || !s) return;
      const i = Math.max(0, selectedSongId ? s.set_order.indexOf(selectedSongId) : 0);
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, PageUp: i - 1, PageDown: i + 1, Home: 0, End: s.set_order.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const id = s.set_order[Math.min(s.set_order.length - 1, Math.max(0, to))];
      if (id) useStore.getState().select(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="page full present">
      <div className="page-head">
        <div>
          <h1>Running order</h1>
          <div className="sub">{song ? <>Song {index + 1} of {order.length} · <span className="kbd">←</span> <span className="kbd">→</span> to move between songs</> : "Add the songs in the set"}</div>
        </div>
        <div className="acts">{toggle}</div>
      </div>
      {song ? (
        <>
          <SongSlide key={song.id} show={show} song={song} position={index + 1} tab={tab} onTab={setTab} />
          <SongStrip show={show} current={song.id} onPick={(id) => select(id)} onStep={(d) => go(index + d)} />
        </>
      ) : (
        <div className="empty"><div className="ic"><Icon name="music" size="xl" /></div><h3>No songs in the set</h3><p>Add songs in Cards or List, then present them here.</p></div>
      )}
    </div>
  );
}

function SongSlide({ show, song, position, tab, onTab }: { show: Show; song: Song; position: number; tab: InfoTab; onTab: (t: InfoTab) => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const update = useStore((s) => s.update);
  const focusSong = useStore((s) => s.focusSong);
  const items = mediaOf(show, bundle, song);
  const [pick, setPick] = useState(items[0]?.key ?? null);
  const item = items.find((x) => x.key === pick) ?? items[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<HTMLDivElement | null>(null);
  const [trackHost, setTrackHost] = useState<HTMLDivElement | null>(null);
  const target = tab === "comments" && item ? reviewTarget(item, videoRef, imageRef) : undefined;
  const review = target?.kind === "video"; // the strip under the picture is the player
  const open = openReviews(show, song.id);
  const set = (colId: string, v: string) => update((s) => setField(s, song.id, colId, v));
  const infoRef = useRef<HTMLDivElement>(null);

  // Notes grow with their text rather than scrolling inside a small box.
  const fit = (el: HTMLTextAreaElement) => { el.rows = 1; el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; };
  useLayoutEffect(() => { infoRef.current?.querySelectorAll("textarea").forEach(fit); });

  const ticks = show.columns.filter((c) => c.type === "tick");
  const sections = deptList(show)
    .map((d) => ({ dept: d, cols: show.columns.filter((c) => c.dept === d && !CORE_FIELDS.has(c.id) && (isFieldColumn(c) || c.type === "palette")) }))
    .filter((x) => x.cols.length || x.dept === "COLOUR");
  // The lighting colours live in the Colour category; first, if the show has no fields there.
  if (!sections.some((x) => x.dept === "COLOUR")) sections.unshift({ dept: "COLOUR", cols: [] });
  const notes = show.sessions.flatMap((s) => s.notes.filter((n) => n.song_id === song.id).map((n) => ({ ...n, session: s.label, sessionId: s.id })));

  return (
    <div className="pv-body">
      <div className="pv-stage" data-song-id={song.id}>
        <div className="pv-view" ref={setView}>
          {!item && (
            <div className="pv-none">
              <Icon name="image" size="xl" />
              <span>No images or clips yet. Drop images here to add them.</span>
              <button className="sm" onClick={() => focusSong(song.id, "media")}>Open media</button>
            </div>
          )}
          {item?.kind === "image" && <img key={item.key} ref={imageRef} src={backend.mediaUrl(bundle, item.src)} alt="" draggable={false} />}
          {item?.kind === "video" && <MediaPlayer key={item.key} path={item.path} video controls={!review} ltc={item.ltc} channels={item.channels} mediaRef={videoRef} />}
          {item && <span className="pv-caption">{item.label}</span>}
          {item && (
            <div className="pv-save">
              <SaveCopy key={item.key} path={item.kind === "image" ? `${bundle}/${item.src}` : item.path} ltc={item.kind === "video" ? item.ltc : null} video={item.kind === "video"} />
              <SongSaveMenu show={show} bundle={bundle} song={song} />
            </div>
          )}
        </div>
        {review && <div className="pv-track" ref={setTrackHost} />}
        {items.length > 1 && (
          <div className="pv-thumbs">
            {items.map((x) => (
              <button key={x.key} className={x.key === item?.key ? "on" : ""} title={x.label} onClick={() => setPick(x.key)}>
                {x.kind === "image" ? <img src={backend.mediaUrl(bundle, x.src)} alt="" draggable={false} />
                  : x.thumb ? <img src={backend.mediaUrl(bundle, x.thumb)} alt="" draggable={false} /> : <span className="ph"><Icon name="film" /></span>}
                {x.kind === "video" && <span className="play"><Icon name="play" size="sm" /></span>}
                <CommentBadge count={itemComments(show, x).filter((c) => !c.done).length} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`pv-info ${tab === "comments" ? "commenting" : ""}`} ref={infoRef} onInput={(e) => e.target instanceof HTMLTextAreaElement && fit(e.target)}>
        <div className="seg pv-tabs">
          <button className={tab === "info" ? "on" : ""} onClick={() => onTab("info")}>Song info</button>
          <button className={tab === "comments" ? "on" : ""} onClick={() => onTab("comments")}>Comments{open ? ` · ${open}` : ""}</button>
        </div>
        {tab === "comments" && (target && item
          ? <Review key={item.key} show={show} songId={song.id} target={target} stage={view} itemKey={item.key} trackHost={trackHost} light />
          : <div className="pv-comments"><div className="none">No images or clips to comment on yet.</div></div>)}
        {tab === "info" && <>
        <div className="pv-num">Song {String(position).padStart(2, "0")}{song.segues_into_next && <span className="pill">SEGUE</span>}</div>
        <DraftInput className="pv-name" value={song.fields.name ?? ""} placeholder="Song name" onCommit={(v) => set("name", v)} />

        <div className="pv-stats">
          <label><span>TC start</span><DraftInput mono value={song.fields.tc ?? ""} placeholder="—" onCommit={(v) => set("tc", v)} /></label>
          <label><span>BPM</span><DraftInput value={song.fields.bpm ?? ""} placeholder="—" onCommit={(v) => set("bpm", v.trim())} /></label>
          <label><span>Audio version</span><DraftInput value={song.fields.audio ?? ""} placeholder="—" onCommit={(v) => set("audio", v)} /></label>
        </div>

        <div className="pv-ticks">
          {ticks.map((c) => (
            <label key={c.id} className={`tick-chip ${song.statuses[c.id] ? "on" : ""}`}>
              <input type="checkbox" checked={Boolean(song.statuses[c.id])} onChange={() => update((s) => toggleStatus(s, song.id, c.id))} />
              {c.label}
            </label>
          ))}
          <label className={`tick-chip ${song.segues_into_next ? "on segue" : ""}`} title="Segues into the next song">
            <input type="checkbox" checked={Boolean(song.segues_into_next)} onChange={() => update((s) => { s.songs[song.id].segues_into_next = !s.songs[song.id].segues_into_next; })} />
            <Icon name="link" size="sm" /> Segue
          </label>
        </div>

        <SongAudio show={show} song={song} />

        {sections.map(({ dept, cols }) => (
          <section key={dept} className="pv-section">
            <h3 style={{ ["--band" as string]: deptColour(show, dept) ?? `var(--dept-${dept}, var(--faint))` }}>{deptName(dept, show)}</h3>
            {dept === "COLOUR" && <SwatchField swatches={song.colours} editor={<Colours song={song} />} />}
            {cols.map((c) => <FieldRow key={c.id} col={c} song={song} onCommit={(v) => set(c.id, v)} />)}
          </section>
        ))}

        {notes.length > 0 && (
          <section className="pv-section">
            <h3>Rehearsal notes</h3>
            {notes.map((n) => (
              <label key={n.id} className={`pv-note ${n.done ? "done" : ""}`}>
                <input type="checkbox" checked={n.done} onChange={() => update((s) => { const x = s.sessions.find((y) => y.id === n.sessionId)?.notes.find((y) => y.id === n.id); if (x) x.done = !x.done; })} />
                <span>
                  <span className="t">{n.text}</span>
                  <span className="muted small">{[n.session, n.tc, n.from && `from ${n.from}`, n.assignee && `→ ${n.assignee}`].filter(Boolean).join(" · ")}</span>
                </span>
              </label>
            ))}
          </section>
        )}

        <button className="ghost sm pv-more" onClick={() => focusSong(song.id)}><Icon name="settings" size="sm" /> Song details</button>
        </>}
      </div>
    </div>
  );
}

function FieldRow({ col, song, onCommit }: { col: ColumnDef; song: Song; onCommit: (v: string) => void }) {
  return (
    <div className={`pv-field ${col.type}`}>
      <span className="k">{fieldLabel(col)}</span>
      {col.type === "palette"
        ? <SwatchField swatches={fieldSwatches(song, col.id)} editor={<FieldSwatches song={song} colId={col.id} />} />
        : <FieldInput col={col} value={song.fields[col.id] ?? ""} onCommit={onCommit} placeholder={col.type === "longtext" ? "Add notes" : "—"} />}
    </div>
  );
}

/** Colours shown large with their names; click to edit them (gel library, custom colours). */
function SwatchField({ swatches, editor }: { swatches: ColourSwatch[]; editor: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pv-swatches">
      <button className="pv-swatch-show" onClick={() => setOpen(!open)} title={open ? "Done" : "Edit the colours"}>
        {swatches.length
          ? swatches.map((c, i) => <span key={i} className="sw"><i style={{ background: swatchFill(c) }} />{c.label || c.hex}</span>)
          : <span className="muted">+ Add colours</span>}
        <span className="edit">{open ? "Done" : <Icon name="pencil" size="sm" />}</span>
      </button>
      {open && <div className="pv-swatch-edit">{editor}</div>}
    </div>
  );
}

/** The song's audio, newest version first, ready to play. */
function SongAudio({ show, song }: { show: Show; song: Song }) {
  const versions = songAudio(show, song.id);
  const [id, setId] = useState(versions[0]?.id);
  const a = versions.find((x) => x.id === id) ?? versions[0];
  if (!a) return null;
  return (
    <section className="pv-section pv-audio">
      <h3>
        Audio
        {versions.length > 1
          ? <select value={a.id} onChange={(e) => setId(e.target.value)} aria-label="Audio version">
              {versions.map((x, i) => <option key={x.id} value={x.id}>{x.version || x.name}{i === 0 ? " (current)" : ""}</option>)}
            </select>
          : <span className="chip">{a.version || a.name}</span>}
        <SaveCopy key={a.id} path={a.path} ltc={a.ltc?.channel} compact />
      </h3>
      <MediaPlayer key={a.id} path={a.path} video={false} ltc={a.ltc?.channel} channels={a.info?.audio_channels} />
      <div className="muted small">{a.name}{infoLine(a.info) && ` · ${infoLine(a.info)}`}</div>
    </section>
  );
}

function SongStrip({ show, current, onPick, onStep }: { show: Show; current: string; onPick: (id: string) => void; onStep: (d: number) => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const track = useRef<HTMLDivElement>(null);
  const i = show.set_order.indexOf(current);
  useEffect(() => {
    track.current?.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [current]);
  return (
    <div className="pv-strip">
      <button className="icon" title="Previous song (←)" disabled={i <= 0} onClick={() => onStep(-1)}><Icon name="chevL" /></button>
      <div className="track" ref={track}>
        {show.set_order.map((id, n) => {
          const s = show.songs[id];
          return (
            <button key={id} className={`item ${id === current ? "on" : ""}`} data-song-id={id} onClick={() => onPick(id)}>
              <span className="th">{s.hero ? <img src={backend.mediaUrl(bundle, s.hero)} alt="" draggable={false} /> : <Icon name="music" size="sm" />}<CommentBadge count={openReviews(show, id)} /></span>
              <span className="nm"><b>{String(n + 1).padStart(2, "0")}</b>{s.fields.name || "Untitled"}</span>
              {s.segues_into_next && n < show.set_order.length - 1 && <span className="seg-arrow" title="Segues into the next song"><Icon name="arrowR" size="sm" /></span>}
            </button>
          );
        })}
      </div>
      <button className="icon" title="Next song (→)" disabled={i >= show.set_order.length - 1} onClick={() => onStep(1)}><Icon name="chevR" /></button>
    </div>
  );
}

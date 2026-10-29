// Mark songs by hand in a show record with no timecode: play or scrub to where each song starts
// and press [ (or M). Each song ends where the next mark starts, or where ] (or N) ends it early. The record's
// set list may not be the show's: any song (archived, or a new one) can be marked next, in any order.
// Marks are dragged on the timeline to fix them; zoom in (+ − or pinch) to place them closely. Then cut a clip per song.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { runClipJobs } from "../jobs";
import { useVideoHelpers } from "./videoGestures";
import { addImages, addRecordStill, addSong, clipName, GAP, marksFromStarts, marksToMake, setMarks, startsFromMarks } from "../model/ops";
import type { SourceRecord } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";
import { useDropLtc } from "./Player";
import { SongMenu } from "./SongMenu";
import { formatTime } from "./SongDrawer";

const RATES = [1, 2, 4];
const MAX_ZOOM = 64;

/** What to make from the marked songs: 720p clips and a thumbnail each, only thumbnails, or (`none`) nothing yet. */
export type Make = "clips" | "stills" | "none";

export function MakeChoice({ make, onMake, allowNone }: { make: Make; onMake: (m: Make) => void; allowNone?: boolean }) {
  return (
    <div className="stack" style={{ gap: 8, marginBottom: 8 }}>
      <div className="seg">
        <button className={make === "clips" ? "on" : ""} onClick={() => onMake("clips")}>Video clips &amp; thumbnails</button>
        <button className={make === "stills" ? "on" : ""} onClick={() => onMake("stills")}>Thumbnails only</button>
        {allowNone && <button className={make === "none" ? "on" : ""} onClick={() => onMake("none")}>Just mark</button>}
      </div>
      <span className="muted small">{make === "clips" ? "A 720p clip of each song, with its best frame as the thumbnail."
        : make === "stills" ? "No clips are cut: next, you pick each song's thumbnail from its best frames, one song at a time." : "Mark the songs now; make clips or thumbnails later."}</span>
    </div>
  );
}

type Start = { song_id: string; t: number };

/** Drags shorter than this many pixels are clicks. */
const CLICK_PX = 3;
/** The shortest a region can be dragged to, in seconds. */
const MIN_LEN = 1;

const byTime = (a: Start, b: Start) => a.t - b.t;

/** `asked`: what to make was asked when the record was added, so it isn't asked again here. */
/** `more`: other records added with this one are marked next, so it carries on to them rather than back to Media. */
export function Marker({ record, initialMake = "clips", asked, more, onDone }: { record: SourceRecord; initialMake?: Make; asked?: boolean; more?: boolean; onDone: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, toast } = useStore.getState();
  const video = useRef<HTMLVideoElement>(null);
  const { overlay } = useVideoHelpers(video, record.path);
  const track = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(record.info?.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const [starts, setStartsState] = useState<Start[]>(() => startsFromMarks(record.song_marks ?? [], record.info?.duration ?? 0));
  // Mirrors `starts` so edits and drags read the latest marks without stale closures; `past` is for undo.
  const startsRef = useRef(starts);
  const past = useRef<Start[][]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [newName, setNewName] = useState("");
  const [menu, setMenu] = useState<number | null>(null); // the region whose song menu is open
  const [menuAt, setMenuAt] = useState<number | null>(null); // where it was clicked (0–1 along the timeline)
  const [zoom, setZoomState] = useState(1); // how many times wider than the window the timeline is
  const scroller = useRef<HTMLDivElement>(null);
  // Where to hold still while zooming: this moment stays at this many pixels from the timeline's left edge.
  const anchor = useRef<{ t: number; x: number } | null>(null);
  const [make, setMake] = useState<Make>(initialMake === "none" ? "clips" : initialMake);

  useDropLtc(video, record.ltc?.channel, record.info?.audio_channels, record.path);
  const setList = show.set_order;
  const allIds = [...show.set_order, ...show.archive];
  const marks = marksFromStarts(starts, duration);
  const marked = new Set(marks.map((m) => m.song_id));
  // Only songs with nothing made from this record yet (or whose clip's mark moved): the rest aren't made again.
  const todo = marksToMake(show, record.id, marks, make === "clips");
  const madeAlready = marks.length - todo.length;
  const regions = starts.map((s, i) => ({ ...s, i, end: i < starts.length - 1 ? starts[i + 1].t : duration }));
  const current = regions.filter((r) => r.t <= t).pop();
  const currentSong = current && current.song_id !== GAP ? current : undefined;
  const lastSong = regions.filter((r) => r.t <= t && r.song_id !== GAP).pop();
  const unmarkedSet = setList.filter((id) => !marked.has(id));
  const unmarkedArchive = show.archive.filter((id) => !marked.has(id));
  // Next to mark: the song picked in the list, else the set's next unmarked song after the one just played.
  const after = lastSong ? setList.indexOf(lastSong.song_id) : -1;
  const auto = unmarkedSet.find((id) => setList.indexOf(id) > after) ?? unmarkedSet[0];
  const next = armed && show.songs[armed] ? armed : auto;
  const name = (id: string) => (id === GAP ? "Not a song" : show.songs[id]?.fields.name || "Untitled");

  function setStarts(nextStarts: Start[], undoable = true) {
    if (undoable) past.current.push(startsRef.current);
    startsRef.current = [...nextStarts].sort(byTime);
    setStartsState(startsRef.current);
  }
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    startsRef.current = prev;
    setStartsState(prev);
  }, []);

  const seek = useCallback((to: number) => {
    const v = video.current;
    const clamped = Math.max(0, Math.min(duration || Infinity, to));
    if (v) v.currentTime = clamped;
    setT(clamped);
  }, [duration]);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => setFailed(true));
    else v.pause();
  }, []);

  /** Start `id` (or a gap) at `at`. A song marked again moves; a mark already at that moment is replaced. */
  function markAt(id: string, at: number) {
    const cur = startsRef.current;
    const replaced = cur.find((s) => Math.abs(s.t - at) < 0.5 && s.song_id !== id && s.song_id !== GAP);
    setStarts([...cur.filter((s) => (id === GAP || s.song_id !== id) && Math.abs(s.t - at) >= 0.5), { song_id: id, t: at }]);
    const what = id === GAP ? `Not a song from ${formatTime(at)}` : `${name(id)} starts at ${formatTime(at)}`;
    toast(replaced ? `${what} (instead of ${name(replaced.song_id)})` : what);
  }

  const mark = useCallback(() => {
    const v = video.current;
    if (!next || !v) return;
    markAt(next, v.currentTime);
    setArmed(null);
  }, [next]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Delete region `i`, so nothing is made from it: a song's region becomes a gap (merged with a gap or the lead-in
   * either side of it), and a gap is removed, so the song before it runs on to the next mark.
   */
  function deleteRegion(i: number) {
    const cur = startsRef.current;
    if (!cur[i]) return;
    const out = cur[i].song_id === GAP ? cur.filter((_, j) => j !== i) : cur.map((s, j) => (j === i ? { ...s, song_id: GAP } : s));
    setStarts(out.filter((s, j) => s.song_id !== GAP || (j > 0 && out[j - 1].song_id !== GAP)));
    toast(cur[i].song_id === GAP ? "Gap removed" : `${name(cur[i].song_id)} unmarked: no clip from ${formatTime(cur[i].t)}`);
  }

  /** Add a song the record has but the show doesn't: it goes in the archive, so the show's set list stays as it is. */
  function createSong(songName: string): string {
    let id = "";
    update((s) => { id = addSong(s, "archive", 0, songName); });
    return id;
  }

  function addNewSong() {
    const songName = newName.trim();
    if (!songName || !createSong(songName)) return;
    setArmed(useStore.getState().show!.archive[0]);
    setNewName("");
    toast(`${songName} added to the archive. Press M where it starts.`);
  }

  /** Give region `i` to `id` (or make it a gap). A song already on another region swaps places with this one's. */
  function reassign(i: number, id: string) {
    setMenu(null);
    const cur = startsRef.current;
    const old = cur[i]?.song_id;
    if (!old || old === id) return;
    const other = id === GAP ? -1 : cur.findIndex((s, j) => j !== i && s.song_id === id);
    setStarts(cur.map((s, j) => (j === i ? { ...s, song_id: id } : j === other ? { ...s, song_id: old } : s)));
    const label = (x: string) => (x === GAP ? "Not a song" : useStore.getState().show?.songs[x]?.fields.name || "Untitled");
    toast(other >= 0 ? `Swapped ${label(id)} and ${label(old)}` : `${formatTime(cur[i].t)} is now ${label(id)}`);
  }

  /** Make a new song and give it region `i`. */
  function assignNew(i: number, songName: string) {
    if (!songName.trim() || !createSong(songName.trim())) return;
    reassign(i, useStore.getState().show!.archive[0]);
    toast(`${songName.trim()} added to the archive and marked at ${formatTime(startsRef.current[i].t)}`);
  }

  /** Open region `i`'s song menu, over `at` (0–1 along the timeline) or else over the middle of the region. */
  function openMenu(i: number, at: number | null = null) {
    setMenuAt(at);
    setMenu(i);
  }
  const closeMenu = useCallback(() => setMenu(null), []);

  /** End the song playing at the player position here (]): the rest, up to the next mark, is not a song. */
  const markEnd = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (!currentSong) return toast("Not in a song: press [ where one starts");
    markAt(GAP, v.currentTime);
  }, [currentSong]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Zoom the timeline to `z`×, holding moment `at` still at `x` pixels from the left of the visible timeline. */
  const zoomTo = useCallback((z: number, at?: number, x?: number) => {
    const el = scroller.current;
    const next = Math.min(MAX_ZOOM, Math.max(1, z));
    if (!el || !duration) return setZoomState(next);
    const width = el.scrollWidth;
    const time = at ?? video.current?.currentTime ?? 0;
    anchor.current = { t: time, x: x ?? Math.min(el.clientWidth, Math.max(0, (time / duration) * width - el.scrollLeft)) };
    setZoomState(next);
  }, [duration]);

  useLayoutEffect(() => {
    const el = scroller.current, a = anchor.current;
    anchor.current = null;
    if (el && a && duration) el.scrollLeft = (a.t / duration) * el.scrollWidth - a.x;
  }, [zoom, duration]);

  /** Scroll a zoomed timeline so the playhead is in view. */
  const reveal = useCallback((at: number) => {
    const el = scroller.current;
    if (!el || zoom === 1 || !duration) return;
    const x = (at / duration) * el.scrollWidth;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth * 0.1;
  }, [zoom, duration]);

  useEffect(() => {
    if (playing) reveal(t);
  }, [t, playing, reveal]);

  // Pinch, or ⌘/Ctrl + scroll, on the timeline zooms around the pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      zoomTo(zoom * Math.exp(-e.deltaY * 0.01), ((el.scrollLeft + x) / el.scrollWidth) * duration, x);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, duration, zoomTo]);

  const grabStill = useCallback(async () => {
    const v = video.current;
    if (!v || !currentSong) return;
    try {
      const rel = await backend.grabFrame(bundle, record.path, v.currentTime, clipName(show, currentSong.song_id));
      update((s) => { addImages(s, currentSong.song_id, [rel], record.image_col ?? "hero"); addRecordStill(s, record.id, rel); });
      toast(`Still added to ${name(currentSong.song_id)}`);
    } catch (e) {
      toast(String(e));
    }
  }, [currentSong, bundle, record.path, record.image_col, show]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      const v = video.current;
      const k = e.key.toLowerCase();
      if (k === " ") toggle();
      else if (k === "m" || k === "[") mark();
      else if (k === "]" || k === "n") markEnd();
      else if ((k === "=" || k === "+") && duration) zoomTo(zoom * 2);
      else if (k === "-" && duration) zoomTo(zoom / 2);
      else if (k === "0") zoomTo(1);
      else if (k === "arrowleft" && v) { seek(v.currentTime - (e.shiftKey ? 30 : 5)); reveal(v.currentTime); }
      else if (k === "arrowright" && v) { seek(v.currentTime + (e.shiftKey ? 30 : 5)); reveal(v.currentTime); }
      else if (k === "backspace") undo();
      else if (k === "escape" && menu !== null) setMenu(null);
      else if (k === "escape" && armed) setArmed(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, mark, markEnd, seek, undo, armed, menu, zoom, zoomTo, reveal, duration]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);

  /** How far along the timeline (0–1) screen position `x` is. */
  function xToFraction(x: number) {
    const r = track.current?.getBoundingClientRect();
    return r ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0;
  }

  /** Seek to the moment under screen position `x` on the timeline. */
  function seekX(x: number) {
    if (duration) seek(xToFraction(x) * duration);
  }

  function scrub(e: React.PointerEvent) {
    if (!duration) return;
    const go = seekX;
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
  }

  /**
   * Drag the marks at `moving` (indexes into the sorted starts) together along the timeline, keeping every region at
   * least MIN_LEN long; the video follows the first one. A press that doesn't move is a click.
   */
  function drag(e: React.PointerEvent, moving: number[], onClick: () => void) {
    e.preventDefault();
    e.stopPropagation();
    const el = track.current;
    if (!el || !duration) return;
    const width = el.getBoundingClientRect().width;
    const orig = startsRef.current;
    const set = new Set(moving);
    let lo = -Infinity, hi = Infinity;
    for (const j of moving) {
      const below = j === 0 ? 0 : set.has(j - 1) ? -Infinity : orig[j - 1].t + MIN_LEN;
      const above = j === orig.length - 1 ? duration - MIN_LEN : set.has(j + 1) ? Infinity : orig[j + 1].t - MIN_LEN;
      lo = Math.max(lo, below - orig[j].t);
      hi = Math.min(hi, above - orig[j].t);
    }
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < CLICK_PX) return;
      if (!moved) { past.current.push(orig); setMenu(null); }
      moved = true;
      const d = Math.min(hi, Math.max(lo, ((ev.clientX - x0) / width) * duration));
      setStarts(orig.map((s, j) => (set.has(j) ? { ...s, t: s.t + d } : s)), false);
      seek(orig[moving[0]].t + d);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) onClick();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Drag the end of song region `i` back from where it runs to, putting a gap (an end point) there. */
  function dragEnd(e: React.PointerEvent, i: number) {
    e.preventDefault();
    e.stopPropagation();
    const el = track.current;
    if (!el || !duration) return;
    const width = el.getBoundingClientRect().width;
    const orig = startsRef.current;
    const end = i < orig.length - 1 ? orig[i + 1].t : duration;
    const lo = orig[i].t + MIN_LEN, hi = end - MIN_LEN;
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < CLICK_PX) return;
      if (!moved) { past.current.push(orig); setMenu(null); }
      moved = true;
      const at = Math.min(hi, Math.max(lo, end + ((ev.clientX - x0) / width) * duration));
      setStarts([...orig, { song_id: GAP, t: at }], false);
      seek(at);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) seek(end - 0.01);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function create() {
    update((s) => setMarks(s, record.id, marks));
    if (!todo.length) {
      toast(`Saved the marks. Every song already has its ${make === "clips" ? "clip" : "thumbnail"}.`);
      if (more) return onDone();
      useStore.getState().setView("media");
      return;
    }
    runClipJobs(bundle, { ...record, song_marks: marks }, todo, true, make === "clips");
    onDone();
  }

  const colour = (id: string) => `hsl(${(allIds.indexOf(id) * 47 + 210) % 360} 70% 82%)`;
  const pct = (x: number) => `${(x / (duration || 1)) * 100}%`;
  const songNo = (id: string) => (setList.includes(id) ? String(setList.indexOf(id) + 1).padStart(2, "0") : "A");
  const pickRow = (id: string, n: string) => (
    <div key={id} className={`mrow ${id === next ? "next" : ""}`} title={id === next ? "Marked next (M)" : "Mark this song next"}
         onClick={() => setArmed(id === armed ? null : id)}>
      <span className="n">{n}</span>
      <span className="nm">{name(id)}</span>
      <span className="tm">{id === next ? "next" : ""}</span>
    </div>
  );

  function regionMenu(r: (typeof regions)[number]) {
    // Over where it was clicked (or the region's middle), as seen in the timeline's window when zoomed in.
    const el = scroller.current;
    const f = menuAt ?? (r.t + r.end) / 2 / (duration || 1);
    const w = el?.clientWidth ?? 0;
    const seen = el ? (f * el.scrollWidth - el.scrollLeft) / w : f;
    // Kept inside the timeline: half the menu's width (270px) from either edge, past the timeline's 12px padding.
    const left = w > 280 ? `${12 + Math.min(w - 135, Math.max(135, seen * w))}px` : `${Math.min(0.85, Math.max(0.15, seen)) * 100}%`;
    const elsewhere = (id: string) => (id !== r.song_id ? regions.find((x) => x.song_id === id) : undefined);
    return (
      <SongMenu className="region-menu" style={{ left }} current={r.song_id === GAP ? undefined : r.song_id}
                onPick={(id) => reassign(r.i, id)} onNew={(n) => assignNew(r.i, n)} onClose={closeMenu}
                extra={(id) => { const x = elsewhere(id); return x ? <span className="tm">↔ {formatTime(x.t)}</span> : null; }}
                title={(id) => { const x = elsewhere(id); return x ? `Swap with ${name(id)} at ${formatTime(x.t)}` : undefined; }}
                head={<div className="rm-hd">{formatTime(r.t)} – {formatTime(r.end)}</div>}
                foot={(
                  <div className="rm-ft">
                    <button onClick={() => { setMenu(null); deleteRegion(r.i); }}
                            title={r.song_id === GAP ? "The song before runs on to the next mark" : "Nothing is made from this part of the video"}>
                      <Icon name="trash" size="sm" /> Delete region
                    </button>
                  </div>
                )} />
    );
  }

  return (
    <>
      <div className="result-banner manual">
        <div className="ic"><Icon name="hand" size="lg" /></div>
        <div>
          <div className="t">{record.ltc ? "No timecode found" : "Mark each song"}</div>
          <div className="d">Press <span className="kbd">[</span> at the start of each song and <span className="kbd">]</span> where one ends early. If this show's set list was different, pick the song that's next in the list.</div>
        </div>
        <div className="chips">
          <span className="chip">{marks.length} marked</span>
          {setList.length > 0 && <span className="chip">{setList.length - unmarkedSet.length} / {setList.length} of the set</span>}
        </div>
      </div>
      <div className="marker">
        <div>
          <div className="player">
            <video ref={video} src={backend.streamUrl(record.path)} preload="auto" playsInline
                   crossOrigin={record.ltc?.channel !== null && record.ltc?.channel !== undefined ? "anonymous" : undefined}
                   onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || duration)}
                   onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
                   onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setFailed(true)}
                   onClick={toggle} />
            {overlay}
            {failed && <div className="err">This video won't play here. It may need a lighter copy (a fragmented or unusual MP4).</div>}
            <div className="now">
              <div className="s"><small>Now</small>{current ? name(current.song_id) : "Before the first song"}</div>
              <div className="t">{formatTime(t)}</div>
            </div>
          </div>
          <div className="transport">
            <button className="icon" title="Back 30s (⇧←)" onClick={() => seek(t - 30)}><Icon name="skipB" size="sm" /></button>
            <button className="primary" style={{ width: 40, padding: 0 }} title="Play / pause (Space)" onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
            <button className="icon" title="Forward 30s (⇧→)" onClick={() => seek(t + 30)}><Icon name="skipF" size="sm" /></button>
            <div className="seg" style={{ marginLeft: 6 }}>{RATES.map((r) => <button key={r} className={rate === r ? "on" : ""} onClick={() => setRate(r)}>{r}×</button>)}</div>
            <button className="sm" onClick={grabStill} disabled={!currentSong} title={currentSong ? `Add this frame to ${name(currentSong.song_id)}'s stills` : "Play into a song to grab a still for it"}><Icon name="camera" size="sm" /> Grab still</button>
            <div className="marks">
              <button className="markbtn" onClick={markEnd} disabled={!currentSong}
                      title={currentSong ? `${name(currentSong.song_id)} ends here: what follows, up to the next song, is a break, crowd or changeover (])` : "Play into a song to end it"}>
                <span className="who">{currentSong ? `End of ${name(currentSong.song_id)}` : "End of song"}</span><span className="kbd">]</span>
              </button>
              {next
                ? <button className="primary markbtn" onClick={mark} title={`${name(next)} starts here ([)`}><Icon name="flag" /><span className="who">{marked.has(next) ? "Move start of" : "Start of"} {name(next)}</span><span className="kbd">[</span></button>
                : <button className="primary markbtn" onClick={create} disabled={!marks.length}><Icon name="check" /> All marked, make {make === "clips" ? "clips" : "thumbnails"}</button>}
            </div>
          </div>
          <div className="timeline">
            <div className="tl-zoom">
              <span className="muted small">{zoom > 1 ? `Showing ${formatTime(duration / zoom)} of ${formatTime(duration)}` : "Pinch or press + to zoom in"}</span>
              <div className="seg">
                <button title="Zoom out (−)" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 2)}><Icon name="minus" size="sm" /></button>
                <button className="zl" title="Fit the whole video (0)" onClick={() => zoomTo(1)}>{zoom > 1 ? `${zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, "") : Math.round(zoom)}×` : "Fit"}</button>
                <button title="Zoom in (+)" disabled={zoom >= MAX_ZOOM || !duration} onClick={() => zoomTo(zoom * 2)}><Icon name="plus" size="sm" /></button>
              </div>
            </div>
            <div className="tl-scroll" ref={scroller}>
            <div className="tl-track" ref={track} onPointerDown={scrub} style={{ width: `${zoom * 100}%` }}>
              {regions.length > 0 && <div className="tl-seg hatch" style={{ left: 0, width: pct(regions[0].t) }}><span className="l">Before</span></div>}
              {regions.map((r) => (
                <div key={`${r.song_id}-${r.i}`} className={`tl-seg movable ${r.song_id === GAP ? "hatch" : ""}`}
                     title={`${name(r.song_id)} · ${formatTime(r.t)} – ${formatTime(r.end)}. Click to change its song. Drag to move it, or drag its start.`}
                     style={{ left: pct(r.t), width: pct(r.end - r.t), background: r.song_id === GAP ? undefined : colour(r.song_id) }}
                     onPointerDown={(e) => { const x = e.clientX; drag(e, r.i < regions.length - 1 ? [r.i, r.i + 1] : [r.i], () => { seekX(x); openMenu(r.i, xToFraction(x)); }); }}>
                  {r.song_id !== GAP && <span className="tcl">{songNo(r.song_id)}</span>}<span className="l">{name(r.song_id)}</span>
                </div>
              ))}
              {regions.map((r) => r.song_id !== GAP && regions[r.i + 1]?.song_id !== GAP && (
                <div key={`end-${r.song_id}-${r.i}`} className="tl-end" style={{ left: pct(r.end) }} title={`Drag to end ${name(r.song_id)} earlier`}
                     onPointerDown={(e) => dragEnd(e, r.i)} />
              ))}
              {regions.map((r) => (
                <div key={`edge-${r.song_id}-${r.i}`} className="tl-split" style={{ left: pct(r.t) }} title={`Drag to move the start of ${name(r.song_id)}`}
                     onPointerDown={(e) => drag(e, [r.i], () => seek(r.t + 0.01))} />
              ))}
              <div className="tl-head" style={{ left: pct(t) }} />
            </div>
            <div className="tl-scale scrub" onPointerDown={scrub} title="Drag to scrub" style={{ width: `${zoom * 100}%` }}>
              {Array.from({ length: Math.round(5 * zoom) + 1 }, (_, i) => <span key={i}>{formatTime((duration * i) / Math.round(5 * zoom))}</span>)}
            </div>
            </div>
            {menu !== null && regions[menu] && regionMenu(regions[menu])}
          </div>
          <div className="keys">
            <span><span className="kbd">Space</span> play / pause</span><span><span className="kbd">[</span> start of next song</span><span><span className="kbd">]</span> end of this song</span>
            <span><span className="kbd">←</span><span className="kbd">→</span> 5s</span><span><span className="kbd">⇧</span> + arrows 30s</span>
            <span><span className="kbd">+</span><span className="kbd">−</span> zoom</span><span><span className="kbd">⌫</span> undo</span>
          </div>
        </div>
        <div className="marklist">
          <div className="hd"><span className="field-label">Songs</span><button className="sm ghost" disabled={!starts.length} onClick={undo}><Icon name="undo" size="sm" /> Undo</button></div>
          <div className="bd">
            {regions.length > 0 && <div className="mgroup">In this video</div>}
            {regions.map((r) => (
              <div key={`${r.song_id}-${r.i}`} className={`mrow done ${r.song_id === GAP ? "gap" : ""} ${r.song_id === next ? "next" : ""} ${current?.i === r.i ? "cur" : ""}`}
                   title="Go to this point" onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) seek(r.t + 0.01); }}>
                <span className="n">{r.song_id === GAP ? "–" : songNo(r.song_id)}</span>
                <span className="nm">{name(r.song_id)}</span>
                <span className="tm">{formatTime(r.t)} – {formatTime(r.end)}</span>
                <span className="tools">
                  <button className="icon" title="Change its song" onClick={() => openMenu(r.i)}><Icon name="pencil" size="sm" /></button>
                  <button className="icon" title="Move this mark to the player position" onClick={() => markAt(r.song_id === GAP ? GAP : r.song_id, video.current?.currentTime ?? t)}><Icon name="flag" size="sm" /></button>
                  <button className="icon" title="Delete this region" onClick={() => deleteRegion(r.i)}><Icon name="trash" size="sm" /></button>
                </span>
              </div>
            ))}
            <div className="mgroup">{regions.length ? "Not marked yet" : "Set list"}</div>
            {unmarkedSet.map((id) => pickRow(id, songNo(id)))}
            {setList.length > 0 && unmarkedSet.length === 0 && <p className="muted small" style={{ padding: "2px 10px 6px" }}>Every song in the set is marked.</p>}
            {show.archive.length > 0 && (
              <button className="mgroup toggle" onClick={() => setShowArchive(!showArchive)}>
                <Icon name={showArchive ? "chevDown" : "chevR"} size="sm" /> Archive ({unmarkedArchive.length})
              </button>
            )}
            {(showArchive || (armed && show.archive.includes(armed))) && unmarkedArchive.map((id) => pickRow(id, "A"))}
            <div className="mgroup">New song</div>
            <div className="mnew">
              <input value={newName} placeholder="A song that isn't in the show yet" onChange={(e) => setNewName(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") addNewSong(); else if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
              <button className="sm" disabled={!newName.trim()} onClick={addNewSong} title="Create the song (in the archive) and mark it next"><Icon name="plus" size="sm" /> Add</button>
            </div>
          </div>
          <div className="ft">
            {!asked && <MakeChoice make={make} onMake={setMake} />}
            <button className="primary" disabled={!marks.length} onClick={create}>
              {todo.length || !marks.length
                ? <><Icon name={make === "clips" ? "scissors" : "camera"} /> Make {todo.length} {make === "clips" ? "clip" : "thumbnail"}{todo.length === 1 ? "" : "s"}</>
                : <><Icon name="check" /> Save marks</>}
            </button>
            {madeAlready > 0 && <div className="made-note">{madeAlready} already made, so {madeAlready === 1 ? "it isn't" : "they aren't"} made again</div>}
          </div>
        </div>
      </div>
    </>
  );
}

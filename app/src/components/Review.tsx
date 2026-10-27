// Frame.io-style comments on a song's videos and images, beside the picture in the media viewer and Present.
// On a video: numbered markers on a strip under the picture and timecoded threads; a comment lands on the frame on
// screen (or a range, I then O) and is placed in the show record (see ReviewComment), so a clip and its record share
// them. The strip is the player's transport too (the video's own controls are hidden meanwhile): Space or a click on
// the picture plays and pauses. On an image: the same threads, without a time. Either can carry a drawing over the
// picture. C writes a comment; Enter posts it; clicking one jumps to it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import {
  addReview, clipName, clipTimeAt, deleteReply, deleteReview, deptList, deptName, imageReviews, recordTc, recordTimeAt, replyToReview, reviewsOn, setReviewDone, unplacedReviews,
} from "../model/ops";
import type { ReviewComment, Show } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";
import { formatTime } from "./SongDrawer";

/** A song's open comments, as a notification badge on its card, row or thumbnail. Nothing when there are none. */
export function CommentBadge({ count, onClick }: { count: number; onClick?: () => void }) {
  if (!count) return null;
  const title = `${count} open comment${count === 1 ? "" : "s"}`;
  return onClick
    ? <button className="cbadge" title={`${title}: open the song's clips`} onClick={(e) => { e.stopPropagation(); onClick(); }}><Icon name="comment" size="sm" />{count}</button>
    : <span className="cbadge" title={title}><Icon name="comment" size="sm" />{count}</span>;
}

/**
 * Where a video sits in its record: record time = offset + video time, plus any pauses cut out of it before then;
 * its comments are those from `from` to `to`.
 */
export interface ReviewAnchor {
  record_id: string;
  offset: number;
  from: number;
  to: number;
  cuts?: [number, number][];
}

/** What's being commented on: a video (where it sits in its record, the file playing) or an image (bundle-relative). */
export type ReviewTarget =
  | { kind: "video"; anchor: ReviewAnchor; source: string; ref: React.RefObject<HTMLVideoElement | null> }
  | { kind: "image"; path: string; ref: React.RefObject<HTMLImageElement | null> };

type Filter = "all" | "open" | "done";
const NO_VIDEO: React.RefObject<HTMLVideoElement | null> = { current: null };
const NO_ANCHOR: ReviewAnchor = { record_id: "", offset: 0, from: 0, to: 0 };
const FRAME = 1 / 25;
const AVATAR_COLOURS = ["#2563eb", "#9c3fa6", "#1e9c8a", "#d9881e", "#c8323a", "#3a6fd9", "#d23f8a", "#5b3fd9"];

const avatarColour = (key: string) => AVATAR_COLOURS[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLOURS.length];
const initials = (name: string) => name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const inField = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest("input, textarea, select, [contenteditable]"));

/** The video's time, kept fresh every frame while it plays. */
function useClock(ref: React.RefObject<HTMLVideoElement | null>, key: string) {
  const [clock, setClock] = useState({ now: 0, duration: 0, paused: true, muted: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const read = () => setClock({ now: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0, paused: el.paused, muted: el.muted });
    const tick = () => { read(); if (!el.paused) frame = requestAnimationFrame(tick); };
    const events = ["loadedmetadata", "durationchange", "seeked", "timeupdate", "pause", "volumechange"];
    const onPlay = () => { cancelAnimationFrame(frame); tick(); };
    events.forEach((e) => el.addEventListener(e, read));
    el.addEventListener("play", onPlay);
    read();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach((e) => el.removeEventListener(e, read));
      el.removeEventListener("play", onPlay);
    };
  }, [ref, key]);
  return clock;
}

/** Where the picture is inside the <video> or <img> box (object-fit: contain), relative to `stage`. */
function usePictureBox(ref: React.RefObject<HTMLVideoElement | HTMLImageElement | null>, stage: HTMLElement | null, key: string) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !stage) return;
    const measure = () => {
      const v = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const [w, h] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
      if (!w || !h || !v.width) return setBox(null);
      const scale = Math.min(v.width / w, v.height / h);
      const width = w * scale, height = h * scale;
      setBox({ left: v.left - s.left + (v.width - width) / 2, top: v.top - s.top + (v.height - height) / 2, width, height });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(stage);
    const loaded = el instanceof HTMLVideoElement ? "loadedmetadata" : "load";
    el.addEventListener(loaded, measure);
    measure();
    return () => { ro.disconnect(); el.removeEventListener(loaded, measure); };
  }, [ref, stage, key]);
  return box;
}

interface Props {
  show: Show;
  songId: string;
  target: ReviewTarget;
  stage: HTMLElement | null; // the viewer's stage: the drawing goes over the picture in it
  itemKey: string;
  trackHost?: HTMLElement | null; // where the marker strip goes, when not beside the panel (Present)
  light?: boolean; // on the page's surface rather than the viewer's black
  focus?: string; // a comment to open on: selected, and the video at its frame
}

/** The marker strip (for under a video) and the comments panel, as siblings for the viewer's grid. */
export function Review({ show, songId, target, stage, itemKey, trackHost, light, focus }: Props) {
  const bundle = useStore((s) => s.bundle)!;
  const user = useStore((s) => s.user);
  const update = useStore((s) => s.update);
  const isVideo = target.kind === "video";
  const anchor = isVideo ? target.anchor : NO_ANCHOR;
  const videoRef = isVideo ? target.ref : NO_VIDEO;
  const { now, duration, paused, muted } = useClock(videoRef, itemKey);
  const box = usePictureBox(target.ref, stage, itemKey);
  const record = (show.records ?? []).find((r) => r.id === anchor.record_id);
  const comments = isVideo ? reviewsOn(show, anchor.record_id, anchor.from, anchor.to) : imageReviews(show, target.path);
  const unplaced = isVideo ? unplacedReviews(show, songId) : [];
  const depts = deptList(show).filter((d) => !["CORE", "STATUS", "COLOUR"].includes(d));

  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [text, setText] = useState("");
  const [dept, setDept] = useState<string>("");
  const [rangeIn, setRangeIn] = useState<number | null>(null); // record time
  const [drawing, setDrawing] = useState(false);
  const [draw, setDraw] = useState("");
  const [error, setError] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const inRecord = (v: number) => recordTimeAt({ in: anchor.offset, out: anchor.to, cuts: anchor.cuts }, v);
  const inVideo = (t: number) => clipTimeAt({ in: anchor.offset, out: anchor.to, cuts: anchor.cuts }, t);
  const at = inRecord(now); // record time on screen
  const label = (t: number) => (isVideo ? recordTc(record, t) ?? formatTime(inVideo(t)) : ""); // images have no time
  const video = () => videoRef.current;
  const pause = () => video()?.pause();
  const seek = (t: number) => {
    const el = video();
    if (!el) return;
    el.pause();
    el.currentTime = Math.max(0, inVideo(t));
  };
  const toggle = () => {
    const el = video();
    if (!el) return;
    if (el.paused) { setDrawing(false); void el.play().catch(() => {}); } else el.pause();
  };
  const open = (c: ReviewComment) => {
    setSelected(c.id);
    seek(c.t);
  };

  // C to write a comment, I / O for a range: only when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inField(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "c") composer.current?.focus();
      else if (!isVideo) return;
      else if (k === " " && !(e.target instanceof HTMLButtonElement)) toggle();
      else if (k === "i") setRangeIn(inRecord(video()?.currentTime ?? 0));
      else if (k === "o" && rangeIn !== null) composer.current?.focus();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A click on the picture plays and pauses, as the video's own controls would.
  useEffect(() => {
    const el = video();
    if (!el) return;
    el.addEventListener("click", toggle);
    return () => el.removeEventListener("click", toggle);
  });

  // Opened on a comment: go to its frame once the video knows its length.
  useEffect(() => {
    const c = focus ? comments.find((x) => x.id === focus) : undefined;
    const el = video();
    if (!c || !el) return;
    const go = () => seek(c.t);
    if (el.readyState >= 1) return go();
    el.addEventListener("loadedmetadata", go, { once: true });
    return () => el.removeEventListener("loadedmetadata", go);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the comment on screen in view in the list.
  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const post = () => {
    const body = text.trim();
    if (!body) { setError(true); composer.current?.focus(); return; }
    pause();
    const end = rangeIn !== null && at > rangeIn + FRAME ? at : undefined;
    const t = rangeIn !== null && rangeIn < at ? rangeIn : at;
    const common = { song_id: songId, text: body, from: user?.name || user?.email || "Me", ...(user?.email && { email: user.email }), ...(dept && { dept }), ...(draw && { draw }) };
    let id = "";
    update((s) => {
      id = target.kind === "video"
        ? addReview(s, { ...common, record_id: anchor.record_id, t, ...(end !== undefined && { t_out: end }) })
        : addReview(s, { ...common, image: target.path, still: target.path, t: 0 }); // the image is its own picture in the Sheet
    });
    setText(""); setRangeIn(null); setDraw(""); setDrawing(false); setError(false); setSelected(id);
    // The frame, for the Sheet's FRAME column.
    if (target.kind === "video" && backend.isDesktop) {
      const name = `review ${clipName(show, songId)} ${label(t).replace(/:/g, "-")}`;
      backend.grabFrame(bundle, target.source, Math.max(0, inVideo(t)), name)
        .then((still) => useStore.getState().updateQuiet((s) => { const c = s.reviews?.find((x) => x.id === id); if (c) c.still = still; }))
        .catch(() => {}); // no ffmpeg, or the file is offline: the Sheet row just has no picture
    }
  };

  const shown = comments.filter((c) => filter === "all" || (filter === "done" ? c.done : !c.done));
  const number = new Map(comments.map((c, i) => [c.id, i + 1]));
  const onScreen = comments.find((c) => c.id === selected && c.draw && (!isVideo || (paused && Math.abs(c.t - at) < FRAME * 2)));
  const span = duration || Math.max(1, (anchor.to === Infinity ? at : anchor.to) - anchor.from);
  const pos = (t: number) => `${Math.min(100, Math.max(0, (inVideo(t) / span) * 100))}%`;

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(inRecord(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span));
  };
  const track = (
    <div className="review-track">
      <button className="icon rt-btn" title={paused ? "Play (Space)" : "Pause (Space)"} onClick={toggle}><Icon name={paused ? "play" : "pause"} size="sm" /></button>
      <span className="rt-time">{label(at)}</span>
      <div className="bar"
           onPointerDown={(e) => { if ((e.target as HTMLElement).closest(".mk")) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
           onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && scrub(e)}>
        <div className="played" style={{ width: pos(at) }} />
        {rangeIn !== null && <div className="pending" style={{ left: pos(Math.min(rangeIn, at)), width: `calc(${pos(Math.max(rangeIn, at))} - ${pos(Math.min(rangeIn, at))})` }} />}
        {comments.map((c) => c.t_out !== undefined && (
          <div key={`r${c.id}`} className={`span ${c.done ? "done" : ""}`} style={{ left: pos(c.t), width: `calc(${pos(c.t_out)} - ${pos(c.t)})`, background: avatarColour(c.email ?? c.from) }} />
        ))}
        {comments.map((c) => (
          <button key={c.id} className={`mk ${c.done ? "done" : ""} ${selected === c.id ? "on" : ""}`} style={{ left: pos(c.t), background: c.done ? undefined : avatarColour(c.email ?? c.from) }}
                  title={`${c.from} · ${label(c.t)}\n${c.text}`} onClick={() => open(c)}>{number.get(c.id)}</button>
        ))}
        <div className="head" style={{ left: pos(at) }} />
      </div>
      <span className="rt-time end">{formatTime(span)}</span>
      <button className="icon rt-btn" title={muted ? "Unmute" : "Mute"} onClick={() => { const el = video(); if (el) el.muted = !el.muted; }}>
        <Icon name={muted ? "mute" : "volume"} size="sm" />
      </button>
    </div>
  );

  const overlay = stage && box && (drawing || onScreen) && createPortal(
    <Drawing box={box} path={drawing ? draw : onScreen!.draw!} live={drawing} onChange={setDraw} />, stage);

  return (
    <>
      {isVideo && (trackHost === undefined ? track : trackHost && createPortal(track, trackHost))}
      {overlay}
      <aside className={`review-panel ${light ? "light" : ""}`} aria-label="Comments">
        <div className="rv-head">
          <b>Comments</b>
          <span className="count">{comments.filter((c) => !c.done).length} open</span>
          <span style={{ flex: 1 }} />
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="done">Resolved</option>
          </select>
        </div>
        <div className="rv-list" ref={list}>
          {shown.map((c) => (
            <Thread key={c.id} c={c} n={number.get(c.id)!} label={label} selected={selected === c.id} replying={replyTo === c.id}
                    onOpen={() => open(c)} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} />
          ))}
          {!shown.length && (
            <div className="rv-empty">
              {comments.length ? `No ${filter === "done" ? "resolved" : "open"} comments`
                : <>No comments yet.<br />{isVideo ? "Pause on a frame and press" : "Press"} <kbd>C</kbd> to write one.</>}
            </div>
          )}
          {unplaced.length > 0 && (
            <>
              <div className="rv-sub">On the song, not a frame</div>
              {unplaced.map((c) => (
                <Thread key={c.id} c={c} n={0} label={() => c.tc ?? ""} selected={false} replying={replyTo === c.id}
                        onOpen={() => {}} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} />
              ))}
            </>
          )}
        </div>
        <div className="rv-compose">
          <div className="rv-at">
            {isVideo
              ? <span className="tc" title="Where the comment goes">@ {label(rangeIn !== null ? Math.min(rangeIn, at) : at)}</span>
              : <span className="on-image">On this image</span>}
            {rangeIn !== null && <span className="tc range">→ {label(Math.max(rangeIn, at))}</span>}
            <span style={{ flex: 1 }} />
            <select value={dept} onChange={(e) => setDept(e.target.value)} title="Department">
              <option value="">No department</option>
              {depts.map((d) => <option key={d} value={d}>{deptName(d, show)}</option>)}
            </select>
          </div>
          <textarea ref={composer} rows={2} value={text} placeholder={isVideo ? "Leave a comment at this frame…" : "Leave a comment on this image…"}
                    onFocus={pause}
                    onChange={(e) => { setText(e.target.value); setError(false); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); }
                      else if (e.key === "Escape") { e.preventDefault(); e.currentTarget.blur(); }
                    }} />
          {error && <div className="rv-error">Type a comment first</div>}
          <div className="rv-tools">
            {isVideo && <button className={`icon sm ${rangeIn !== null ? "on" : ""}`} title="Range: from here (I) to where you post it"
                    onClick={() => setRangeIn(rangeIn === null ? at : null)}><Icon name="range" size="sm" /></button>}
            <button className={`icon sm ${drawing ? "on" : ""}`} title={isVideo ? "Draw on the frame" : "Draw on the image"}
                    onClick={() => { pause(); setDrawing(!drawing); }}><Icon name="pencil" size="sm" /></button>
            {draw && <button className="link sm" onClick={() => setDraw("")}>Clear drawing</button>}
            <span style={{ flex: 1 }} />
            <button className="primary sm" onClick={post}>Comment</button>
          </div>
        </div>
      </aside>
    </>
  );
}

/** One comment with its replies, and Reply, Resolve and Delete. */
export function Thread({ c, n, label, selected, replying, onOpen, onReply }: {
  c: ReviewComment; n: number; label: (t: number) => string; selected: boolean; replying: boolean; onOpen: () => void; onReply: () => void;
}) {
  const show = useStore((s) => s.show)!;
  const user = useStore((s) => s.user);
  const update = useStore((s) => s.update);
  const [reply, setReply] = useState("");
  const colour = avatarColour(c.email ?? c.from);
  const remove = async () => {
    if (await backend.confirm(`Delete ${c.from}'s comment${label(c.t) && ` at ${label(c.t)}`}${c.replies.length ? " and its replies" : ""}?`)) update((s) => deleteReview(s, c.id));
  };
  const send = () => {
    const body = reply.trim();
    if (!body) return;
    update((s) => { replyToReview(s, c.id, { from: user?.name || user?.email || "Me", ...(user?.email && { email: user.email }), text: body }); });
    setReply("");
    onReply();
  };
  return (
    <div className={`rv-thread ${selected ? "on" : ""} ${c.done ? "done" : ""}`} data-id={c.id} onClick={onOpen}>
      <div className="rv-top">
        <span className="av" style={{ background: c.done ? undefined : colour }}>{n || initials(c.from)}</span>
        <span className="who">{c.from}</span>
        <span className="when">{when(c.at)}</span>
        <span style={{ flex: 1 }} />
        {label(c.t) && <span className="tc">{label(c.t)}{c.t_out !== undefined && ` → ${label(c.t_out)}`}</span>}
      </div>
      <div className="rv-text">{c.text}</div>
      <div className="rv-meta" onClick={(e) => e.stopPropagation()}>
        {c.dept && <span className="chip">{deptName(c.dept, show)}</span>}
        {c.draw && <span title="Has a drawing"><Icon name="pencil" size="sm" /></span>}
        {c.source === "sheet" && <span className="chip">Sheet</span>}
        <span style={{ flex: 1 }} />
        <button className="link sm" onClick={onReply}>Reply</button>
        <button className={`link sm ${c.done ? "resolved" : ""}`} onClick={() => update((s) => setReviewDone(s, c.id, !c.done))}>
          <Icon name="check" size="sm" /> {c.done ? "Resolved" : "Resolve"}
        </button>
        <button className="link sm" title="Delete" onClick={remove}><Icon name="trash" size="sm" /></button>
      </div>
      {c.replies.map((r) => (
        <div key={r.id} className="rv-reply" onClick={(e) => e.stopPropagation()}>
          <b>{r.from}</b> <span className="when">{when(r.at)}</span>
          <button className="link sm del" title="Delete reply" onClick={() => update((s) => deleteReply(s, c.id, r.id))}><Icon name="x" size="sm" /></button>
          <div>{r.text}</div>
        </div>
      ))}
      {replying && (
        <div className="rv-reply-box" onClick={(e) => e.stopPropagation()}>
          <input autoFocus value={reply} placeholder="Reply…" onChange={(e) => setReply(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape") { e.preventDefault(); onReply(); } }} />
          <button className="sm" onClick={send}>Reply</button>
        </div>
      )}
    </div>
  );
}

/** A drawing over the picture: shown, or (live) drawn with the pointer. Kept as one SVG path in a 0–1000 square. */
function Drawing({ box, path, live, onChange }: { box: { left: number; top: number; width: number; height: number }; path: string; live: boolean; onChange: (p: string) => void }) {
  const stroke = useRef<string | null>(null);
  const before = useRef(""); // the strokes before this one
  const point = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000); // a stroke dragged off the picture stops at its edge
    return `${at((e.clientX - r.left) / r.width)} ${at((e.clientY - r.top) / r.height)}`;
  };
  return (
    <svg className={`rv-draw ${live ? "live" : ""}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" style={box}
         onPointerDown={live ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); before.current = path; stroke.current = `M${point(e)}`; onChange(`${path} ${stroke.current}`.trim()); } : undefined}
         onPointerMove={live ? (e) => { if (stroke.current === null) return; stroke.current += ` L${point(e)}`; onChange(`${before.current} ${stroke.current}`.trim()); } : undefined}
         onPointerUp={live ? () => { stroke.current = null; } : undefined}>
      <path d={path} />
    </svg>
  );
}

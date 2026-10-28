// Thumbnails only, the import flow's last step: each song's best few frames, one song at a time, to pick its still
// from. Clicking one grabs it full size, files it in the record's category (see pickStill in jobs.ts) and moves on to
// the next song. Below them, a scrubber through the song for any other frame. Keys: 1–3 pick a frame, ←/→ move
// between songs (or, on the scrubber, step a frame; Enter uses it).
import { useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { pickStill } from "../jobs";
import { categoryName, clipTimeAt, guessRecordLabel } from "../model/ops";
import type { SourceRecord } from "../model/types";
import { type StillPick, useStore } from "../store";
import { Icon } from "./icons";
import { formatTime } from "./SongDrawer";

export function StillPicker() {
  const picks = useStore((s) => s.stillPicks);
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const [at, setAt] = useState<string | null>(() => useStore.getState().pickFocus); // the pick on screen
  const order = [...show.set_order, ...show.archive];
  const sorted = [...picks].sort((a, b) => order.indexOf(a.songId) - order.indexOf(b.songId));
  const i = Math.max(0, sorted.findIndex((p) => p.id === at));
  const p = sorted[i];

  function choose(time: number) {
    if (!p || p.saving) return;
    setAt((sorted[i + 1] ?? sorted[i - 1])?.id ?? null);
    // Back to it if it couldn't be saved, rather than leaving someone on the next song.
    pickStill(bundle, p.id, time).then((ok) => { if (!ok) setAt(p.id); });
  }
  const go = (d: number) => sorted[i + d] && setAt(sorted[i + d].id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const n = Number(e.key);
      if (n >= 1 && p?.candidates[n - 1]) choose(p.candidates[n - 1].time);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!p) return null;
  const song = show.songs[p.songId];
  const record = show.records?.find((r) => r.id === p.recordId);
  const col = show.columns.find((c) => c.id === (record?.image_col ?? "hero"));
  const pos = show.set_order.indexOf(p.songId);
  return (
    <div className="still-picker">
      <div className="sp-head">
        <span className="n">{pos >= 0 ? String(pos + 1).padStart(2, "0") : "··"}</span>
        <div style={{ minWidth: 0 }}>
          <h2>{song?.fields.name || "Song"}</h2>
          <div className="muted small">{[record?.label ?? (record ? guessRecordLabel(show, record.path) : ""), col ? categoryName(col, show) : ""].filter(Boolean).join(" · ")}</div>
        </div>
        <span className="sp-nav">
          <span className="mono small muted">{i + 1} of {sorted.length}</span>
          <button className="icon" disabled={i === 0} onClick={() => go(-1)} title="Previous song (←)"><Icon name="chevL" /></button>
          <button className="icon" disabled={i === sorted.length - 1} onClick={() => go(1)} title="Next song (→)"><Icon name="chevR" /></button>
        </span>
      </div>
      <div className="sp-choices">
        {p.finding && !p.candidates.length && [0, 1, 2].map((k) => <div key={k} className="sp-choice"><span className="ph">{k === 1 ? "Finding the best frames…" : ""}</span></div>)}
        {!p.finding && !p.candidates.length && <div className="sp-choice"><span className="ph">No frames found: scrub for one below</span></div>}
        {p.candidates.map((c, k) => (
          <button key={k} className={`sp-choice ${p.current === c.time ? "on" : ""}`} disabled={p.saving} onClick={() => choose(c.time)}
                  title={p.current === c.time ? `In use: click to keep it (${k + 1})` : `Use the frame at ${formatTime(c.time)} (${k + 1})`}>
            {c.path ? <img src={backend.fileUrl(c.path)} alt="" draggable={false} /> : <span className="ph">Frame at {formatTime(c.time)}</span>}
            {p.current === c.time && <span className="use">In use</span>}
            <span className="key">{k + 1}</span>
            <span className="tm">{formatTime(c.time)}</span>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: "10px 0 0" }}>Click the best frame: it's saved full size in the record's category and the next song comes up.{p.replaces && !p.auto ? "" : " Until you pick, the song uses the top frame."}</p>
      {p.clip && <p className="muted small" style={{ margin: "6px 0 0" }}>{record?.name ?? "The record"} isn't on this Mac, so these frames come from the song's clip of it{song?.clips?.find((c) => c.path === p.clip)?.burn_tc ? ", with its TC drawn in" : ""}.</p>}
      {record && <Scrubber key={p.id} pick={p} record={record} onUse={choose} />}
    </div>
  );
}

/** Any frame of the song, not just the suggested ones: drag through it, then use the frame on screen. */
function Scrubber({ pick, record, onUse }: { pick: StillPick; record: SourceRecord; onUse: (time: number) => void }) {
  const { in: lo, out: hi } = pick.mark;
  const [t, setT] = useState(pick.current ?? pick.candidates[0]?.time ?? lo);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const bundle = useStore((s) => s.bundle)!;
  // Times are the record's; the song's clip (when the record isn't here) starts at its in, less any pauses cut out.
  const at = (time: number) => (pick.clip ? Math.max(0, clipTimeAt(pick.mark, time)) : time);
  const seek = (to: number) => {
    const next = Math.min(hi, Math.max(lo, to));
    setT(next);
    if (video.current) video.current.currentTime = at(next);
  };
  return (
    <div className="sp-scrub">
      <div className="sp-frame">
        <video ref={video} src={pick.clip ? backend.mediaUrl(bundle, pick.clip) : backend.streamUrl(record.path)} preload="auto" muted playsInline
               onLoadedMetadata={(e) => { e.currentTarget.currentTime = at(t); }} onError={() => setFailed(true)} />
        {failed && <span className="ph">This video won't play here</span>}
        <span className="tm">{formatTime(t)}</span>
      </div>
      <div className="sp-scrub-ctl">
        <div className="small" style={{ fontWeight: 500 }}>Or find your own frame</div>
        <input type="range" min={lo} max={hi} step={0.04} value={t} disabled={pick.saving}
               onChange={(e) => seek(Number(e.target.value))}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onUse(t); } }} />
        <div className="sp-scrub-row">
          <span className="mono small muted">{formatTime(lo)} – {formatTime(hi)}</span>
          <button className="primary" disabled={pick.saving || failed} onClick={() => onUse(t)}><Icon name="camera" size="sm" /> Use this frame</button>
        </div>
        <span className="muted small">Drag through the song; with the slider focused, ←/→ step a frame and Enter uses it.</span>
      </div>
    </div>
  );
}

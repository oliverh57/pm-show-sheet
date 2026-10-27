// Pick a song's thumbnail from its video: three suggestions (bright, sharp, colourful frames, spread
// across the song), or scrub the video and take any frame.
import { useEffect, useRef, useState } from "react";
import { backend, type ThumbCandidate } from "../backend";
import { replaceStill } from "../jobs";
import { clipLength, clipName } from "../model/ops";
import type { Clip, Show, Song } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";
import { formatTime } from "./SongDrawer";
import { useVideoHelpers } from "./videoGestures";

interface Source { path: string; start: number; end: number }

const clipSource = (bundle: string, clip: Clip): Source => ({ path: `${bundle}/${clip.path}`, start: 0, end: clipLength(clip) });

/** The video to take a song's frames from: its clip in the show if it has one, else its stretch of a show record. */
export function thumbSource(show: Show, bundle: string, song: Song): Source | null {
  const clip = song.clips?.[song.clips.length - 1];
  if (clip) return clipSource(bundle, clip);
  for (const r of show.records ?? []) {
    const m = r.song_marks?.find((x) => x.song_id === song.id);
    if (m) return { path: r.path, start: m.in, end: m.out };
    if (r.scope === "song" && r.song_id === song.id && r.info?.duration) return { path: r.path, start: 0, end: r.info.duration };
  }
  return null;
}

/** Is this one of the stills the app grabbed from video (so a better frame can be picked)? */
export const isGrab = (path: string) => path.startsWith("media/grabs/");

/** `clip` picks that clip's still (from its own video); without one, the song's from its latest clip or record. */
export function ThumbPicker({ song, replace, clip, onClose }: { song: Song; replace: string | null; clip?: Clip; onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, toast } = useStore.getState();
  const source = clip ? clipSource(bundle, clip) : thumbSource(show, bundle, song)!;
  const [suggestions, setSuggestions] = useState<ThumbCandidate[] | null>(null);
  const [t, setT] = useState(source.start + Math.min(5, (source.end - source.start) / 2));
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const { overlay } = useVideoHelpers(video, source.path);

  useEffect(() => {
    let live = true;
    backend.thumbCandidates(source.path, source.start, source.end, 3).then((c) => live && setSuggestions(c), () => live && setSuggestions([]));
    return () => { live = false; };
  }, [source.path, source.start, source.end]);

  useEffect(() => {
    const v = video.current;
    if (v && Math.abs(v.currentTime - t) > 0.04) v.currentTime = t;
  }, [t]);

  async function use(time: number) {
    setSaving(true);
    try {
      const still = await backend.grabFrame(bundle, source.path, time, clipName(show, song.id));
      update((s) => {
        replaceStill(s, song.id, replace, still);
        const c = clip && s.songs[song.id].clips?.find((x) => x.path === clip.path);
        if (c) c.still = still;
      });
      toast("Thumbnail updated");
      onClose();
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Choose a thumbnail" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
        <div className="modal-head"><div><h3>Choose a thumbnail</h3><p>{song.fields.name || "Song"}</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <span className="field-label">Suggested</span>
          <div className="thumb-row">
            {suggestions === null && [0, 1, 2].map((i) => <div key={i} className="thumb loading"><span className="spinner" /></div>)}
            {suggestions?.map((c) => (
              <button key={c.path} className="thumb" disabled={saving} onClick={() => use(c.time)} title={`Use the frame at ${formatTime(c.time - source.start)}`}>
                <img src={backend.fileUrl(c.path)} alt="" /><span className="at">{formatTime(c.time - source.start)}</span>
              </button>
            ))}
            {suggestions?.length === 0 && <p className="muted small" style={{ gridColumn: "1 / -1", margin: 0 }}>{backend.isDesktop ? "No good frames found. Scrub below to pick one." : "Suggestions need the desktop app."}</p>}
          </div>
          <span className="field-label" style={{ marginTop: 16 }}>Or pick a frame</span>
          <div className="video-wrap">
            <video ref={video} className="thumb-video" src={backend.streamUrl(source.path)} preload="auto" muted playsInline
                   onLoadedMetadata={(e) => { e.currentTarget.currentTime = t; }}
                   onSeeked={(e) => setT(Math.min(source.end, Math.max(source.start, e.currentTarget.currentTime)))} />
            {overlay}
          </div>
          <div className="thumb-scrub">
            <span className="mono small">{formatTime(t - source.start)}</span>
            <input type="range" min={source.start} max={source.end} step={0.04} value={t} onChange={(e) => setT(Number(e.target.value))} />
            <span className="mono small muted">{formatTime(source.end - source.start)}</span>
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving} onClick={() => use(t)}>{saving ? "Saving…" : "Use this frame"}</button>
        </div>
      </div>
    </div>
  );
}

// Video helpers shared by every player: a two-finger sideways swipe on the trackpad scrubs (fingers left goes
// forward, right goes back, like dragging the picture along a timeline), and a "Loading…" note while it buffers.
import { useEffect, useRef, useState } from "react";
import { formatTime } from "./SongDrawer";

/** Seconds per pixel of swipe: a long show record moves further per swipe than a short clip. */
const pace = (duration: number) => Math.min(0.5, Math.max(0.02, (duration || 60) / 2000));

export function useVideoHelpers(ref: React.RefObject<HTMLVideoElement | null>, key?: string) {
  const [scrub, setScrub] = useState<{ at: number; delta: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const gesture = useRef<{ from: number; target: number; frame: number; settle: number; hide: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !Number.isFinite(el.duration)) return;
      e.preventDefault(); // and no swipe-back navigation
      const g = gesture.current ?? { from: el.currentTime, target: el.currentTime, frame: 0, settle: 0, hide: 0 };
      gesture.current = g;
      g.target = Math.min(el.duration, Math.max(0, g.target + e.deltaX * pace(el.duration)));
      setScrub({ at: g.target, delta: g.target - g.from });
      // Seek once a frame while swiping (fast, to a nearby keyframe), then exactly where it stopped.
      cancelAnimationFrame(g.frame);
      g.frame = requestAnimationFrame(() => {
        const fast = (el as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
        if (fast) fast.call(el, g.target); else el.currentTime = g.target;
      });
      window.clearTimeout(g.settle);
      window.clearTimeout(g.hide);
      g.settle = window.setTimeout(() => {
        el.currentTime = g.target;
        gesture.current = null;
        g.hide = window.setTimeout(() => setScrub(null), 700);
      }, 160);
    };
    const busy = () => setLoading(true);
    const ready = () => setLoading(false);
    el.addEventListener("wheel", onWheel, { passive: false });
    const waits = ["loadstart", "waiting", "seeking"], readies = ["canplay", "playing", "seeked", "error", "loadeddata"];
    waits.forEach((t) => el.addEventListener(t, busy));
    readies.forEach((t) => el.addEventListener(t, ready));
    return () => {
      el.removeEventListener("wheel", onWheel);
      waits.forEach((t) => el.removeEventListener(t, busy));
      readies.forEach((t) => el.removeEventListener(t, ready));
    };
  }, [ref, key]);

  const overlay = (
    <>
      {scrub && (
        <div className="scrub-hud">
          <span className="arrow">{scrub.delta >= 0 ? "»" : "«"}</span>
          <span className="at">{formatTime(scrub.at)}</span>
          <span className="by">{scrub.delta >= 0 ? "+" : "−"}{formatTime(Math.abs(scrub.delta))}</span>
        </div>
      )}
      {loading && !scrub && <div className="video-loading"><div className="spinner" /> Loading…</div>}
    </>
  );
  return { overlay };
}

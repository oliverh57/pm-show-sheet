// Video and audio playback. When a file carries LTC on one audio channel (found by the timecode scan),
// that channel is left out so you hear the programme audio, not the timecode buzz.
import { useEffect, useRef } from "react";
import { backend } from "../backend";
import { ltcFromName } from "../model/ops";
import { Icon } from "./icons";
import { useVideoHelpers } from "./videoGestures";

// A media element can only be wired into Web Audio once, so graphs are kept per element and closed
// shortly after the last user lets go (React's dev double-mount would otherwise break the second wiring).
const graphs = new WeakMap<HTMLMediaElement, { ctx: AudioContext; users: number; closing?: number }>();

/**
 * Route a media element's audio through Web Audio, dropping channel `ltc`. The programme channel(s)
 * play on both speakers. Returns a cleanup function. The element needs crossOrigin="anonymous" (the
 * Tauri asset protocol sends CORS headers), otherwise Web Audio would only hear silence.
 */
export function dropChannel(el: HTMLMediaElement, ltc: number, channels = 2): () => void {
  let g = graphs.get(el);
  if (g) {
    window.clearTimeout(g.closing);
    g.users++;
  } else {
    try {
      const ctx = new AudioContext();
      const n = Math.max(channels, ltc + 1, 2);
      const keep = Array.from({ length: n }, (_, i) => i).filter((c) => c !== ltc);
      const source = ctx.createMediaElementSource(el);
      const split = ctx.createChannelSplitter(n);
      const merge = ctx.createChannelMerger(2);
      source.connect(split);
      split.connect(merge, keep[0], 0);
      split.connect(merge, keep[1] ?? keep[0], 1);
      merge.connect(ctx.destination);
      el.addEventListener("play", () => ctx.resume());
      g = { ctx, users: 1 };
      graphs.set(el, g);
    } catch {
      el.muted = true; // better silent than the timecode
      return () => {};
    }
  }
  const graph = g;
  return () => {
    graph.users--;
    if (graph.users === 0) graph.closing = window.setTimeout(() => { graph.ctx.close(); graphs.delete(el); }, 1000);
  };
}

/** Hook form of dropChannel for a ref'd element; does nothing when there's no LTC channel. */
export function useDropLtc(ref: React.RefObject<HTMLMediaElement | null>, ltc: number | null | undefined, channels: number | null | undefined, key: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el || ltc === null || ltc === undefined) return;
    return dropChannel(el, ltc, channels ?? 2);
  }, [ref, ltc, channels, key]);
}

interface Props {
  path: string; // absolute path on disk
  video: boolean;
  ltc?: number | null; // 0-based audio channel carrying LTC (read from an `_LTC-L`/`_LTC-R` name if not given)
  channels?: number | null;
  autoPlay?: boolean;
  mediaRef?: React.RefObject<HTMLVideoElement | null>;
}

export function MediaPlayer({ path, video, ltc: given, channels, autoPlay, mediaRef }: Props) {
  const ltc = given ?? ltcFromName(path);
  const own = useRef<HTMLVideoElement>(null);
  const ref = mediaRef ?? own;
  useDropLtc(ref, ltc, channels, path);
  const { overlay } = useVideoHelpers(ref, path);
  const hasLtc = ltc !== null && ltc !== undefined;
  const common = { controls: true, autoPlay, preload: "metadata" as const, src: backend.streamUrl(path), crossOrigin: hasLtc ? ("anonymous" as const) : undefined };
  return (
    <div className="player-inline">
      {video ? <div className="video-wrap"><video key={path} ref={ref} {...common} playsInline />{overlay}</div> : <audio key={path} ref={ref as React.RefObject<HTMLAudioElement | null>} {...common} />}
      {hasLtc && <span className="muted small"><Icon name="radio" size="sm" /> Timecode (channel {ltc + 1}) muted</span>}
    </div>
  );
}

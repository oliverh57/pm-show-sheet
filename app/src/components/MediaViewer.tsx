// A song's images and clips full screen, one at a time, with ways to save them. ← → step through them, Esc closes.
// Each image, clip and record opens with its comments beside it (Review). Also where a song's media is listed for Present (mediaOf).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import { categories, clipLength, imageCategory, imageReviews, isHeroImage, reviewsOn, songRecords } from "../model/ops";
import type { ReviewComment, Show, Song } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";
import { MediaPlayer } from "./Player";
import { Review, type ReviewAnchor, type ReviewTarget } from "./Review";
import { SaveCopy, SongSaveMenu } from "./SaveCopy";
import { formatTime } from "./SongDrawer";

export type Item =
  | { key: string; kind: "image"; src: string; label: string } // src is bundle-relative
  | { key: string; kind: "video"; path: string; thumb?: string; label: string; ltc?: number | null; channels?: number | null; review?: ReviewAnchor };

/** Everything the song has to look at: its main image first, the rest of its images, its clips, then its records. */
export function mediaOf(show: Show, bundle: string, song: Song): Item[] {
  const names = new Map(categories(show).map((c) => [c.id, c.name]));
  const gallery = (song.gallery ?? []).filter((p) => !isHeroImage(song, p));
  return [
    ...(song.hero ? [{ key: song.hero, kind: "image" as const, src: song.hero, label: "Main image" }] : []),
    ...gallery.map((p) => ({ key: p, kind: "image" as const, src: p, label: names.get(imageCategory(show, song, p)) ?? "Image" })),
    ...(song.clips ?? []).map((c) => ({ key: c.path, kind: "video" as const, path: `${bundle}/${c.path}`, thumb: c.still, label: `Clip ${formatTime(c.in)} – ${formatTime(c.out)}${c.cuts ? ` (${formatTime(clipLength(c))} with pauses cut)` : ""}`,
      review: { record_id: c.record_id, offset: c.in, from: c.in, to: c.out, cuts: c.cuts } })),
    ...songRecords(show, song.id).map((r) => ({ key: r.id, kind: "video" as const, path: r.path, label: r.label || r.name, ltc: r.ltc?.channel, channels: r.info?.audio_channels,
      review: { record_id: r.id, offset: 0, from: 0, to: Infinity } })),
  ];
}

/** The comments on an item: an image's, or those in a clip's (or record's) stretch of its record. */
export function itemComments(show: Show, item: Item): ReviewComment[] {
  if (item.kind === "image") return imageReviews(show, item.src);
  return item.review ? reviewsOn(show, item.review.record_id, item.review.from, item.review.to) : [];
}

/** What Review comments on for an item, given the element showing it. */
export function reviewTarget(item: Item, video: React.RefObject<HTMLVideoElement | null>, image: React.RefObject<HTMLImageElement | null>): ReviewTarget | undefined {
  if (item.kind === "image") return { kind: "image", path: item.src, ref: image };
  return item.review && { kind: "video", anchor: item.review, source: item.path, ref: video };
}

/** The item a comment is on (an image, or the first clip or record with its time in), to open it at; none for one with no place. */
export function commentItem(show: Show, bundle: string, song: Song, c: ReviewComment): string | undefined {
  return mediaOf(show, bundle, song).find((item) => itemComments(show, item).some((x) => x.id === c.id))?.key;
}

const REVIEW_KEY = "pm.review"; // the comments panel shown or hidden, per Mac

interface Props {
  song: Song;
  start: string; // the key (image path, clip path) to open on
  play?: boolean; // start that clip playing, even with the comments beside it
  comment?: string; // open on this comment (on the `start` item), with the comments shown
  onClose: () => void;
}

export function MediaViewer({ song, start, play, comment, onClose }: Props) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const focusSong = useStore((s) => s.focusSong);
  const items = mediaOf(show, bundle, song);
  // An image only in a category (not in the gallery) still opens.
  if (!items.some((x) => x.key === start)) items.unshift({ key: start, kind: "image", src: start, label: "Image" });
  const [key, setKey] = useState(start);
  const [reviewing, setReviewing] = useState(() => { try { return Boolean(comment) || localStorage.getItem(REVIEW_KEY) !== "off"; } catch { return true; } });
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const at = Math.max(0, items.findIndex((x) => x.key === key));
  const item = items[at];
  const step = (d: number) => setKey(items[(at + d + items.length) % items.length].key);
  // The second click of a double-click lands on the viewer: it mustn't close it straight away.
  const opened = useRef(performance.now());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inMedia = e.target instanceof HTMLMediaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === "Escape" && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) (e.target as HTMLElement).blur(); // leave the comment box, not the viewer
      else if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && !inMedia && items.length > 1) step(-1);
      else if (e.key === "ArrowRight" && !inMedia && items.length > 1) step(1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation(); // before the app's own keys (Esc closing the drawer, Present's ← →)
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!item) return null;
  const abs = (p: string) => (p.startsWith("/") ? p : `${bundle}/${p}`);
  const file = item.kind === "image" ? abs(item.src) : item.path;
  const position = show.set_order.indexOf(song.id);
  const target = reviewTarget(item, videoRef, imageRef);
  const review = Boolean(target);
  const open = itemComments(show, item).filter((c) => !c.done).length;
  const toggleReview = () => {
    setReviewing(!reviewing);
    try { localStorage.setItem(REVIEW_KEY, reviewing ? "off" : "on"); } catch { /* storage unavailable */ }
  };

  return createPortal(
    <div className={`viewer ${review && reviewing ? "reviewing" : ""}`} role="dialog" aria-label={`${song.fields.name || "Untitled"}: ${item.label}`}
         onMouseDown={(e) => e.target === e.currentTarget && performance.now() - opened.current > 400 && onClose()}>
      <div className="viewer-bar">
        <div className="title">
          <b>{position >= 0 ? `${String(position + 1).padStart(2, "0")} ` : ""}{song.fields.name || "Untitled"}</b>
          <span>{item.label}{items.length > 1 && ` · ${at + 1} of ${items.length}`}</span>
        </div>
        <div className="acts">
          {review && (
            <button className={`sm review-toggle ${reviewing ? "on" : ""}`} title={reviewing ? "Hide comments" : "Show comments (C to write one)"} onClick={toggleReview}>
              <Icon name="comment" size="sm" /> {open ? `${open} open` : "Comments"}
            </button>
          )}
          <SaveCopy key={file} path={file} ltc={item.kind === "video" ? item.ltc : null} video={item.kind === "video"} />
          <SongSaveMenu show={show} bundle={bundle} song={song} />
          <button className="icon" title="Open the song" onClick={() => { onClose(); focusSong(song.id, item.kind === "image" ? "renders" : "records"); }}><Icon name="pencil" size="sm" /></button>
          <button className="icon" title="Close (Esc)" onClick={onClose}><Icon name="x" /></button>
        </div>
      </div>
      <div className="viewer-stage" ref={setStage} onMouseDown={(e) => e.target === e.currentTarget && performance.now() - opened.current > 400 && onClose()}>
        {items.length > 1 && <button className="icon nav prev" title="Previous (←)" onClick={() => step(-1)}><Icon name="chevL" /></button>}
        {item.kind === "image"
          ? <img key={item.key} ref={imageRef} src={backend.mediaUrl(bundle, item.src)} alt={item.label} draggable={false} />
          : <MediaPlayer key={item.key} path={item.path} video autoPlay={!(review && reviewing) || (play && item.key === start)} controls={!(review && reviewing)} ltc={item.ltc} channels={item.channels} mediaRef={videoRef} />}
        {items.length > 1 && <button className="icon nav next" title="Next (→)" onClick={() => step(1)}><Icon name="chevR" /></button>}
      </div>
      {target && reviewing && (
        <Review key={item.key} show={show} songId={song.id} target={target} stage={stage} itemKey={item.key} focus={item.key === start ? comment : undefined} />
      )}
      <div className="viewer-foot">{file.split("/").pop()}</div>
    </div>,
    document.body,
  );
}

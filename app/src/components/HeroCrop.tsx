// Crop a song's hero photo to the 16:9 frame the previews, Sheet and slides show: drag the box to
// move it, drag a corner to resize it. The original stays in the gallery so it can be cropped again.
import { useRef, useState } from "react";
import { backend } from "../backend";
import { clipName, setHero, setHeroCrop } from "../model/ops";
import type { CropRect, Song } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";

const ASPECT = 16 / 9;
const MIN_W = 0.08;
type Corner = "nw" | "ne" | "sw" | "se";

/** The largest centred 16:9 box on an image of this aspect (what a cover-fit preview shows). */
function fullCrop(imgAspect: number): CropRect {
  const w = Math.min(1, ASPECT / imgAspect);
  const h = Math.min(1, imgAspect / ASPECT);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function HeroCrop({ song, src, onClose, onPickFrame }: { song: Song; src: string; onClose: () => void; onPickFrame?: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, toast } = useStore.getState();
  const [imgAspect, setImgAspect] = useState<number | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [saving, setSaving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const cropped = song.hero_crop?.src === src;

  function loaded(img: HTMLImageElement) {
    const a = img.naturalWidth / img.naturalHeight;
    setImgAspect(a);
    const prev = song.hero_crop;
    setCrop(prev && prev.src === src ? { x: prev.x, y: prev.y, w: prev.w, h: prev.h } : fullCrop(a));
  }

  /** Follow the pointer from a press on the box (move) or a corner (resize from the opposite corner). */
  function drag(e: React.PointerEvent, corner: Corner | null) {
    if (!crop || !imgAspect || !stage.current) return;
    e.preventDefault();
    e.stopPropagation();
    const box = stage.current.getBoundingClientRect();
    const r = imgAspect / ASPECT; // crop height = width × r, in fractions
    const start = { ...crop }, px0 = e.clientX, py0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const fx = (ev.clientX - box.left) / box.width, fy = (ev.clientY - box.top) / box.height;
      if (!corner) {
        const dx = (ev.clientX - px0) / box.width, dy = (ev.clientY - py0) / box.height;
        setCrop({ ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) });
        return;
      }
      const sx = corner.includes("w") ? -1 : 1, sy = corner.includes("n") ? -1 : 1;
      const ax = sx > 0 ? start.x : start.x + start.w, ay = sy > 0 ? start.y : start.y + start.h;
      const maxW = Math.min(sx > 0 ? 1 - ax : ax, (sy > 0 ? 1 - ay : ay) / r);
      const w = clamp(Math.max(sx * (fx - ax), (sy * (fy - ay)) / r), Math.min(MIN_W, maxW), maxW);
      const h = w * r;
      setCrop({ x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function save() {
    if (!crop) return;
    setSaving(true);
    try {
      const path = await backend.cropImage(bundle, src.startsWith("/") ? src : `${bundle}/${src}`, crop, clipName(show, song.id));
      update((s) => setHeroCrop(s, song.id, src, crop, path));
      toast("Image cropped");
      onClose();
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
      setSaving(false);
    }
  }

  function uncrop() {
    update((s) => setHero(s, song.id, src));
    toast("Showing the whole image");
    onClose();
  }

  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Crop the image" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
        <div className="modal-head"><div><h3>Crop the image</h3><p>{song.fields.name || "Song"} · drag the box to move it, or a corner to resize</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <div className="crop-wrap">
            <div className="crop-stage" ref={stage}>
              <img src={src.startsWith("/") ? backend.fileUrl(src) : backend.mediaUrl(bundle, src)} alt="" draggable={false} onLoad={(e) => loaded(e.currentTarget)} />
              {crop && (
                <div className="crop-box" style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }} onPointerDown={(e) => drag(e, null)}>
                  {(["nw", "ne", "sw", "se"] as Corner[]).map((c) => <span key={c} className={`crop-handle ${c}`} onPointerDown={(e) => drag(e, c)} />)}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">
            {onPickFrame && <button className="link" onClick={onPickFrame}>Pick a frame from the video instead</button>}
          </span>
          {cropped && <button onClick={uncrop}>Don't crop</button>}
          <button onClick={() => imgAspect && setCrop(fullCrop(imgAspect))} disabled={!imgAspect}>Reset</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving || !crop} onClick={save}>{saving ? "Saving…" : "Save crop"}</button>
        </div>
      </div>
    </div>
  );
}

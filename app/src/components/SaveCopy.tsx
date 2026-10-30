// "Save as…" for any media in the show: a copy goes wherever you choose (Downloads to start with).
// A file that carries LTC on one audio channel can be saved as it is, or with the timecode taken out.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import { ltcFromName, songAudio, songRecords } from "../model/ops";
import type { Show, Song } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";

interface Way {
  title: string;
  hint: string;
  name: string; // default file name
  source: string; // the file it's saved from
  drop: number | null; // audio channel to leave out (the LTC)
  audioOnly: boolean;
}

/**
 * The ways a file can be saved: just as it is, or (with LTC) with and without the timecode. `ltc` comes
 * from the timecode scan, or from a clip's `_LTC-L`/`_LTC-R` name.
 */
export function saveWays(path: string, ltc: number | null | undefined, video: boolean): Way[] {
  ltc = ltc ?? ltcFromName(path);
  const name = path.split("/").pop() ?? "media";
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/_LTC-[LR]$/i, "");
  const ext = dot > 0 ? name.slice(dot) : "";
  const original = { name, source: path, drop: null, audioOnly: false };
  if (ltc === null) return [{ title: "Save as…", hint: "", ...original }];
  const ch = `channel ${ltc + 1}${ltcFromName(path) === null ? "" : ` (${ltc ? "right" : "left"})`}`;
  return [
    { title: "With timecode", hint: `The original file, LTC on ${ch}`, ...original },
    ...(video ? [{ title: "Without timecode", hint: `Same picture, ${ch} taken out`, name: `${stem} - no LTC${ext}`, source: path, drop: ltc, audioOnly: false }] : []),
    { title: "Audio only", hint: `${video ? "Programme audio" : `${ch} taken out`} · WAV`, name: `${stem} - ${video ? "audio" : "no LTC"}.wav`, source: path, drop: ltc, audioOnly: true },
  ];
}

interface MenuPos { top?: number; bottom?: number; left: number; maxHeight: number }

/** Saving one copy at a time, with its progress (0–1) while it runs. */
export function useSaver() {
  const toast = useStore((s) => s.toast);
  const [progress, setProgress] = useState<number | null>(null);
  async function save(way: Way) {
    const dest = await backend.chooseSavePath(way.name);
    if (!dest) return;
    setProgress(0);
    try {
      await backend.saveCopy(`save-${Date.now()}-${Math.random()}`, way.source, dest, way.drop, way.audioOnly, setProgress);
      const folder = dest.split("/").slice(-2, -1)[0];
      toast(`Saved “${dest.split("/").pop()}”${folder ? ` to ${folder}` : ""}`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    }
    setProgress(null);
  }
  return { progress, save };
}

/**
 * A menu that hangs off `button` (or rises above it near the bottom of the window) and closes on any click or
 * scroll outside `wrap` and the menu. The menu is drawn into the page body (see MenuPopup), so a container
 * with a transform, like the song drawer while its slide-in animation holds, can't move it off screen.
 */
export function useMenu(wrap: React.RefObject<HTMLElement | null>, button: React.RefObject<HTMLButtonElement | null>, width: number) {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pos) return;
    const outside = (e: Event) => !wrap.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node) && setPos(null);
    const close = () => setPos(null);
    window.addEventListener("click", outside, true); // capture, so a menu in a card that stops clicks still closes the others
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [pos, wrap]);
  function toggle() {
    if (pos) return setPos(null);
    const r = button.current!.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    const up = r.top > window.innerHeight - r.bottom;
    setPos(up ? { bottom: window.innerHeight - r.top + 4, left, maxHeight: r.top - 12 } : { top: r.bottom + 4, left, maxHeight: window.innerHeight - r.bottom - 12 });
  }
  return { pos, popup, toggle, close: () => setPos(null) };
}

export function MenuPopup({ menu, className, children }: { menu: ReturnType<typeof useMenu>; className?: string; children: ReactNode }) {
  if (!menu.pos) return null;
  return createPortal(<div ref={menu.popup} className={["save-menu", className].filter(Boolean).join(" ")} style={menu.pos}>{children}</div>, document.body);
}

/** `ltc`: the 0-based audio channel carrying timecode, if the scan found one. */
export function SaveCopy({ path, ltc, video = false, compact }: { path: string; ltc?: number | null; video?: boolean; compact?: boolean }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { progress, save } = useSaver();
  const menu = useMenu(wrap, button, 270);
  const ways = saveWays(path, ltc, video);
  const pick = (way: Way) => { menu.close(); save(way); };

  const busy = progress !== null;
  const label = busy ? `Saving ${Math.round(progress * 100)}%` : compact ? "" : "Save as…";
  return (
    <span className="save-copy" ref={wrap}>
      <button ref={button} className={compact && !busy ? "icon" : "sm"} disabled={busy} onClick={() => (ways.length === 1 ? pick(ways[0]) : menu.toggle())}
              title={ways.length > 1 ? "Save a copy: with or without the timecode" : "Save a copy to a folder you choose"}>
        <Icon name="download" size="sm" />{label && ` ${label}`}{ways.length > 1 && !busy && !compact && <Icon name="chevDown" size="sm" />}
      </button>
      <MenuPopup menu={menu}>
        {ways.map((w) => (
          <button key={w.title} onClick={() => pick(w)}><span>{w.title}</span><small>{w.hint}</small></button>
        ))}
      </MenuPopup>
    </span>
  );
}

interface SongFile { path: string; name: string; ltc?: number | null; video: boolean }

/** Everything that can be saved from a song: its renders and stills, clips, records and audio versions. */
export function songFiles(show: Show, bundle: string, song: Song): { group: string; files: SongFile[] }[] {
  const name = (p: string) => p.split("/").pop() ?? p;
  const images = song.gallery ?? (song.hero ? [song.hero] : []);
  return [
    { group: "Renders & stills", files: images.map((p) => ({ path: `${bundle}/${p}`, name: name(p), video: false })) },
    { group: "Clips", files: [
      ...(song.clips ?? []).map((c) => ({ path: `${bundle}/${c.path}`, name: name(c.path), video: true })),
      ...songRecords(show, song.id).map((r) => ({ path: r.path, name: r.name, ltc: r.ltc?.channel, video: true })),
    ] },
    { group: "Audio", files: songAudio(show, song.id).map((a) => ({ path: a.path, name: a.version ? `${a.version} · ${a.name}` : a.name, ltc: a.ltc?.channel, video: false })) },
  ].filter((g) => g.files.length > 0);
}

/** The download button on a song card: one menu with all the song's media, with and without timecode where it has LTC. */
export function SongSaveMenu({ show, bundle, song, className }: { show: Show; bundle: string; song: Song; className?: string }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { progress, save } = useSaver();
  const menu = useMenu(wrap, button, 300);
  const groups = songFiles(show, bundle, song);
  if (!groups.length) return null;
  const pick = (way: Way) => { menu.close(); save(way); };
  const busy = progress !== null;
  return (
    <span className={["save-copy song-save", className, (busy || menu.pos) && "active"].filter(Boolean).join(" ")} ref={wrap}
          onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button ref={button} className={busy ? "sm" : "icon"} disabled={busy} onClick={menu.toggle} title="Download this song's media">
        <Icon name="download" size="sm" />{busy && ` Saving ${Math.round(progress * 100)}%`}
      </button>
      <MenuPopup menu={menu} className="wide">
        {groups.map((g) => (
          <div key={g.group} className="save-group">
            <div className="save-label">{g.group}</div>
            {g.files.map((f) => {
              const ways = saveWays(f.path, f.ltc, f.video);
              if (ways.length === 1) return <button key={f.path} onClick={() => pick(ways[0])} title={f.path}><span className="nm">{f.name}</span></button>;
              return (
                <div key={f.path} className="save-file">
                  <div className="save-name" title={f.path}>{f.name}</div>
                  {ways.map((w) => <button key={w.title} className="way" onClick={() => pick(w)}><span>{w.title}</span><small>{w.hint}</small></button>)}
                </div>
              );
            })}
          </div>
        ))}
      </MenuPopup>
    </span>
  );
}

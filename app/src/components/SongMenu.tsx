// Picking a song: search the show's songs (the set, numbered, then the archive), choose one with the mouse or ↑ ↓ ↵,
// or make a new one from what was typed. The same menu gives a marked region of a video its song, and each image added its song.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../store";
import { Icon } from "./icons";

interface MenuProps {
  current?: string;
  onPick: (id: string) => void;
  /** Make a song from what was typed (offered when nothing has that exact name). */
  onNew?: (name: string) => void;
  onClose: () => void;
  /** Choices before the songs, e.g. "Skip". */
  options?: { id: string; label: string }[];
  /** Shown at the end of a song's row (where else it's used). */
  extra?: (id: string) => ReactNode;
  title?: (id: string) => string | undefined;
  head?: ReactNode;
  foot?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function SongMenu({ current, onPick, onNew, onClose, options = [], extra, title, head, foot, className = "", style }: MenuProps) {
  const show = useStore((s) => s.show)!;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null); // the row ↑ ↓ moved to; null: the best match
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const name = (id: string) => show.songs[id]?.fields.name || "Untitled";
  const q = query.trim().toLowerCase();
  const match = (id: string) => !q || name(id).toLowerCase().includes(q);
  const set = show.set_order.filter(match);
  const archive = show.archive.filter(match);
  const opts = options.filter((o) => !q || o.label.toLowerCase().includes(q));
  const exact = [...show.set_order, ...show.archive].find((id) => name(id).toLowerCase() === q);
  const offerNew = Boolean(q && !exact && onNew);
  // Every row ↑ ↓ can reach, in the order shown: the new song, the options, the set, then the archive.
  const rows = [...(offerNew ? ["__new"] : []), ...opts.map((o) => o.id), ...set, ...archive];
  // With a search, the best row is the song with that name, else the first match (the new song only when nothing matches).
  const firstMatch = offerNew && rows.length > 1 ? 1 : 0;
  const best = exact ? rows.indexOf(exact) : q ? firstMatch : rows.indexOf(current ?? "");
  const on = active ?? best;

  useEffect(() => {
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [on]);

  const choose = (id: string) => (id === "__new" ? onNew?.(query.trim()) : onPick(id));
  const songNo = (id: string) => (show.set_order.includes(id) ? String(show.set_order.indexOf(id) + 1).padStart(2, "0") : "A");
  const cls = (id: string) => [id === current && "on", rows[on] === id && "active"].filter(Boolean).join(" ");
  const song = (id: string) => (
    <button key={id} className={cls(id)} onClick={() => onPick(id)} title={title?.(id)} onMouseMove={() => setActive(rows.indexOf(id))}>
      <span className="n">{songNo(id)}</span><span className="nm">{name(id)}</span>
      {id === current ? <Icon name="check" size="sm" /> : extra?.(id)}
    </button>
  );

  return (
    <div ref={root} className={`menu song-menu ${className}`} style={style} onPointerDown={(e) => e.stopPropagation()}>
      {head}
      <input autoFocus value={query} placeholder={onNew ? "Find or add a song" : "Find a song"}
             onChange={(e) => { setQuery(e.target.value); setActive(null); }}
             onKeyDown={(e) => {
               if (e.key === "Escape") { e.stopPropagation(); onClose(); }
               else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                 e.preventDefault();
                 const down = e.key === "ArrowDown";
                 if (rows.length) setActive(on < 0 ? (down ? 0 : rows.length - 1) : (on + (down ? 1 : -1) + rows.length) % rows.length);
               } else if (e.key === "Enter" && rows[on]) { e.preventDefault(); choose(rows[on]); }
             }} />
      <div className="rm-list" ref={list}>
        {offerNew && <button className={`rm-new ${rows[on] === "__new" ? "active" : ""}`} onClick={() => choose("__new")}><Icon name="plus" size="sm" /> New song “{query.trim()}”</button>}
        {opts.map((o) => <button key={o.id} className={`opt ${cls(o.id)}`} onClick={() => onPick(o.id)} onMouseMove={() => setActive(rows.indexOf(o.id))}><span className="nm">{o.label}</span>{o.id === current && <Icon name="check" size="sm" />}</button>)}
        {set.map(song)}
        {archive.length > 0 && <div className="mgroup">Archive</div>}
        {archive.map(song)}
        {rows.length === 0 && <div className="rm-none muted small">No songs match</div>}
      </div>
      {foot}
    </div>
  );
}

/** A select-like button that opens the song menu under it. */
export function SongPicker({ value, onChange, onNew, options, placeholder = "Choose a song…" }: {
  value: string; onChange: (id: string) => void; onNew?: (name: string) => string; options?: { id: string; label: string }[]; placeholder?: string;
}) {
  const show = useStore((s) => s.show)!;
  const [open, setOpen] = useState(false);
  const song = show.songs[value];
  const n = show.set_order.indexOf(value);
  const label = song ? song.fields.name || "Untitled" : options?.find((o) => o.id === value)?.label ?? placeholder;
  return (
    <div className="song-picker">
      <button className={`sp-btn ${song ? "set" : ""}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {song && <span className="n">{n >= 0 ? String(n + 1).padStart(2, "0") : "A"}</span>}
        <span className="nm">{label}</span>
        <Icon name="chevDown" size="sm" />
      </button>
      {open && (
        <SongMenu current={value} options={options} onClose={() => setOpen(false)}
                  onPick={(id) => { onChange(id); setOpen(false); }}
                  onNew={onNew && ((name) => { onChange(onNew(name)); setOpen(false); })} />
      )}
    </div>
  );
}

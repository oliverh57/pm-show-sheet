// Song detail sections: colours (gel library), for the lighting colours and any colour field, and the render gallery.
import { useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { type Gel, searchGels, swatchFill } from "../model/gels";
import { addImages, categories, deptCategory, ensureCategory, fieldSwatches, GENERAL, imageCategory, imageLabel, isHeroImage, MAX_SWATCHES, replaceImage, setHero, setImageCategory } from "../model/ops";
import { CategoriesDialog } from "./Categories";
import { useFileStates } from "./CloudFiles";
import { repickStill } from "../jobs";
import type { ColourSwatch, Song } from "../model/types";
import { deleteSongImage } from "../library";
import { useStore } from "../store";
import { DraftInput } from "./fields";
import { Icon } from "./icons";
import { SaveCopy } from "./SaveCopy";

const MAX_RESULTS = 8;

/** Colours for a search, best first: names that start with it, then words that do, then the rest. One per name. */
function matches(q: string) {
  const lower = q.toLowerCase();
  const rank = (label: string) => (label.toLowerCase().startsWith(lower) ? 0 : label.toLowerCase().split(/\s+/).some((w) => w.startsWith(lower)) ? 1 : 2);
  const seen = new Set<string>();
  return searchGels(q)
    .filter((g) => !seen.has(g.label) && seen.add(g.label))
    .sort((a, b) => (q ? rank(a.label) - rank(b.label) : 0))
    .slice(0, MAX_RESULTS);
}

/** A song's lighting colours. */
export function Colours({ song, autoFocus }: { song: Song; autoFocus?: boolean }) {
  const update = useStore((s) => s.update);
  return <Swatches autoFocus={autoFocus} swatches={song.colours} edit={(fn) => update((show) => fn(show.songs[song.id].colours))} />;
}

/** A song's colours for a colour field. */
export function FieldSwatches({ song, colId, autoFocus }: { song: Song; colId: string; autoFocus?: boolean }) {
  const update = useStore((s) => s.update);
  return <Swatches autoFocus={autoFocus} swatches={fieldSwatches(song, colId)} edit={(fn) => update((show) => { fn(((show.songs[song.id].swatches ??= {})[colId] ??= [])); })} />;
}

/** Colour swatches, and a search box to add one from the gel library ("steel", "ctb", "deep red") or a custom colour. */
function Swatches({ swatches, edit, autoFocus }: { swatches: ColourSwatch[]; edit: (fn: (list: ColourSwatch[]) => void) => void; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState(false);
  const full = swatches.length >= MAX_SWATCHES;

  const wrap = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const close = () => { setLibrary(false); setQuery(""); setActive(0); };
  const add = (hex: string, label: string, pie?: string[]) => { edit((l) => { l.push(pie ? { hex, label, pie } : { hex, label }); }); setQuery(""); setActive(0); };
  const q = query.trim();
  const options = matches(q).map((g: Gel) => ({ key: g.label, gel: g, label: g.label, pick: () => add(g.hex, g.label, g.pie) }));

  // Close the picker on a click anywhere else.
  useEffect(() => {
    if (!library) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [library]);

  return (
    <div className="stack">
      <div className="swatch-list">
        {swatches.map((sw, i) => (
          <div key={i} className="swatch-row">
            <label className="swatch-chip" style={{ background: swatchFill(sw) }} title="Pick any colour">
              <input type="color" value={sw.hex.toLowerCase()} onChange={(e) => edit((l) => { l[i].hex = e.target.value.toUpperCase(); delete l[i].pie; })} />
            </label>
            <DraftInput value={sw.label ?? ""} placeholder={sw.hex} onCommit={(v) => edit((l) => { l[i].label = v; })} />
            <button className="icon" disabled={i === 0} title="Move up" onClick={() => edit((l) => { [l[i - 1], l[i]] = [l[i], l[i - 1]]; })}><Icon name="chevUp" size="sm" /></button>
            <button className="icon" disabled={i === swatches.length - 1} title="Move down" onClick={() => edit((l) => { [l[i], l[i + 1]] = [l[i + 1], l[i]]; })}><Icon name="chevDown" size="sm" /></button>
            <button className="icon" title={`Remove ${sw.label || sw.hex}`} onClick={() => edit((l) => { l.splice(i, 1); })}><Icon name="x" size="sm" /></button>
          </div>
        ))}
        {swatches.length === 0 && <p className="muted" style={{ margin: 0 }}>No colours yet.</p>}
      </div>
      {!full && (
        <div className="gel-row">
        <div className="gel-search" ref={wrap}>
          <div className="gel-input">
            <Icon name="search" size="sm" />
            <input autoFocus={autoFocus} value={query} placeholder="Add a colour" aria-label="Add a colour"
                   onFocus={() => setLibrary(true)}
                   onChange={(e) => { setQuery(e.target.value); setLibrary(true); setActive(0); }}
                   onKeyDown={(e) => {
                     if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
                     else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                     else if (e.key === "Enter" && options[active]) { e.preventDefault(); options[active].pick(); }
                     else if (e.key === "Escape") { e.stopPropagation(); close(); (e.target as HTMLInputElement).blur(); }
                   }} />
          </div>
          {library && options.length > 0 && (
            <div className="gel-results" role="listbox">
              {options.map((o, i) => (
                <button key={o.key} role="option" aria-selected={i === active} className={`gel-item ${i === active ? "on" : ""}`}
                        onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={o.pick}>
                  <span className="gel-chip" style={{ background: swatchFill(o.gel) }} />
                  <span className="nm">{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="sm" title="Add a swatch, then click it to pick any colour" onClick={() => add("#808080", q)}><Icon name="plus" size="sm" /> Custom colour</button>
        </div>
      )}
    </div>
  );
}

/** A song's images. Clicking one opens it full screen (onOpen, with its path). */
export function Media({ song, onOpen }: { song: Song; onOpen: (path: string) => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const show = useStore((s) => s.show)!;
  // Each image can be the song's main image (General), and can have a category (an image column: Content, LX…), picked on the image.
  const cats = categories(show).filter((c) => c.id !== GENERAL);
  const [editing, setEditing] = useState(false);
  const update = useStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);
  const gallery = song.gallery ?? (song.hero ? [song.hero] : []);
  const recordOf = (p: string) => (show.records ?? []).find((r) => r.stills?.includes(p));
  const [states] = useFileStates([...new Set(gallery.flatMap((p) => recordOf(p)?.path ?? []))]);
  // A still from a record: another frame can be picked from the record when it's on this Mac and the song's marked in
  // it, else from the song's clip of it.
  const frameSource = (p: string) => {
    const r = recordOf(p);
    return r && ((states[r.path] !== "missing" && (r.song_marks ?? []).some((m) => m.song_id === song.id)) || (song.clips ?? []).some((c) => c.record_id === r.id)) ? r : undefined;
  };

  // Once another frame's picked, back to this song's Media tab, over the page it was opened from.
  const backHere = () => {
    const { view, setView, focusSong } = useStore.getState();
    return () => { setView(view); focusSong(song.id, "media"); };
  };
  /** Put an image file someone chooses in this image's place. */
  async function replaceFromFile(old: string) {
    setError(null);
    try {
      const [path] = await backend.chooseFiles("image", false);
      if (!path) return;
      const rel = await backend.importMedia(bundle, path, "renders");
      update((s) => replaceImage(s, song.id, old, rel));
    } catch (e) {
      setError(String(e));
    }
  }

  async function choose() {
    setError(null);
    try {
      const paths = await backend.chooseImages();
      const rels = await Promise.all(paths.map((p) => backend.importMedia(bundle, p, "renders")));
      if (rels.length) update((s) => addImages(s, song.id, rels, ensureCategory(s, deptCategory("CONTENT"))));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="stack">
      {song.hero && <div className="hero-box"><img src={backend.mediaUrl(bundle, song.hero)} alt="" title="Open full screen" onClick={() => onOpen(song.hero!)} /></div>}
      <div className="dropzone-sm">
        {backend.isDesktop ? (song.hero ? "Drop more images on the song's card" : "No images yet. Drop some on the song's card") : "Adding images needs the desktop app"}
        {backend.isDesktop && <button onClick={choose}>Choose images…</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {gallery.length > 0 && (
        <div className="gallery">
          {gallery.map((p) => (
            <figure key={p} className={isHeroImage(song, p) ? "is-hero" : ""}>
              <img src={backend.mediaUrl(bundle, p)} alt="" title="Open full screen" onClick={() => onOpen(p)} />
              <SaveCopy path={`${bundle}/${p}`} compact />
              {backend.isDesktop && (() => {
                // A still from a video picks another frame (the thumbnail picker); any other image is swapped for an image file.
                const r = frameSource(p);
                return r ? <button className="icon change-thumb" title={`Change the thumbnail: pick another frame from ${r.name}`} onClick={() => repickStill(bundle, r, song.id, p, backHere())}><Icon name="camera" size="sm" /></button>
                  : <button className="icon change-thumb" title="Change the picture: choose an image file to use instead" onClick={() => replaceFromFile(p)}><Icon name="image" size="sm" /></button>;
              })()}
              <figcaption>
                <span className="name" title={p.split("/").pop()}>{imageLabel(show, p)}</span>
                {isHeroImage(song, p) ? <span className="pill" title="The song's main image: General (the SONG IMAGE column), its card and slide">MAIN</span>
                  : <button className="link" title="Make it the song's main image: General (the SONG IMAGE column), its card and slide" onClick={() => update((s) => setHero(s, song.id, p))}>Make main</button>}
                <select className={`category ${imageCategory(show, song, p) ? "on" : ""}`} value={imageCategory(show, song, p)} aria-label="Category"
                        title="Its category: the column it shows in, in the Sheet and on the slide"
                        onChange={(e) => (e.target.value === "__edit" ? setEditing(true) : update((s) => setImageCategory(s, song.id, p, e.target.value && ensureCategory(s, e.target.value))))}>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="">No category</option>
                  <option value="__edit">Edit categories…</option>
                </select>
                <button className="link" onClick={() => deleteSongImage(song.id, p)}>Delete</button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="muted small">The main image is the song's General picture: the SONG IMAGE column, its card and slide. Pick a category to show an image in that department's column too. <button className="link" onClick={() => setEditing(true)}>Edit categories</button></p>
      {editing && <CategoriesDialog onClose={() => setEditing(false)} />}
    </div>
  );
}

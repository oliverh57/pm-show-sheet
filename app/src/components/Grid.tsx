// The set list grid: running order, an archive divider, then the archive pool.
// A click on a text or list field edits it, like a form; on a colour, opens the colour picker under it (gel library,
// custom colours, as in the song drawer); on an image or clip, shows it full screen with ways to save it. Other cells
// select, and double-click opens the song at them (an empty image or clip cell too, to add one).
// Keyboard: arrows/Tab move, Enter or typing edits, Space toggles ticks, Delete clears,
// Esc cancels an edit. Enter on a colour opens its picker; on a list field, a menu of its options. Drag the ⋮⋮ grip to reorder or move a song in/out of the archive.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { backend } from "../backend";
import { cellValue, clipLabel, deptColour, deptLabel, songImage, songImagePaths, continuesFromPrev, fieldSwatches, fieldValue, isFieldColumn, moveSong, setField, toggleStatus, addSong } from "../model/ops";
import { swatchFill, swatchText } from "../model/gels";
import type { ColumnDef, ListName, Show, Song } from "../model/types";
import { useStore } from "../store";
import { MediaViewer } from "./MediaViewer";
import { Colours, FieldSwatches } from "./SongSections";

type Row =
  | { kind: "song"; id: string; list: ListName; index: number }
  | { kind: "divider" }
  | { kind: "add"; list: ListName };

function rowKey(r: Row): string {
  return r.kind === "song" ? r.id : r.kind === "divider" ? "__divider" : `__add_${r.list}`;
}

function buildRows(show: Show): Row[] {
  const songs = (list: ListName): Row[] => show[list].map((id, index) => ({ kind: "song", id, list, index }));
  return [...songs("set_order"), { kind: "add", list: "set_order" }, { kind: "divider" },
          ...songs("archive"), { kind: "add", list: "archive" }];
}

interface Editing {
  songId: string;
  colId: string;
  draft: string;
}

interface Drag {
  songId: string;
  overKey: string | null;
  after: boolean;
}

const GRIP_WIDTH = 26;

/** What an image or clip cell shows full screen: its image, or the song's first clip. */
function mediaIn(song: Song, col: ColumnDef): string | undefined {
  if (col.type === "image") return songImage(song, col.id);
  if (col.type === "clip") return song.clips?.[0]?.path;
}

/** The lighting colour columns and colour fields: edited in the colour picker. */
const isColourColumn = (col: ColumnDef) => col.type === "colour" || col.type === "palette";

export function Grid() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const selectedSongId = useStore((s) => s.selectedSongId);
  const selectedColId = useStore((s) => s.selectedColId);
  const update = useStore((s) => s.update);
  const select = useStore((s) => s.select);
  const focusSong = useStore((s) => s.focusSong);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // The colour cell whose picker is open ("songId|colId").
  const [picking, setPicking] = useState<string | null>(null);
  // The image or clip shown full screen: the song, and the image or clip path it opened on.
  const [viewing, setViewing] = useState<{ songId: string; start: string } | null>(null);
  // The cell that was being edited when the mouse went down: clicking it again closes it rather than reopening.
  const editingAtDown = useRef<string | null>(null);

  const rows = useMemo(() => buildRows(show), [show]);
  const songRows = rows.filter((r): r is Extract<Row, { kind: "song" }> => r.kind === "song");
  const cols = show.columns;
  const hasImages = cols.some((c) => c.type === "image") && Object.values(show.songs).some((s) => songImagePaths(s).length > 0);

  // Sticky offsets for the grip, # and NAME columns.
  const nameIndex = cols.findIndex((c) => c.id === "name");
  const stickyLeft = useMemo(() => {
    const out: Record<string, number> = {};
    let x = GRIP_WIDTH;
    cols.slice(0, nameIndex + 1).forEach((c) => {
      out[c.id] = x;
      x += c.width ?? 120;
    });
    return out;
  }, [cols, nameIndex]);

  // Department bands: runs of consecutive columns in the same department.
  const bands = useMemo(() => {
    const out: { dept: string; span: number }[] = [];
    for (const c of cols) {
      const last = out[out.length - 1];
      if (last && last.dept === c.dept) last.span += 1;
      else out.push({ dept: c.dept, span: 1 });
    }
    return out;
  }, [cols]);

  useEffect(() => {
    if (!editing) gridRef.current?.focus({ preventScroll: true });
  }, [editing]);

  // Keep the selected cell in view.
  useEffect(() => {
    if (!selectedSongId || !selectedColId) return;
    gridRef.current?.querySelector(`[data-cell="${selectedSongId}|${selectedColId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedSongId, selectedColId]);

  function commit(e: Editing) {
    const song = show.songs[e.songId];
    const col = cols.find((c) => c.id === e.colId);
    const value = col ? fieldValue(col, e.draft) : e.draft;
    if (value !== null && song && (song.fields[e.colId] ?? "") !== value) update((s) => setField(s, e.songId, e.colId, value));
    setEditing(null);
  }

  function startEdit(songId: string, col: ColumnDef, initial?: string) {
    if (!isFieldColumn(col)) return;
    select(songId, col.id);
    const current = show.songs[songId].fields[col.id] ?? "";
    // A list opens on the option the typed letter starts, else on the current value.
    const draft = col.type === "choice" ? (initial && col.options?.find((o) => o.toLowerCase().startsWith(initial.toLowerCase()))) || current : initial ?? current;
    setEditing({ songId, colId: col.id, draft });
  }


  function move(dRow: number, dCol: number) {
    const ri = Math.max(0, songRows.findIndex((r) => r.id === selectedSongId));
    const ci = Math.max(0, cols.findIndex((c) => c.id === selectedColId));
    const r = songRows[Math.min(songRows.length - 1, Math.max(0, ri + dRow))];
    const c = cols[Math.min(cols.length - 1, Math.max(0, ci + dCol))];
    if (r && c) select(r.id, c.id);
  }

  function activate(songId: string, col: ColumnDef) {
    if (col.type === "tick") update((s) => toggleStatus(s, songId, col.id));
    else if (isColourColumn(col)) { select(songId, col.id); setPicking(`${songId}|${col.id}`); }
    else if (col.type === "image" || col.type === "clip") {
      const start = mediaIn(show.songs[songId], col);
      if (start) { select(songId, col.id); setViewing({ songId, start }); }
      else focusSong(songId, col.type === "image" ? "renders" : "records");
    } else startEdit(songId, col);
  }

  function closeViewer() {
    setViewing(null);
    gridRef.current?.focus({ preventScroll: true });
  }

  function closePicker() {
    setPicking(null);
    gridRef.current?.focus({ preventScroll: true });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // The colour picker is drawn into the page body, but its keys still bubble here through React.
    if (editing || picking || viewing || !selectedSongId || !e.currentTarget.contains(e.target as Node)) return;
    const col = cols.find((c) => c.id === selectedColId) ?? cols[0];
    const mod = e.metaKey || e.ctrlKey;
    if (mod) return; // undo/redo etc. are handled globally
    switch (e.key) {
      case "ArrowUp": move(-1, 0); break;
      case "ArrowDown": move(1, 0); break;
      case "ArrowLeft": move(0, -1); break;
      case "ArrowRight": move(0, 1); break;
      case "Tab": move(0, e.shiftKey ? -1 : 1); break;
      case "Enter":
      case "F2": activate(selectedSongId, col); break;
      case " ":
        if (col.type === "tick") update((s) => toggleStatus(s, selectedSongId, col.id));
        else return;
        break;
      case "Backspace":
      case "Delete":
        if (isFieldColumn(col)) update((s) => setField(s, selectedSongId, col.id, ""));
        else if (col.type === "palette") update((s) => { delete s.songs[selectedSongId].swatches?.[col.id]; });
        break;
      default:
        if (e.key.length === 1 && isFieldColumn(col)) startEdit(selectedSongId, col, e.key);
        else return;
    }
    e.preventDefault();
  }

  // --- row drag ---------------------------------------------------------------

  function rowAt(clientY: number): { key: string; after: boolean } | null {
    const trs = gridRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]") ?? [];
    for (const tr of trs) {
      const box = tr.getBoundingClientRect();
      if (clientY >= box.top && clientY <= box.bottom) return { key: tr.dataset.row!, after: clientY > box.top + box.height / 2 };
    }
    return null;
  }

  function onGripDown(e: React.PointerEvent, songId: string) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ songId, overKey: null, after: false });
    select(songId);
  }

  function onGripMove(e: React.PointerEvent) {
    if (!drag) return;
    const hit = rowAt(e.clientY);
    setDrag({ ...drag, overKey: hit?.key ?? null, after: hit?.after ?? false });
  }

  function onGripUp() {
    if (!drag) return;
    const { songId, overKey, after } = drag;
    setDrag(null);
    const target = rows.find((r) => rowKey(r) === overKey);
    if (!target || overKey === songId) return;
    let list: ListName;
    let index: number;
    if (target.kind === "song") {
      list = target.list;
      index = target.index + (after ? 1 : 0);
      const from = show[list].indexOf(songId);
      if (from >= 0 && from < index) index -= 1; // moveSong counts after removal
    } else if (target.kind === "divider") {
      list = after ? "archive" : "set_order";
      index = after ? 0 : show.set_order.filter((x) => x !== songId).length;
    } else {
      list = target.list;
      index = show[list].filter((x) => x !== songId).length;
    }
    update((s) => moveSong(s, songId, list, index));
  }

  function addRow(list: ListName) {
    let id = "";
    update((s) => {
      id = addSong(s, list);
    });
    const nameCol = cols.find((c) => c.id === "name");
    if (nameCol) {
      select(id, "name");
      setEditing({ songId: id, colId: "name", draft: "" });
    }
  }

  // --- render -------------------------------------------------------------------

  const totalWidth = GRIP_WIDTH + cols.reduce((n, c) => n + (c.width ?? 120), 0);

  function renderCell(songId: string, col: ColumnDef, archived: boolean) {
    const song = show.songs[songId];
    const value = cellValue(show, col, song);
    const selected = songId === selectedSongId && col.id === selectedColId;
    const isEditing = editing?.songId === songId && editing.colId === col.id;
    const sticky = col.id in stickyLeft;
    const editable = isFieldColumn(col);
    const cellKey = `${songId}|${col.id}`;
    const isPicking = picking === cellKey;
    const busy = isEditing || isPicking; // clicking the cell again closes it rather than reopening
    const hasMedia = mediaIn(song, col) !== undefined;
    const classes = ["cell", `t-${col.type}`, (editable || isColourColumn(col)) && "editable", hasMedia && "viewable", selected && "selected", sticky && "sticky", archived && "archived"]
      .filter(Boolean).join(" ");
    let content: React.ReactNode = null;
    let style: React.CSSProperties = sticky ? { left: stickyLeft[col.id] } : {};

    if (isEditing && col.type === "choice") {
      content = <ChoiceMenu options={col.options ?? []} editing={editing} anchor={`${songId}|${col.id}`} gridRef={gridRef}
                            onChange={setEditing} onCommit={(e, dRow, dCol) => { commit(e); move(dRow, dCol); }} onCancel={() => setEditing(null)} />;
    } else if (isEditing) {
      const multiline = col.type === "longtext";
      const props = {
        autoFocus: true,
        className: "cell-input",
        value: editing.draft,
        onChange: (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditing({ ...editing, draft: ev.target.value }),
        onBlur: () => commit(editing),
        onKeyDown: (ev: React.KeyboardEvent) => {
          if (ev.key === "Escape") { setEditing(null); ev.preventDefault(); }
          else if (ev.key === "Enter" && !(multiline && ev.shiftKey)) { commit(editing); move(1, 0); ev.preventDefault(); }
          else if (ev.key === "Tab") { commit(editing); move(0, ev.shiftKey ? -1 : 1); ev.preventDefault(); }
        },
        onFocus: (ev: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          const el = ev.target;
          el.setSelectionRange(el.value.length, el.value.length);
        },
      };
      content = multiline ? <textarea {...props} /> : <input {...props} />;
    } else if (col.type === "tick") {
      content = <span className={`tick ${value ? "on" : ""}`}>{value ? "✓" : ""}</span>;
    } else if (col.type === "colour") {
      const sw = song.colours[col.index ?? 0];
      if (sw) {
        style = { ...style, background: swatchFill(sw), color: swatchText(sw) };
        content = <span className={`swatch-label ${sw.pie ? "pie" : ""}`}>{sw.label}</span>;
      }
    } else if (col.type === "palette") {
      // Each colour takes an equal share of the cell, like the lighting colour columns side by side.
      const sws = fieldSwatches(song, col.id);
      content = sws.length ? (
        <span className="palette-cell">
          {sws.map((sw, i) => (
            <span key={i} className={`swatch-label ${sw.pie ? "pie" : ""}`} style={{ background: swatchFill(sw), color: swatchText(sw) }}>{sw.label}</span>
          ))}
        </span>
      ) : null;
    } else if (col.type === "clip") {
      content = (song.clips ?? []).length ? <span className="clamp" style={{ whiteSpace: "pre-line" }}>{(song.clips ?? []).map((c) => `▶ ${clipLabel(show, c)}`).join("\n")}</span> : null;
    } else if (col.type === "image") {
      const img = songImage(song, col.id);
      content = img ? <img className="thumb" src={backend.mediaUrl(bundle, img)} alt="" draggable={false} /> : null;
    } else if (col.type === "tc" && continuesFromPrev(show, songId)) {
      const tc = song.fields[col.id];
      content = tc ? <span className="tc-cont">{tc}<span className="cont">Cont.</span></span> : <span>Cont.</span>;
    } else {
      content = <span className={col.type === "longtext" ? "clamp" : ""}>{String(value)}</span>;
    }

    return (
      <td
        key={col.id}
        className={classes}
        style={style}
        data-cell={cellKey}
        onMouseDown={(e) => {
          if (!e.currentTarget.contains(e.target as Node)) return; // from the colour picker
          editingAtDown.current = editing ? `${editing.songId}|${editing.colId}` : picking;
          if (!busy) select(songId, col.id);
        }}
        onClick={(e) => {
          if (!e.currentTarget.contains(e.target as Node) || busy || editingAtDown.current === cellKey) return;
          if (col.type === "tick") update((s) => toggleStatus(s, songId, col.id));
          else if (editable || isColourColumn(col) || hasMedia) activate(songId, col);
        }}
        onDoubleClick={(e) => e.currentTarget.contains(e.target as Node) && (col.type === "image" || col.type === "clip") && !hasMedia && activate(songId, col)}
      >
        {content}
        {isPicking && <ColourPopover song={song} col={col} anchor={cellKey} gridRef={gridRef} onClose={closePicker} />}
      </td>
    );
  }

  return (
    <div className="grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onKeyDown}>
      <table className="grid" style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: GRIP_WIDTH }} />
          {cols.map((c) => <col key={c.id} style={{ width: c.width ?? 120 }} />)}
        </colgroup>
        <thead>
          <tr className="bands">
            <th className="sticky corner" style={{ left: 0 }} />
            {bands.map((b, i) => (
              <th key={i} colSpan={b.span} className={`band dept-${b.dept}`} style={{ background: deptColour(show, b.dept) }}>{b.dept === "CORE" && deptLabel(show, b.dept) === b.dept ? "" : deptLabel(show, b.dept)}</th>
            ))}
          </tr>
          <tr className="labels">
            <th className="sticky corner" style={{ left: 0 }} />
            {cols.map((c) => (
              <th key={c.id} className={`label ${c.id in stickyLeft ? "sticky" : ""}`}
                  style={c.id in stickyLeft ? { left: stickyLeft[c.id] } : {}}
>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = rowKey(r);
            const dropClass = drag?.overKey === key ? (drag.after ? "drop-after" : "drop-before") : "";
            if (r.kind === "divider") {
              return (
                <tr key={key} data-row={key} className={`divider ${dropClass}`}>
                  <td className="sticky" style={{ left: 0 }} />
                  <td colSpan={cols.length}><span className="sticky-text">SONG ARCHIVE</span></td>
                </tr>
              );
            }
            if (r.kind === "add") {
              return (
                <tr key={key} data-row={key} className={`add-row ${dropClass}`}>
                  <td className="sticky" style={{ left: 0 }} />
                  <td colSpan={cols.length}>
                    <button className="link sticky-text" onClick={() => addRow(r.list)}>
                      + Add song{r.list === "archive" ? " to archive" : ""}
                    </button>
                  </td>
                </tr>
              );
            }
            const archived = r.list === "archive";
            const song = show.songs[r.id];
            return (
              <tr key={key} data-row={key} data-song-id={r.id}
                  className={[r.id === selectedSongId && "row-selected", drag?.songId === r.id && "dragging", dropClass, hasImages && "tall", song.segues_into_next && "segues"].filter(Boolean).join(" ")}>
                <td className="grip sticky" style={{ left: 0 }}
                    onPointerDown={(e) => onGripDown(e, r.id)} onPointerMove={onGripMove} onPointerUp={onGripUp}
                    title="Drag to reorder">⋮⋮</td>
                {cols.map((c) => renderCell(r.id, c, archived))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {viewing && show.songs[viewing.songId] && <MediaViewer song={show.songs[viewing.songId]} start={viewing.start} onClose={closeViewer} />}
    </div>
  );
}

interface ChoiceMenuProps {
  options: string[];
  editing: Editing;
  anchor: string; // the cell's data-cell
  gridRef: React.RefObject<HTMLDivElement | null>;
  onChange: (e: Editing) => void;
  onCommit: (e: Editing, dRow: number, dCol: number) => void;
  onCancel: () => void;
}

/** A list field's options, dropped below its cell. Arrows move, a letter jumps, Enter or a click picks, "—" clears. */
function ChoiceMenu({ options, editing, anchor, gridRef, onChange, onCommit, onCancel }: ChoiceMenuProps) {
  const items = ["", ...options];
  const ref = useRef<HTMLDivElement>(null);
  // Measured on the first render so the menu is visible, and can take focus, as soon as it mounts.
  const [box] = useState(() => gridRef.current?.querySelector(`[data-cell="${CSS.escape(anchor)}"]`)?.getBoundingClientRect() ?? null);
  const at = Math.max(0, items.indexOf(editing.draft));

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    ref.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  function onKeyDown(ev: React.KeyboardEvent) {
    const go = (i: number) => onChange({ ...editing, draft: items[Math.max(0, Math.min(items.length - 1, i))] });
    if (ev.key === "ArrowDown") go(at + 1);
    else if (ev.key === "ArrowUp") go(at - 1);
    else if (ev.key === "Enter") onCommit(editing, 0, 0);
    else if (ev.key === "Tab") onCommit(editing, 0, ev.shiftKey ? -1 : 1);
    else if (ev.key === "Escape") onCancel();
    else if (ev.key === "Backspace" || ev.key === "Delete") go(0);
    else if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
      // Cycle through the options starting with the letter.
      const k = ev.key.toLowerCase();
      const next = items.findIndex((o, i) => i > at && o.toLowerCase().startsWith(k));
      const first = items.findIndex((o) => o.toLowerCase().startsWith(k));
      if (next >= 0 || first >= 0) go(next >= 0 ? next : first);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  return (
    <div ref={ref} className="choice-menu" tabIndex={-1} role="listbox" onKeyDown={onKeyDown} onBlur={onCancel}
         style={box ? { left: box.left, top: box.bottom, minWidth: box.width } : { visibility: "hidden" }}>
      {items.map((o, i) => (
        <div key={o || "__none"} role="option" aria-selected={i === at} className={[i === at && "on", !o && "none"].filter(Boolean).join(" ")}
             onMouseDown={(ev) => { ev.preventDefault(); onCommit({ ...editing, draft: o }, 0, 0); }}
             onMouseEnter={() => onChange({ ...editing, draft: o })}>
          {o || "—"}
        </div>
      ))}
      {options.length === 0 && <div className="empty">No options yet: add them in Columns</div>}
    </div>
  );
}

interface ColourPopoverProps {
  song: Song;
  col: ColumnDef;
  anchor: string; // the cell's data-cell
  gridRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const POPOVER_WIDTH = 380;

/**
 * A colour cell's colours, in a popover under the cell (above it near the bottom of the window): the song drawer's
 * colour editor, with the gel search ready to type in. A lighting colour column edits all the song's lighting colours,
 * as the drawer does. Closes on a click elsewhere, a scroll that moves the cell, or Esc (the first Esc closes the gel list).
 */
function ColourPopover({ song, col, anchor, gridRef, onClose }: ColourPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cellBox = () => gridRef.current?.querySelector(`[data-cell="${CSS.escape(anchor)}"]`)?.getBoundingClientRect();
  const [start] = useState(cellBox);
  const [pos] = useState<React.CSSProperties>(() => {
    const r = start;
    if (!r) return { visibility: "hidden" };
    const left = Math.min(Math.max(8, r.left), window.innerWidth - POPOVER_WIDTH - 8);
    return r.top > window.innerHeight - r.bottom ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 };
  });

  useEffect(() => {
    const inside = (e: Event) => ref.current?.contains(e.target as Node);
    const onDown = (e: MouseEvent) => !inside(e) && onClose();
    // Selecting the cell scrolls it into view just before this opens; only a scroll that moves it closes the picker.
    const onScroll = (e: Event) => {
      const r = cellBox();
      if (!inside(e) && (!r || !start || Math.abs(r.top - start.top) > 1 || Math.abs(r.left - start.left) > 1)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="colour-pop" style={{ ...pos, width: POPOVER_WIDTH }}>
      <div className="head">{song.fields.name || "Untitled"} · {col.type === "colour" ? "Lighting colours" : col.label}</div>
      {col.type === "colour" ? <Colours song={song} autoFocus /> : <FieldSwatches song={song} colId={col.id} autoFocus />}
    </div>,
    document.body,
  );
}

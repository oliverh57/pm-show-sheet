// The set list grid: running order, an archive divider, then the archive pool.
// Keyboard: arrows/Tab move, Enter or typing edits, Space toggles ticks, Delete clears,
// Esc cancels an edit. Drag the ⋮⋮ grip to reorder or move a song in/out of the archive.
import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import { cellValue, isTextColumn, moveSong, setField, toggleStatus, addSong } from "../model/ops";
import { textOn } from "../model/gels";
import type { ColumnDef, ListName, Show } from "../model/types";
import { useStore } from "../store";

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

  const rows = useMemo(() => buildRows(show), [show]);
  const songRows = rows.filter((r): r is Extract<Row, { kind: "song" }> => r.kind === "song");
  const cols = show.columns;
  const hasImages = cols.some((c) => c.type === "image") && Object.values(show.songs).some((s) => s.hero);

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
    if (song && (song.fields[e.colId] ?? "") !== e.draft) update((s) => setField(s, e.songId, e.colId, e.draft));
    setEditing(null);
  }

  function startEdit(songId: string, col: ColumnDef, initial?: string) {
    if (!isTextColumn(col)) return;
    select(songId, col.id);
    setEditing({ songId, colId: col.id, draft: initial ?? show.songs[songId].fields[col.id] ?? "" });
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
    else if (col.type === "colour") focusSong(songId, "colours");
    else if (col.type === "image") focusSong(songId, "renders");
    else startEdit(songId, col);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || !selectedSongId) return;
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
        if (isTextColumn(col)) update((s) => setField(s, selectedSongId, col.id, ""));
        break;
      default:
        if (e.key.length === 1 && isTextColumn(col)) startEdit(selectedSongId, col, e.key);
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
    const classes = ["cell", `t-${col.type}`, selected && "selected", sticky && "sticky", col.editable && "collab", archived && "archived"]
      .filter(Boolean).join(" ");
    let content: React.ReactNode = null;
    let style: React.CSSProperties = sticky ? { left: stickyLeft[col.id] } : {};

    if (isEditing) {
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
        style = { ...style, background: sw.hex, color: textOn(sw.hex) };
        content = <span className="swatch-label">{sw.label}</span>;
      }
    } else if (col.type === "image") {
      content = song.hero ? <img className="thumb" src={backend.mediaUrl(bundle, song.hero)} alt="" draggable={false} /> : null;
    } else {
      content = <span className={col.type === "longtext" ? "clamp" : ""}>{String(value)}</span>;
    }

    return (
      <td
        key={col.id}
        className={classes}
        style={style}
        data-cell={`${songId}|${col.id}`}
        onMouseDown={() => select(songId, col.id)}
        onClick={() => col.type === "tick" && update((s) => toggleStatus(s, songId, col.id))}
        onDoubleClick={() => col.type !== "tick" && activate(songId, col)}
      >
        {content}
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
              <th key={i} colSpan={b.span} className={`band dept-${b.dept}`}>{b.dept === "CORE" ? "" : b.dept}</th>
            ))}
          </tr>
          <tr className="labels">
            <th className="sticky corner" style={{ left: 0 }} />
            {cols.map((c) => (
              <th key={c.id} className={`label ${c.editable ? "collab" : ""} ${c.id in stickyLeft ? "sticky" : ""}`}
                  style={c.id in stickyLeft ? { left: stickyLeft[c.id] } : {}}
                  title={c.editable ? "Collaborators can edit this column in the Sheet" : undefined}>
                {c.editable ? "✎ " : ""}{c.label}
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
    </div>
  );
}

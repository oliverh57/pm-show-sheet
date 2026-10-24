// Field manager, grouped by category (the Sheet's bands): each field's label, width, on-slide flag and a list field's
// options. Drag a field's ⋮⋮ grip to reorder it or move it to another category; drag a category's grip to move it in the
// Sheet. Categories can be added, renamed, recoloured and (once empty) deleted. A category's Media field is made when media is
// filed in it, and stays (in its category) until that media is gone.
import { Fragment, useRef, useState } from "react";
import {
  addChoiceOption, addDept, addField, categoryName, CORE_COLUMN_IDS, deptColour, deptLabel, deptList, deptName, isBuiltInDept, isCategoryMedia, mediaIn,
  moveChoiceOption, moveDeptTo, onSlide, placeColumn, removeChoiceOption, removeColumn, removeDept, renameChoiceOption, renameDept, setDeptColour,
} from "../model/ops";
import type { ColumnDef, ColumnType, Dept } from "../model/types";
import { backend } from "../backend";
import { useStore } from "../store";
import { DraftInput, OptionsEditor } from "./fields";
import { Icon } from "./icons";

const TYPES: { id: ColumnType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "longtext", label: "Long text" },
  { id: "tc", label: "Timecode" },
  { id: "tick", label: "Status tick" },
  { id: "colour", label: "Colour swatch" },
  { id: "image", label: "Media" },
  { id: "clip", label: "Clip link" },
  { id: "palette", label: "Colour" },
  { id: "choice", label: "List" },
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A built-in category's own band colour, from the app's styles. */
const ownColour = (d: Dept) => getComputedStyle(document.documentElement).getPropertyValue(`--dept-${d}`).trim() || "#808080";

/** What's being dragged, and where it would go: a field into a category before a field (null: after its fields), or a category before another (null: last). */
type Drag =
  | { kind: "field"; id: string; dept: Dept | null; before: string | null }
  | { kind: "dept"; id: Dept; before: Dept | null; valid: boolean };

export function ColumnsDialog() {
  const show = useStore((s) => s.show)!;
  const update = useStore((s) => s.update);
  const setOpen = useStore((s) => s.setColumnsOpen);
  const toast = useStore((s) => s.toast);
  const [nameReset, setNameReset] = useState(0); // remounts the category names, putting back one that wasn't taken
  const [adding, setAdding] = useState<Dept | null>(null); // the category a field is being added to
  const [label, setLabel] = useState("");
  const [type, setType] = useState<ColumnType>("longtext");
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [newDept, setNewDept] = useState("");
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null); // the same, for a release that comes before the re-render
  const setDrag = (d: Drag | null) => { dragRef.current = d; setDragState(d); };
  const tableRef = useRef<HTMLDivElement>(null);

  const depts = deptList(show);
  const filled = depts.filter((d) => show.columns.some((c) => c.dept === d)); // the ones in the Sheet, which can be dragged

  const edit = (colId: string, fn: (c: ColumnDef) => void) =>
    update((s) => { const c = s.columns.find((x) => x.id === colId); if (c) fn(c); });

  async function removeOption(c: ColumnDef, option: string) {
    const used = Object.values(show.songs).filter((s) => s.fields[c.id] === option).length;
    if (used && !(await backend.confirm(`Remove “${option}”? ${used} song${used === 1 ? " has" : "s have"} it picked and will be cleared.`))) return;
    update((s) => removeChoiceOption(s, c.id, option));
  }

  async function remove(c: ColumnDef) {
    if (await backend.confirm(`Delete the ${c.label} field and its values in every song?`)) update((s) => removeColumn(s, c.id));
  }

  function startAdding(d: Dept) {
    setAdding(d);
    setLabel("");
    setType("longtext");
  }

  function add(d: Dept) {
    const name = label.trim() || (type === "image" ? deptName(d, show) : "");
    if (!name) return;
    let id = "";
    update((s) => { id = addField(s, name, d, type); });
    if (type === "choice") setOptionsFor(id);
    setAdding(null);
  }

  function rename(d: Dept, name: string) {
    const label = name.trim().toUpperCase();
    const taken = deptList(show).find((x) => x !== d && (x === label || deptLabel(show, x) === label));
    if (taken) toast(`There's already a ${label} category`);
    if (!label || taken) return setNameReset((n) => n + 1);
    update((s) => renameDept(s, d, label));
  }

  function addCategory() {
    if (!newDept.trim()) return;
    let id = "";
    update((s) => { id = addDept(s, newDept); });
    setNewDept("");
    startAdding(id);
  }

  /** Why a field can't be deleted, or "" if it can. */
  function locked(c: ColumnDef): string {
    if (CORE_COLUMN_IDS.includes(c.id)) return "Every song has this field";
    if (c.type !== "image") return "";
    const m = mediaIn(show, c.id);
    if (!m.songs && !m.records) return "";
    const what = [m.songs && `images on ${plural(m.songs, "song")}`, m.records && `${plural(m.records, "record")} filed in it`].filter(Boolean).join(" and ");
    return `${categoryName(c, show)} still has media (${what}): remove it to delete this field`;
  }

  function mediaText(c: ColumnDef): string {
    const m = mediaIn(show, c.id);
    return m.songs ? `Media · ${plural(m.songs, "song")}` : "Media";
  }

  // --- drag ---------------------------------------------------------------------

  const groups = () => [...(tableRef.current?.querySelectorAll<HTMLElement>(".col-group") ?? [])];
  const below = (el: HTMLElement, y: number) => { const b = el.getBoundingClientRect(); return y < b.top + b.height / 2; };

  /** The category under the pointer (the nearest one above or below it, past the ends). */
  function groupAt(y: number): HTMLElement | null {
    const gs = groups();
    return gs.find((g) => y <= g.getBoundingClientRect().bottom) ?? gs[gs.length - 1] ?? null;
  }

  function onGripDown(e: React.PointerEvent, start: Drag) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(start);
  }

  /** Where the dragged field or category would go with the pointer at `y`. */
  function aim(drag: Drag, y: number): Drag {
    if (drag.kind === "field") {
      const g = groupAt(y);
      const dept = g?.dataset.dept ?? null;
      const col = show.columns.find((c) => c.id === drag.id)!;
      if (!g || !dept || (dept !== col.dept && isCategoryMedia(show, col))) return { ...drag, dept: null, before: null };
      const rows = [...g.querySelectorAll<HTMLElement>(".col-row[data-col]")].filter((r) => r.dataset.col !== drag.id);
      return { ...drag, dept, before: rows.find((r) => below(r, y))?.dataset.col ?? null };
    }
    const next = groups().filter((g) => g.dataset.filled && g.dataset.dept !== drag.id).find((g) => below(g, y));
    const before = next?.dataset.dept ?? null;
    return { ...drag, before, valid: before !== "CORE" };
  }

  function onGripMove(e: React.PointerEvent) {
    if (dragRef.current) setDrag(aim(dragRef.current, e.clientY));
  }

  function onGripUp(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const d = aim(dragRef.current, e.clientY);
    setDrag(null);
    if (d.kind === "field" && d.dept) update((s) => placeColumn(s, d.id, d.dept!, d.before));
    if (d.kind === "dept" && d.valid) update((s) => moveDeptTo(s, d.id, d.before));
  }

  const grip = (start: Drag, title: string) => (
    <span className="col-grip" title={title} onPointerDown={(e) => onGripDown(e, start)} onPointerMove={onGripMove} onPointerUp={onGripUp}
          onPointerCancel={() => setDrag(null)}><Icon name="grip" size="sm" /></span>
  );

  /** Drop marks: a line above the field or category it would go before, or under the category it would go at the end of. */
  function groupClass(d: Dept): string {
    if (drag?.kind === "field") return drag.dept === d ? (drag.before ? "drop-into" : "drop-into drop-end") : "";
    if (drag?.kind === "dept" && drag.valid) {
      if (drag.id === d) return "dragging";
      if (drag.before === d) return "drop-before";
      if (!drag.before && d === filled.filter((x) => x !== drag.id).slice(-1)[0]) return "drop-after";
    }
    return "";
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={`modal wide ${drag ? "col-dragging" : ""}`} role="dialog" aria-label="Fields">
        <header className="modal-head">
          <div><h2>Fields</h2><p>The fields every song has, by category, in Sheet order. Drag a grip to reorder fields or move them between categories, or to move a category. Click a category's name to rename it. Slide: shown on the song's slide.</p></div>
          <button className="icon" onClick={() => setOpen(false)}>×</button>
        </header>
        <div className="modal-body">
        <div className="col-table" ref={tableRef}>
          <div className="col-row head"><span /><span>Label</span><span>Type</span><span>Width</span><span>Slide</span><span /></div>
          {depts.map((d) => {
            const cols = show.columns.filter((c) => c.dept === d);
            const colour = deptColour(show, d);
            return (
              <section key={d} className={`col-group ${groupClass(d)}`} data-dept={d} data-filled={cols.length ? "1" : undefined}>
                <div className={`col-band band dept-${d}`} style={{ background: colour }}>
                  {d !== "CORE" && cols.length > 0
                    ? grip({ kind: "dept", id: d, before: null, valid: false }, "Drag to move the category in the Sheet")
                    : <span className="col-grip" />}
                  <DraftInput key={nameReset} fit className="col-band-name" value={deptLabel(show, d)} placeholder={d} onCommit={(v) => rename(d, v)} />
                  <label className="col-colour" title={`${deptLabel(show, d)}'s band colour, in the app, the Sheet and on the slides`}>
                    <Icon name="pencil" size="sm" /> Colour
                    <input type="color" value={colour ?? ownColour(d)} onChange={(e) => update((s) => setDeptColour(s, d, e.target.value.toUpperCase()))} />
                  </label>
                  {colour && isBuiltInDept(d) && <button className="icon" title="Back to its own colour" onClick={() => update((s) => setDeptColour(s, d, null))}>↺</button>}
                  <span className="spacer" />
                  {cols.length === 0 && <button className="icon" title={`Delete ${deptLabel(show, d)}`} onClick={() => update((s) => removeDept(s, d))}>×</button>}
                </div>
                {cols.length === 0 && <p className="muted small col-empty">No fields yet. Drag one here, or add one.</p>}
                {cols.map((c) => {
                  const why = locked(c);
                  const media = isCategoryMedia(show, c);
                  const mark = drag?.kind === "field" && drag.before === c.id && drag.dept === d ? "drop-before" : "";
                  return (
                    <Fragment key={c.id}>
                    <div className={`col-row ${drag?.kind === "field" && drag.id === c.id ? "dragging" : ""} ${mark}`} data-col={c.id}>
                      {grip({ kind: "field", id: c.id, dept: null, before: null }, media ? `Drag to reorder (${categoryName(c, show)}'s media field stays in its category)` : "Drag to reorder, or to another category")}
                      <DraftInput value={c.label} onCommit={(v) => edit(c.id, (x) => { x.label = v.toUpperCase(); })} />
                      {c.type === "choice"
                        ? <button className="sm ghost" style={{ justifySelf: "start", paddingLeft: 0 }} title="Edit the options" onClick={() => setOptionsFor(optionsFor === c.id ? null : c.id)}>List ({c.options?.length ?? 0}) ▾</button>
                        : <span className="muted">{c.type === "image" ? mediaText(c) : TYPES.find((t) => t.id === c.type)?.label}</span>}
                      <DraftInput value={String(c.width ?? 120)} onCommit={(v) => edit(c.id, (x) => { x.width = Math.max(30, Number(v) || 120); })} />
                      <input type="checkbox" checked={onSlide(c)} onChange={() => edit(c.id, (x) => { x.on_slide = !onSlide(x); })} />
                      <button className="icon" disabled={Boolean(why)} onClick={() => remove(c)} title={why || "Delete field"}>×</button>
                    </div>
                    {optionsFor === c.id && (
                      <div className="field-options" style={{ marginLeft: 32, marginBottom: 8, maxWidth: 360 }}>
                        <OptionsEditor options={c.options ?? []} autoFocus={!c.options?.length}
                                       onAdd={(o) => update((s) => addChoiceOption(s, c.id, o))}
                                       onRename={(from, to) => update((s) => renameChoiceOption(s, c.id, from, to))}
                                       onRemove={(o) => removeOption(c, o)}
                                       onMove={(o, dir) => update((s) => moveChoiceOption(s, c.id, o, dir))} />
                      </div>
                    )}
                    </Fragment>
                  );
                })}
                {adding === d ? (
                  <div className="col-add">
                    <input autoFocus placeholder={type === "image" ? `${deptName(d, show)} media` : `New ${deptName(d, show)} field`} value={label}
                           onChange={(e) => setLabel(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter") add(d); if (e.key === "Escape") setAdding(null); }} />
                    <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
                      {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <button className="primary" onClick={() => add(d)} disabled={!label.trim() && type !== "image"}>Add field</button>
                    <button onClick={() => setAdding(null)}>Cancel</button>
                  </div>
                ) : (
                  <button className="link col-add-link" onClick={() => startAdding(d)}>+ Add {deptName(d, show)} field</button>
                )}
              </section>
            );
          })}
        </div>
        <div className="col-new-dept">
          <input placeholder="New category, e.g. Lasers" value={newDept} onChange={(e) => setNewDept(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && addCategory()} />
          <button onClick={addCategory} disabled={!newDept.trim()}>Add category</button>
        </div>
        </div>
      </div>
    </div>
  );
}

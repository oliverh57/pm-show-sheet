// Column manager: order, label, department, width, collaborator-editable and on-slide flags.
import { useState } from "react";
import { addColumn, CORE_COLUMN_IDS, DEPTS, moveColumn, removeColumn } from "../model/ops";
import type { ColumnDef, ColumnType, Dept } from "../model/types";
import { backend } from "../backend";
import { useStore } from "../store";
import { DraftInput } from "./fields";

const TYPES: { id: ColumnType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "longtext", label: "Long text" },
  { id: "tc", label: "Timecode" },
  { id: "tick", label: "Status tick" },
  { id: "colour", label: "Colour swatch" },
  { id: "image", label: "Render image" },
];

export function ColumnsDialog() {
  const show = useStore((s) => s.show)!;
  const update = useStore((s) => s.update);
  const setOpen = useStore((s) => s.setColumnsOpen);
  const [label, setLabel] = useState("");
  const [dept, setDept] = useState<Dept>("LX");
  const [type, setType] = useState<ColumnType>("longtext");

  const edit = (colId: string, fn: (c: ColumnDef) => void) =>
    update((s) => { const c = s.columns.find((x) => x.id === colId); if (c) fn(c); });

  async function remove(c: ColumnDef) {
    if (await backend.confirm(`Delete the ${c.label} column and its values in every song?`)) update((s) => removeColumn(s, c.id));
  }

  function add() {
    if (!label.trim()) return;
    update((s) => { addColumn(s, label.trim(), dept, type); });
    setLabel("");
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal" role="dialog" aria-label="Columns">
        <header className="modal-head">
          <h2>Columns</h2>
          <button className="icon" onClick={() => setOpen(false)}>×</button>
        </header>
        <p className="muted small">✎ Collab = collaborators can edit it in the Google Sheet. Slide = shown on the song's slide.</p>
        <div className="col-table">
          <div className="col-row head"><span /><span>Label</span><span>Department</span><span>Type</span><span>Width</span><span>✎ Collab</span><span>Slide</span><span /></div>
          {show.columns.map((c, i) => (
            <div key={c.id} className="col-row">
              <span className="order">
                <button className="icon" disabled={i === 0} onClick={() => update((s) => moveColumn(s, c.id, -1))}>↑</button>
                <button className="icon" disabled={i === show.columns.length - 1} onClick={() => update((s) => moveColumn(s, c.id, 1))}>↓</button>
              </span>
              <DraftInput value={c.label} onCommit={(v) => edit(c.id, (x) => { x.label = v.toUpperCase(); })} />
              <select value={c.dept} onChange={(e) => edit(c.id, (x) => { x.dept = e.target.value as Dept; })}>
                {DEPTS.map((d) => <option key={d}>{d}</option>)}
              </select>
              <span className="muted">{TYPES.find((t) => t.id === c.type)?.label}</span>
              <DraftInput value={String(c.width ?? 120)} onCommit={(v) => edit(c.id, (x) => { x.width = Math.max(30, Number(v) || 120); })} />
              <input type="checkbox" checked={Boolean(c.editable)} disabled={c.type === "colour" || c.type === "image"}
                     onChange={() => edit(c.id, (x) => { x.editable = !x.editable; })} />
              <input type="checkbox" checked={Boolean(c.on_slide)} disabled={c.type !== "longtext" && c.type !== "text"}
                     onChange={() => edit(c.id, (x) => { x.on_slide = !x.on_slide; })} />
              <button className="icon" disabled={CORE_COLUMN_IDS.includes(c.id)} onClick={() => remove(c)} title="Delete column">×</button>
            </div>
          ))}
        </div>
        <div className="col-add">
          <input placeholder="New column label, e.g. STAGING" value={label} onChange={(e) => setLabel(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && add()} />
          <select value={dept} onChange={(e) => setDept(e.target.value as Dept)}>{DEPTS.map((d) => <option key={d}>{d}</option>)}</select>
          <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button onClick={add}>Add column</button>
        </div>
      </div>
    </div>
  );
}

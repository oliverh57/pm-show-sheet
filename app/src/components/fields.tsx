// Inputs that keep a local draft and commit on blur / Enter, so typing doesn't create an undo step per key,
// and the inputs for typed custom fields (colour, list).
import { useEffect, useState } from "react";
import { cleanOptions, type FieldKind } from "../model/ops";
import type { ColumnDef } from "../model/types";
import { Icon } from "./icons";

interface Props {
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  fit?: boolean; // as wide as its text (allowing for letter spacing), growing as it's typed in
}

export function DraftInput({ value, onCommit, multiline, placeholder, className, mono, fit }: Props) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    value: draft,
    placeholder,
    className: [className, mono && "mono"].filter(Boolean).join(" "),
    style: fit ? { width: `calc(${Math.max(draft.length, 3) + 1}ch + ${draft.length * 0.1}em + 14px)` } : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        setDraft(value);
        (e.target as HTMLElement).blur();
      } else if (e.key === "Enter" && (!multiline || e.metaKey)) {
        (e.target as HTMLElement).blur();
      }
    },
  };
  return multiline ? <textarea rows={3} {...common} /> : <input {...common} />;
}

/** The kinds of custom field people can add, in the order they're offered. */
export const FIELD_KINDS: { id: FieldKind; label: string; hint: string }[] = [
  { id: "longtext", label: "Notes", hint: "Long text, shown on the song cards" },
  { id: "text", label: "Text", hint: "A short line of text" },
  { id: "palette", label: "Colour", hint: "Colours picked like the lighting colours: from the gel library, or any colour" },
  { id: "choice", label: "List", hint: "One of a list of options you set" },
];

/** A field's value, edited the way its type needs: a dropdown of its options, or text. (Colour fields use FieldSwatches.) */
export function FieldInput({ col, value, onCommit, placeholder }: { col: ColumnDef; value: string; onCommit: (value: string) => void; placeholder?: string }) {
  if (col.type === "choice") {
    const options = col.options ?? [];
    return (
      <select value={value} onChange={(e) => onCommit(e.target.value)}>
        <option value="">—</option>
        {value && !options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return <DraftInput multiline={col.type === "longtext"} mono={col.type === "tc"} value={value} onCommit={onCommit} placeholder={placeholder} />;
}

interface OptionsProps {
  options: string[];
  onAdd: (option: string) => void;
  onRename: (from: string, to: string) => void;
  onRemove: (option: string) => void;
  onMove: (option: string, delta: number) => void;
  autoFocus?: boolean;
}

/** The options of a list field: rename in place, reorder, remove, and add more (paste several lines at once). */
export function OptionsEditor({ options, onAdd, onRename, onRemove, onMove, autoFocus }: OptionsProps) {
  const [draft, setDraft] = useState("");
  const add = (text = draft) => {
    for (const line of text.split(/\r?\n/)) if (line.trim()) onAdd(line.trim());
    setDraft("");
  };
  return (
    <div className="options-editor">
      {options.map((o, i) => (
        <div key={o} className="option-row">
          <DraftInput value={o} onCommit={(v) => onRename(o, v)} />
          <button className="icon" disabled={i === 0} title="Move up" onClick={() => onMove(o, -1)}><Icon name="chevUp" size="sm" /></button>
          <button className="icon" disabled={i === options.length - 1} title="Move down" onClick={() => onMove(o, 1)}><Icon name="chevDown" size="sm" /></button>
          <button className="icon" title={`Remove ${o}`} onClick={() => onRemove(o)}><Icon name="x" size="sm" /></button>
        </div>
      ))}
      <div className="option-row add">
        <input autoFocus={autoFocus} value={draft} placeholder={options.length ? "Add an option" : "First option"}
               onChange={(e) => setDraft(e.target.value)}
               onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t.includes("\n")) { e.preventDefault(); add(t); } }}
               onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button className="sm" disabled={!draft.trim()} onClick={() => add()}>Add</button>
      </div>
    </div>
  );
}

/** The same edits on a plain list, for a field that doesn't exist yet. */
export function localOptions(options: string[], set: (options: string[]) => void): Omit<OptionsProps, "options"> {
  return {
    onAdd: (o) => set(cleanOptions([...options, o])),
    onRename: (from, to) => to.trim() && set(cleanOptions(options.map((o) => (o === from ? to : o)))),
    onRemove: (o) => set(options.filter((x) => x !== o)),
    onMove: (o, d) => {
      const i = options.indexOf(o), j = i + d;
      if (j < 0 || j >= options.length) return;
      const next = [...options];
      [next[i], next[j]] = [next[j], next[i]];
      set(next);
    },
  };
}

// Categories: where a record's thumbnails (and any song image) go. Each is an image column in the Sheet and on the
// slides: General (SONG IMAGE, the main image) and one per category the show has in Fields (Content, LX, Video…).
// Ones added here by name are categories in Fields too, and their column is made when media first goes in them. Older ones added as a lone image column can be renamed and removed once
// nothing is filed in them. Pick one (CategoryPicker), or add, rename and delete them
// (CategoryEditor, also as CategoriesDialog from the Category menus).
import { useState } from "react";
import { backend } from "../backend";
import { addCategory, categories, deleteCategory, mediaIn, renameCategory, type Category } from "../model/ops";
import { useStore } from "../store";
import { DraftInput } from "./fields";
import { Icon } from "./icons";

/** The categories as cards to pick from, with their editor a click away. `value` is a category (column) id. */
export function CategoryPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const show = useStore((s) => s.show)!;
  const [editing, setEditing] = useState(false);
  const cats = categories(show);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {editing ? <CategoryEditor onAdded={onChange} /> : (
        <div className="question">
          {cats.map((c) => (
            <button key={c.id} className={`qopt ${value === c.id ? "on" : ""}`} onClick={() => onChange(c.id)}>
              <span className="radio" />
              <div><div className="t">{c.name}</div><div className="d">{describe(c, show.columns.some((x) => x.id === c.id))}</div></div>
            </button>
          ))}
        </div>
      )}
      <div><button className="link" onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit categories"}</button></div>
    </div>
  );
}

const describe = (c: Category, exists: boolean) => `The ${c.column} column${exists ? "" : " (made when it's first used)"}.`;

/** Add, rename and delete categories. `onAdded` gets a newly added category's id. */
export function CategoryEditor({ onAdded }: { onAdded?: (id: string) => void }) {
  const show = useStore((s) => s.show)!;
  const update = useStore((s) => s.update);
  const [name, setName] = useState("");
  const cats = categories(show);

  async function remove(c: Category) {
    if (await backend.confirm(`Delete the ${c.name} category? Its ${c.column} column leaves the Sheet and slides.`)) update((s) => deleteCategory(s, c.id));
  }
  /** Why a category can't be deleted yet: media is filed in it. */
  function filed(c: Category): string {
    const m = mediaIn(show, c.id);
    return m.songs || m.records ? `${c.name} still has media (${[m.songs && `${m.songs} song${m.songs === 1 ? "" : "s"}`, m.records && `${m.records} record${m.records === 1 ? "" : "s"}`].filter(Boolean).join(", ")}): remove it first` : "";
  }
  function add() {
    if (!name.trim()) return;
    let id = "";
    update((s) => { id = addCategory(s, name); });
    setName("");
    onAdded?.(id);
  }

  return (
    <div className="cat-editor">
      {cats.map((c) => (
        <div key={c.id} className="cat-row">
          {c.fixed ? <span className="cat-fixed">{c.name}</span>
            : <DraftInput value={c.name} placeholder="Category name" onCommit={(v) => v.trim() && update((s) => renameCategory(s, c.id, v))} />}
          <span className="muted small">{c.column} column</span>
          {c.fixed || !show.columns.some((x) => x.id === c.id)
            ? <span className="cat-act" />
            : <button className="icon cat-act" disabled={Boolean(filed(c))} title={filed(c) || `Delete ${c.name}`} onClick={() => remove(c)}><Icon name="trash" size="sm" /></button>}
        </div>
      ))}
      <div className="cat-row add">
        <input value={name} placeholder="New category, e.g. Lasers" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="sm" onClick={add} disabled={!name.trim()}><Icon name="plus" size="sm" /> Add</button>
      </div>
    </div>
  );
}

/** The editor in a dialog, for the Category menus. */
export function CategoriesDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal narrow" role="dialog" aria-label="Categories">
        <header className="modal-head">
          <div><h3>Categories</h3><p>Where thumbnails and song images go. Each is an image column in the Sheet and on the slides.</p></div>
        </header>
        <div className="modal-body"><CategoryEditor /></div>
        <footer className="modal-foot"><button className="primary" onClick={onClose}>Done</button></footer>
      </div>
    </div>
  );
}

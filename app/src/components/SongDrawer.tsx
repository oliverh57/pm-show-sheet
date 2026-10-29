// Song detail panel: opens over the page when a card is clicked.
// Overview: the image (click it to crop a photo, or pick a better frame from the video), the Song card (TC, BPM, audio version, segue,
// status), then one panel of fields grouped by category (department): the colours, the standard data fields and any custom
// fields (text, notes, a colour or a list), each under its own category.
import { Fragment, useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import {
  addChoiceOption, archiveSong, deleteSong, deptList, deptName, fieldLabel, isFieldColumn, listOf, moveChoiceOption,
  openReviews, removeAudio, removeChoiceOption, removeColumn, renameChoiceOption, renameField, restoreSong, reviewsOn, setField, songAudio, songRecords,
  syncAudioField, toggleStatus,
} from "../model/ops";
import { removeRecordAndMedia } from "../library";
import { useStore } from "../store";
import { DraftInput, FieldInput, OptionsEditor } from "./fields";
import { Icon } from "./icons";
import { SongComments } from "./Comments";
import { AudioList, RecordList } from "./MediaLists";
import { MediaViewer } from "./MediaViewer";
import { SaveCopy } from "./SaveCopy";
import { Colours, FieldSwatches, Media } from "./SongSections";
import { HeroCrop } from "./HeroCrop";
import { isGrab, thumbSource, ThumbPicker } from "./ThumbPicker";
import type { Clip, ColumnDef } from "../model/types";

type Tab = "overview" | "media" | "comments";
const SECTION_TABS: Record<string, Tab> = { media: "media", renders: "media", records: "media", audio: "media", comments: "comments" };
const CORE_FIELDS = new Set(["num", "name", "tc", "bpm", "audio"]);

export function SongDrawer() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const songId = useStore((s) => s.drawerSongId)!;
  const focus = useStore((s) => s.drawerFocus);
  const { update, closeDrawer, startImport, toast } = useStore.getState();
  const [tab, setTab] = useState<Tab>(focus && SECTION_TABS[focus] ? SECTION_TABS[focus] : "overview");
  const [optionsFor, setOptionsFor] = useState<string | null>(null); // the list field whose options are open
  const [renaming, setRenaming] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null); // the image, clip or record open full screen, with its comments
  const bodyRef = useRef<HTMLDivElement>(null);
  const song = show.songs[songId];
  const openComments = openReviews(show, songId);

  useEffect(() => {
    if (!focus || SECTION_TABS[focus]) return;
    if (focus === "colours") return void bodyRef.current?.querySelector('[data-col="colours"]')?.scrollIntoView({ block: "center" });
    const el = bodyRef.current?.querySelector<HTMLTextAreaElement>(`[data-col="${CSS.escape(focus)}"] textarea, [data-col="${CSS.escape(focus)}"] input`);
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focus]);

  const archived = listOf(show, song.id) === "archive";
  const pos = show.set_order.indexOf(song.id);
  const ticks = show.columns.filter((c) => c.type === "tick");
  const text = show.columns.filter((c) => (isFieldColumn(c) || c.type === "palette") && !CORE_FIELDS.has(c.id));
  // Fields by category, in the show's category order; the swatches lead the Colour one.
  const groups = [...new Set<string>(["COLOUR", ...deptList(show)])]
    .map((dept) => ({ dept, cols: text.filter((c) => c.dept === dept) }))
    .filter((g) => g.cols.length || g.dept === "COLOUR");
  const source = thumbSource(show, bundle, song);
  const [picking, setPicking] = useState<{ replace: string | null; clip?: Clip } | null>(null); // the thumbnail being picked from video
  const [cropping, setCropping] = useState(false);
  // A photo that was added (not a frame grabbed from video) is cropped rather than re-picked.
  const photo = song.hero_crop?.src ?? (song.hero && !isGrab(song.hero) ? song.hero : null);
  const editHero = photo ? () => setCropping(true) : source ? () => setPicking({ replace: song.hero! }) : null;
  const set = (colId: string, v: string) => update((s) => setField(s, song.id, colId, v));
  const fieldRow = (c: ColumnDef) => (
    <Fragment key={c.id}>
    <div className="frow top field-row" data-col={c.id}>
      {renaming === c.id
        ? <span><input autoFocus className="rename-input" defaultValue={fieldLabel(c)} aria-label="Field name" onFocus={(e) => e.currentTarget.select()}
                       onBlur={(e) => renameTo(c, e.currentTarget.value)}
                       onKeyDown={(e) => {
                         if (e.key === "Enter") e.currentTarget.blur();
                         if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.value = fieldLabel(c); e.currentTarget.blur(); }
                       }} /></span>
        : <span><span onDoubleClick={() => setRenaming(c.id)}>{fieldLabel(c)}</span>
            <button className="icon field-action" title={`Rename ${fieldLabel(c)} on every song`} onClick={() => setRenaming(c.id)}><Icon name="pencil" size="sm" /></button>
            {c.type === "choice" && <button className="icon field-action" title={`Edit the options of ${fieldLabel(c)}`} onClick={() => setOptionsFor(optionsFor === c.id ? null : c.id)}><Icon name="list" size="sm" /></button>}
            <button className="icon field-action remove-field" title={`Remove ${fieldLabel(c)} from every song`} onClick={() => removeField(c)}><Icon name="trash" size="sm" /></button></span>}
      {c.type === "palette" ? <FieldSwatches song={song} colId={c.id} /> : <FieldInput col={c} value={song.fields[c.id] ?? ""} onCommit={(v) => set(c.id, v)} />}
    </div>
    {optionsFor === c.id && (
      <div className="frow"><span /><div className="field-options">
        <OptionsEditor options={c.options ?? []} autoFocus={!c.options?.length}
                       onAdd={(o) => update((s) => addChoiceOption(s, c.id, o))}
                       onRename={(from, to) => update((s) => renameChoiceOption(s, c.id, from, to))}
                       onRemove={(o) => removeOption(c, o)}
                       onMove={(o, d) => update((s) => moveChoiceOption(s, c.id, o, d))} />
      </div></div>
    )}
    </Fragment>
  );

  async function removeOption(c: ColumnDef, option: string) {
    const used = Object.values(show.songs).filter((s) => s.fields[c.id] === option).length;
    if (used && !(await backend.confirm(`Remove “${option}”? ${used} song${used === 1 ? " has" : "s have"} it picked and will be cleared.`))) return;
    update((s) => removeChoiceOption(s, c.id, option));
  }

  async function removeField(c: ColumnDef) {
    const used = Object.values(show.songs).filter((s) => (s.fields[c.id] ?? "").trim() || s.swatches?.[c.id]?.length).length;
    const notes = used ? ` The ${c.type === "longtext" ? "notes" : "values"} in it on ${used} song${used === 1 ? "" : "s"} will be deleted too.` : "";
    if (!(await backend.confirm(`Remove “${fieldLabel(c)}” from every song?${notes} It also comes out of the Sheet.`))) return;
    update((s) => removeColumn(s, c.id));
    toast(`Removed ${fieldLabel(c)}`);
  }

  async function renameTo(c: ColumnDef, value: string) {
    setRenaming(null);
    const name = value.trim();
    if (!name || name === fieldLabel(c)) return;
    if (!(await backend.confirm(`Rename “${fieldLabel(c)}” to “${name}”? This renames the field on every song, and its column in the Sheet.`))) return;
    update((s) => renameField(s, c.id, name));
    toast(`Renamed to ${name} on every song`);
  }

  async function remove() {
    if (await backend.confirm(`Delete "${song.fields.name || "this song"}"?`)) {
      closeDrawer();
      update((s) => deleteSong(s, song.id));
    }
  }

  async function addFiles(kind: "audio" | "video") {
    const paths = await backend.chooseFiles(kind, true);
    if (paths.length) startImport(paths);
  }

  /** Show settings, with the field manager open. */
  function manageFields() {
    const { setView, setColumnsOpen } = useStore.getState();
    setView("settings");
    setColumnsOpen(true);
  }

  return (
    <>
      <div className="drawer-scrim" onClick={closeDrawer} />
      <aside className="drawer" data-song-id={song.id}>
        <div className="dh">
          <div style={{ flex: 1, minWidth: 0 }} data-col="name moved archived restored">
            <div className="n">{archived ? "Archived" : `Song ${String(pos + 1).padStart(2, "0")}`}</div>
            <DraftInput value={song.fields.name ?? ""} placeholder="Song name" onCommit={(v) => set("name", v)} />
          </div>
          <button className="icon" onClick={closeDrawer} title="Close (Esc)"><Icon name="x" /></button>
        </div>
        <div className="tabs">
          {(["overview", "media", "comments"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-col={{ overview: undefined, media: "hero gallery clips records audio", comments: "comments" }[t]}>
              {{ overview: "Overview", media: "Media", comments: "Comments" }[t]}
              {t === "comments" && openComments > 0 && <span className="tab-count">{openComments}</span>}
            </button>
          ))}
        </div>
        <div className="content" ref={bodyRef}>
          {tab === "overview" && (
            <>
              {song.hero && (
                <div className="preview">
                  <div className="im pickable" data-col="hero" onClick={() => setWatching(song.hero!)} title="Open full screen">
                    <img src={backend.mediaUrl(bundle, song.hero)} alt="" />
                    {editHero && (
                      <button className="change sm-pill" title={photo ? "Crop the image" : "Choose a different frame from the video"} onClick={(e) => { e.stopPropagation(); editHero(); }}>
                        <Icon name={photo ? "crop" : "image"} size="sm" /> {photo ? "Crop" : "Change thumbnail"}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {!song.hero && source && <button className="sm" style={{ marginBottom: 12 }} onClick={() => setPicking({ replace: null })}><Icon name="image" size="sm" /> Pick a thumbnail from the video</button>}
              <div className="panel">
                <div className="label">Song</div>
                <div className="frow" data-col="tc"><span>TC start</span><DraftInput mono value={song.fields.tc ?? ""} onCommit={(v) => set("tc", v)} /></div>
                <div className="frow" data-col="bpm"><span>BPM</span><DraftInput value={song.fields.bpm ?? ""} onCommit={(v) => set("bpm", v.trim())} /></div>
                <div className="frow" data-col="audio"><span>Audio version</span><DraftInput value={song.fields.audio ?? ""} onCommit={(v) => set("audio", v)} /></div>
                <div className="frow" data-col="segues_into_next"><span>Segues into next</span>
                  <div className="setting-row"><span className="muted">Shows as “Cont.” in the Sheet</span>
                    <button className={`toggle ${song.segues_into_next ? "on" : ""}`} aria-label="Segues into the next song"
                            onClick={() => update((s) => { s.songs[song.id].segues_into_next = !s.songs[song.id].segues_into_next; })} />
                  </div>
                </div>
                {ticks.length > 0 && (
                  <div className="frow"><span>Status</span>
                    <div className="ticks">
                      {ticks.map((c) => (
                        <label key={c.id} className={`tick-chip ${song.statuses[c.id] ? "on" : ""}`} data-col={c.id}>
                          <input type="checkbox" checked={Boolean(song.statuses[c.id])} onChange={() => update((s) => toggleStatus(s, song.id, c.id))} />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="panel">
                <div className="label">Data fields</div>
                {groups.map((g) => (
                  <div key={g.dept} className="field-group">
                    <div className="fgroup-label">{g.dept === "CORE" ? "General" : deptName(g.dept, show)}</div>
                    {g.dept === "COLOUR" && <div className="frow top" data-col="colours"><span>Colour</span><Colours song={song} /></div>}
                    {g.cols.map(fieldRow)}
                  </div>
                ))}
                <div className="frow field-buttons">
                  <button className="ghost sm" title="Edit, reorder and remove fields in Show settings" onClick={manageFields}><Icon name="settings" size="sm" /> Manage fields</button>
                </div>
              </div>
            </>
          )}
          {tab === "comments" && <SongComments song={song} />}
          {tab === "media" && (
            <>
              <div className="panel"><div className="label">Renders &amp; stills</div><Media song={song} onOpen={setWatching} /></div>
              <div className="panel">
                <div className="label">Clips</div>
                {(song.clips ?? []).length === 0 && songRecords(show, song.id).length === 0 && <p className="muted" style={{ margin: 0 }}>No clips yet. Add a show record on the Media page.</p>}
                {(song.clips ?? []).map((c) => <ClipRow key={c.path} bundle={bundle} path={c.path} still={c.still} label={`${formatTime(c.in)} – ${formatTime(c.out)} · ${c.source === "auto_tc" ? "from timecode" : "marked by hand"}`}
                                                        open={reviewsOn(show, c.record_id, c.in, c.out).filter((r) => !r.done).length} onPlay={() => setWatching(c.path)}
                                                        onPickThumb={() => setPicking({ replace: c.still ?? null, clip: c })} />)}
                <RecordList records={songRecords(show, song.id)} empty="" onWatch={setWatching} onRemove={(id) => removeRecordAndMedia(id)} />
                <div style={{ marginTop: 10 }}><button className="sm" onClick={() => addFiles("video")}><Icon name="plus" size="sm" /> Add a song clip</button></div>
              </div>
              <div className="panel">
                <div className="label">Audio versions</div>
                <AudioList files={songAudio(show, song.id)} empty="No audio for this song yet."
                           onRemove={(id) => update((s) => { removeAudio(s, id); syncAudioField(s, song.id); })} />
                <div style={{ marginTop: 10 }}><button className="sm" onClick={() => addFiles("audio")}><Icon name="plus" size="sm" /> Add a version</button></div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <div style={{ display: "flex", gap: 6 }}>
            {archived
              ? <button className="sm" onClick={() => update((s) => restoreSong(s, song.id))}><Icon name="undo" size="sm" /> Back into the set</button>
              : <button className="sm" onClick={() => update((s) => archiveSong(s, song.id))}><Icon name="archive" size="sm" /> Archive</button>}
            <button className="sm ghost danger" onClick={remove}><Icon name="trash" size="sm" /> Delete</button>
          </div>
          <button className="sm primary" onClick={closeDrawer}>Done</button>
        </div>
      </aside>
      {watching && <MediaViewer song={song} start={watching} play onClose={() => setWatching(null)} />}
      {picking && (picking.clip || source) && <ThumbPicker song={song} replace={picking.replace} clip={picking.clip} onClose={() => setPicking(null)} />}
      {cropping && photo && <HeroCrop song={song} src={photo} onClose={() => setCropping(false)}
                                      onPickFrame={source ? () => { setCropping(false); setPicking({ replace: song.hero! }); } : undefined} />}
    </>
  );
}

function ClipRow({ bundle, path, still, label, open: comments, onPlay, onPickThumb }:
                 { bundle: string; path: string; still?: string; label: string; open: number; onPlay: () => void; onPickThumb: () => void }) {
  return (
    <div className="media-row clip-row">
      {still && <img className="clip-thumb" src={backend.mediaUrl(bundle, still)} alt="" title="Play it full screen" onClick={onPlay} />}
      <div className="media-main">
        <strong title={path.split("/").pop()}>{path.split("/").pop()}</strong>
        <span className="muted small">{label}</span>
        <div className="clip-acts">
          <button className="sm" title="Play it full screen, with its comments beside it" onClick={onPlay}><Icon name="play" size="sm" /> Play{comments ? <span className="muted"> · {comments} open</span> : null}</button>
          <button className="sm" title="Pick the frame used as its thumbnail" onClick={onPickThumb}><Icon name="image" size="sm" /> Thumbnail</button>
          <SaveCopy path={`${bundle}/${path}`} video />
        </div>
      </div>
    </div>
  );
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

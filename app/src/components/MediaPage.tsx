// Media: drop files in (they go to "What is this media?"), see what the show has, and cull
// renders in the Render inbox tab.
import { useRef, useState, type ReactNode } from "react";
import { backend } from "../backend";
import { categories, categoryName, cleanLabel, clipCategory, clipLength, clipName, fileName, guessRecordLabel, ltcFromName, moveClip, recordMedia, removeAudio, retagRecord, syncAudioField } from "../model/ops";
import { CategoriesDialog } from "./Categories";
import { useStore } from "../store";
import { Icon, type IconName } from "./icons";
import { infoLine } from "./MediaLists";
import { MediaPlayer } from "./Player";
import { MediaViewer } from "./MediaViewer";
import { formatTime } from "./SongDrawer";
import { deleteClip, deleteRecordStill, deleteRecordStills, deleteSongImage, removeRecordAndMedia } from "../library";
import { RenderInbox } from "./RenderInbox";
import { MenuPopup, SaveCopy, useMenu } from "./SaveCopy";
import { CloudButton, useFileStates } from "./CloudFiles";
import { repickStill, repickStills, runClipJobs } from "../jobs";
import { download, removeDownloads, type FileState } from "../storage";
import type { Clip, SourceRecord } from "../model/types";
import { linkWatchFolder, unlinkWatchFolder, useWatchFolders } from "../watchFolders";

/**
 * A record or audio file that isn't on this Mac (it was added on another Mac, or its disk isn't plugged in): find it
 * here. Each Mac keeps its own path, so the last one set is what the show has; the other Mac locates it again.
 */
function Locate({ kind, id, path, onFound }: { kind: "record" | "audio"; id: string; path: string; onFound: () => void }) {
  const update = useStore((s) => s.update);
  async function locate() {
    const [picked] = await backend.chooseFiles(kind === "record" ? "video" : "audio", false);
    if (!picked) return;
    const was = fileName(path), now = fileName(picked);
    if (was !== now && !(await backend.confirm(`That file is called ${now}, not ${was}. Use it anyway?`))) return;
    update((s) => {
      const item = kind === "record" ? s.records?.find((r) => r.id === id) : s.audio?.find((a) => a.id === id);
      if (item) item.path = picked;
    });
    onFound();
  }
  return (
    <button className="sm" title={`Not found on this Mac: ${path}`} onClick={locate}>
      <Icon name="alert" size="sm" /> Locate…
    </button>
  );
}

/**
 * The "⋯" menu on a group of show records: the category their thumbnails are filed under (changing it moves them),
 * picking stills again, downloads, renaming or moving into another group, and removing them.
 */
function RecordMenu({ ids, category, paths, states, refresh, others, onRepick, onRename, onCombine }: {
  ids: string[]; category: string; paths: string[]; states: Record<string, FileState>; refresh: () => void; others: string[];
  onRepick?: () => void; onRename: () => void; onCombine: (label: string) => void;
}) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, toast } = useStore.getState();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenu(wrap, button, 250);
  const [editing, setEditing] = useState(false);
  const local = paths.filter((p) => states[p] === "local");
  const online = paths.filter((p) => states[p] === "online");
  const act = (fn: () => unknown) => () => { menu.close(); fn(); };
  async function files(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { toast(String(e).replace(/^Error: /, "")); }
    refresh();
  }
  return (
    <span ref={wrap}>
      <button ref={button} className={`icon ${menu.pos ? "on" : ""}`} title="More" onClick={menu.toggle}><Icon name="more" /></button>
      <MenuPopup menu={menu}>
        <div className="save-group">
          <div className="save-label">Category</div>
          {categories(show).map((c) => (
            <button key={c.id} className="pick" onClick={act(() => update((s) => { for (const id of ids) retagRecord(s, id, c.id); }))}>
              <span>{c.id === category ? <Icon name="check" size="sm" /> : <i />}{c.name}</span>
            </button>
          ))}
          <button className="pick" onClick={act(() => setEditing(true))}><span><i />Edit categories…</span></button>
        </div>
        <div className="save-group">
          {onRepick && <button onClick={act(onRepick)}><span>Pick best stills</span><small>Each song's sharpest, brightest frame</small></button>}
          {local.length > 0 && (
            <button onClick={act(() => files(async () => toast(`Removed ${await removeDownloads(bundle, local)} files from this Mac`)))}>
              <span>Remove downloads</span><small>The clips stay in Google Drive</small>
            </button>
          )}
          {!local.length && online.length > 0 && <button onClick={act(() => files(() => download(bundle, online)))}><span>Download the clips</span></button>}
          <button onClick={act(onRename)}><span>Rename…</span></button>
        </div>
        {others.length > 0 && (
          <div className="save-group">
            <div className="save-label">Move into</div>
            {others.map((o) => <button key={o} onClick={act(() => onCombine(o))}><span className="nm">{o}</span></button>)}
          </div>
        )}
        <div className="save-group">
          <button className="danger" onClick={act(() => removeRecordAndMedia(ids))}><span>Remove from the show</span><small>With {ids.length === 1 ? "its" : "their"} clips and stills</small></button>
        </div>
      </MenuPopup>
      {editing && <CategoriesDialog onClose={() => setEditing(false)} />}
    </span>
  );
}

/** The "⋯" menu on one clip: the category it's in (moving it away from the rest of its record's), and deleting it. */
function ClipMenu({ songId, clip }: { songId: string; clip: Clip }) {
  const show = useStore((s) => s.show)!;
  const { update, toast } = useStore.getState();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenu(wrap, button, 250);
  const current = clipCategory(show, clip);
  const act = (fn: () => unknown) => () => { menu.close(); fn(); };
  function move(id: string, name: string) {
    if (id === current) return;
    update((s) => moveClip(s, songId, clip.path, id));
    toast(`${clipName(show, songId)} moved to ${name}`);
  }
  return (
    <span ref={wrap}>
      <button ref={button} className={`icon ${menu.pos ? "on" : ""}`} title="More" onClick={menu.toggle}><Icon name="more" size="sm" /></button>
      <MenuPopup menu={menu}>
        <div className="save-group">
          <div className="save-label">Category</div>
          {categories(show).map((c) => (
            <button key={c.id} className="pick" onClick={act(() => move(c.id, c.name))}>
              <span>{c.id === current ? <Icon name="check" size="sm" /> : <i />}{c.name}</span>
            </button>
          ))}
        </div>
        <div className="save-group">
          <button className="danger" onClick={act(() => deleteClip(songId, clip.path))}><span>Delete this clip</span><small>The show record isn't touched</small></button>
        </div>
      </MenuPopup>
    </span>
  );
}

export function MediaPage() {
  const tab = useStore((s) => s.mediaTab);
  const setTab = useStore((s) => s.setMediaTab);
  const head = (
    <div className="page-head">
      <div><h1>Media</h1><div className="sub">{tab === "add" ? "Drop files anywhere on this page" : "Approve renders and assign them to songs"}</div></div>
      <div className="acts">
        <div className="seg">
          <button className={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Add media</button>
          <button className={tab === "inbox" ? "on" : ""} onClick={() => setTab("inbox")}>Render inbox</button>
        </div>
      </div>
    </div>
  );
  if (tab === "inbox") return <div className="page full">{head}<RenderInbox /></div>;
  return <div className="page">{head}<AddMedia /><Library /></div>;
}

function AddMedia() {
  const startImport = useStore((s) => s.startImport);
  const kind = (icon: IconName, colour: string, title: string, desc: string) => (
    <div className="kind"><div className="ic" style={{ color: colour }}><Icon name={icon} size="lg" /></div><div className="t">{title}</div><div className="d">{desc}</div></div>
  );
  async function choose() {
    const paths = await backend.chooseMedia();
    if (paths.length) startImport(paths);
  }
  return (
    <div className="dropzone">
      <div className="big"><Icon name="upload" size="lg" /></div>
      <h2>Drop media here</h2>
      <p>or <button className="link" onClick={choose}>choose files</button></p>
      <div className="kinds">
        {kind("film", "var(--tc)", "Show records & Depence renders", "Split into songs by their timecode, or by hand.")}
        {kind("image", "var(--accent)", "Renders & stills", "Assign to songs, or link a folder.")}
        {kind("music", "var(--ok)", "Audio", "Per-song files or full show playback.")}
      </div>
    </div>
  );
}

/** Which media groups are folded shut, remembered on this Mac. */
const FOLDED_KEY = "media.folded";
function useFolded() {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const toggle = (id: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])); } catch { /* not remembered */ }
    return next;
  });
  return [folded, toggle] as const;
}

/** A group's icon and name: clicking either folds the group open or shut. */
function GroupHead({ icon, open, onToggle, children }: { icon: IconName; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <span className="ic fold" onClick={onToggle}><Icon name={icon} /></span>
      <span className="nm fold" onClick={onToggle} title={open ? "Collapse" : "Expand"}>
        <Icon name={open ? "chevDown" : "chevR"} size="sm" /> {children}
      </span>
    </>
  );
}

function Library() {
  const show = useStore((s) => s.show)!;
  const { update, startImport, setMediaTab } = useStore.getState();
  const records = show.records ?? [];
  const audio = show.audio ?? [];
  const folders = useWatchFolders();
  const jobs = useStore((s) => s.jobs);
  const cutting = jobs.some((j) => j.status === "queued" || j.status === "running");
  const songName = (id?: string | null) => (id ? show.songs[id]?.fields.name : "") || "";
  const [playing, setPlaying] = useState<string | null>(null);
  const [watching, setWatching] = useState<{ songId: string; path: string } | null>(null); // a song clip in the viewer, with its comments
  const [openClips, setOpenClips] = useState<string | null>(null);
  const [repicking, setRepicking] = useState<{ id: string; done: number; total: number } | null>(null); // id: the group's key
  const [renaming, setRenaming] = useState<string | null>(null);
  const [folded, toggleFold] = useFolded();
  const bundle = useStore((s) => s.bundle)!;
  const clipsOf = (recordId: string) => show.set_order.concat(show.archive).flatMap((sid) =>
    (show.songs[sid]?.clips ?? []).filter((c) => c.record_id === recordId).map((c) => ({ ...c, songId: sid })));
  const allClips = records.flatMap((r) => clipsOf(r.id));
  const order = show.set_order.concat(show.archive);
  /**
   * Show records with the same name are one group ("DEPENCE RENDER"): songs recorded one at a time, or a show recorded
   * in parts, list together. Renaming a record to another's name puts it in that group.
   */
  const groups: { key: string; label: string; recs: SourceRecord[] }[] = [];
  for (const r of records.filter((r) => r.scope === "show")) {
    const label = cleanLabel(r.label ?? guessRecordLabel(show, r.path));
    const group = label ? groups.find((g) => g.label === label) : undefined;
    if (group) group.recs.push(r);
    else groups.push({ key: r.id, label, recs: [r] });
  }
  /** Rename records, joining any group that already has the name, and taking on its category. */
  function relabel(ids: string[], name: string) {
    const label = cleanLabel(name);
    if (!label) return;
    const into = groups.find((g) => g.label === label && !g.recs.some((r) => ids.includes(r.id)));
    const cols = [...new Set(into?.recs.map((r) => r.image_col ?? "hero"))];
    update((s) => {
      for (const id of ids) {
        const r = s.records?.find((x) => x.id === id);
        if (!r) continue;
        r.label = label;
        if (cols.length === 1 && (r.image_col ?? "hero") !== cols[0]) retagRecord(s, id, cols[0]);
      }
    });
    if (into) useStore.getState().toast(`Moved into ${label}`);
  }
  /** Pick each song's still again, one record of the group after another. */
  async function repickGroup(key: string, recs: SourceRecord[]) {
    const todo = recs.filter((r) => states[r.path] !== "missing" && clipsOf(r.id).length);
    const total = todo.reduce((n, r) => n + clipsOf(r.id).length, 0);
    let base = 0, n = 0;
    for (const r of todo) {
      n += await repickStills(bundle, r, (done) => setRepicking({ id: key, done: base + done, total }));
      base += clipsOf(r.id).length;
    }
    setRepicking(null);
    useStore.getState().toast(`Picked new stills for ${n} song${n === 1 ? "" : "s"}`);
  }
  const inBundle = (p: string) => (p.startsWith("/") ? p : `${bundle}/${p}`);
  /** Stills made from each show record: they're listed (and deleted) with their record. */
  const recordStills = new Map(records.filter((r) => r.scope === "show").map((r) => [r.id, recordMedia(show, r.id).stills]));
  const fromRecords = new Set([...recordStills.values()].flat());
  /** Every song's other renders and stills, in running order then the archive. */
  const images = show.set_order.concat(show.archive).flatMap((sid) => {
    const sg = show.songs[sid];
    return sg ? (sg.gallery ?? (sg.hero ? [sg.hero] : [])).filter((path) => !fromRecords.has(path)).map((path) => ({ songId: sid, path, hero: path === (sg.hero_crop?.src ?? sg.hero) })) : [];
  });
  /** Which song a still belongs to. */
  const stillSong = (path: string) => show.set_order.concat(show.archive).find((sid) => (show.songs[sid]?.gallery ?? []).includes(path));
  const imageSongs = new Set(images.map((i) => i.songId)).size;
  const [states, refreshStates] = useFileStates([...records.map((r) => r.path), ...audio.map((a) => a.path), ...allClips.map((c) => `${bundle}/${c.path}`), ...images.map((i) => inBundle(i.path))]);
  /** Songs marked in a record that have no clip yet (a clip run that was stopped part way). */
  const missingClips = (r: (typeof records)[number]) => (r.song_marks ?? []).filter((m) =>
    show.songs[m.song_id] && !(show.songs[m.song_id].clips ?? []).some((c) => c.record_id === r.id && Math.abs(c.in - m.in) < 0.5));
  /** Clips cut before clips kept the record's LTC: they can be cut again with it. */
  const recutButton = (r: (typeof records)[number], clips: ReturnType<typeof clipsOf>) => {
    const old = clips.filter((c) => ltcFromName(c.path) === null);
    if (r.ltc?.channel === null || r.ltc?.channel === undefined || !old.length || cutting) return null;
    return (
      <button className="sm" title="Cut these clips again with the record's timecode on one side, so anyone can download them with LTC"
              onClick={() => runClipJobs(bundle, r, old.map((c) => ({ song_id: c.songId, in: c.in, out: c.out, source: c.source, ...(c.cuts ? { cuts: c.cuts } : {}) })), false)}>
        <Icon name="radio" size="sm" /> Re-cut {old.length} clip{old.length === 1 ? "" : "s"} with timecode
      </button>
    );
  };
  /** A clip's category, when it was moved out of its record's (`cols`, the categories its group is in). */
  const movedTo = (c: Clip, cols: string[]) => {
    const col = c.category && !cols.includes(c.category) ? show.columns.find((x) => x.id === c.category) : undefined;
    return col ? ` · ${categoryName(col, show)}` : "";
  };
  const playButton = (id: string) => (
    <button className="sm" onClick={() => setPlaying(playing === id ? null : id)}>{playing === id ? "Hide" : <><Icon name="play" size="sm" /> Play</>}</button>
  );
  if (!records.length && !audio.length && !folders.length && !images.length) return null;

  async function linkFolder() {
    const path = await backend.chooseFolder("Choose the folder Depence exports renders into");
    if (path) linkWatchFolder(path);
  }

  return (
    <div className="lib">
      <div className="section-head"><h2>In this show</h2><button className="sm" onClick={linkFolder}><Icon name="folder" size="sm" /> Link a render folder…</button></div>
      <div className="lib-list">
        {groups.map(({ key, label, recs }) => {
          const ids = recs.map((r) => r.id);
          const one = recs.length === 1 ? recs[0] : null;
          const clips = recs.flatMap((r) => clipsOf(r.id)).sort((a, b) => order.indexOf(a.songId) - order.indexOf(b.songId));
          const marks = recs.reduce((n, r) => n + (r.song_marks?.length ?? 0), 0);
          const clipPaths = clips.map((c) => `${bundle}/${c.path}`);
          const here = (r: SourceRecord) => states[r.path] !== "missing"; // a record file is only on the Mac it was added on
          const away = recs.filter((r) => !here(r)).length;
          const stills = recs.flatMap((r) => (recordStills.get(r.id) ?? []).map((p) => ({ p, r, sid: stillSong(p) })))
            .sort((a, b) => order.indexOf(a.sid ?? "") - order.indexOf(b.sid ?? ""));
          const stillsText = stills.length ? `${stills.length} still${stills.length === 1 ? "" : "s"}` : "";
          const unsplit = recs.filter((r) => !clipsOf(r.id).length && !recordStills.get(r.id)?.length).length;
          const cols = [...new Set(recs.map((r) => r.image_col ?? "hero"))];
          const category = cols.length === 1 ? show.columns.find((c) => c.id === cols[0]) : undefined;
          const categoryText = cols.length > 1 ? "Mixed categories" : category ? categoryName(category, show) : "";
          const headline = [
            one ? "Show record" : `${recs.length} recordings`,
            clips.length ? `${clips.length} clip${clips.length === 1 ? "" : "s"}${marks > clips.length ? ` of ${marks}` : ""}` : "",
            stillsText,
            one && unsplit ? (marks ? `${marks} song${marks === 1 ? "" : "s"} marked, no clips yet` : one.ltc?.blocks.length ? `${one.ltc.blocks.length} TC blocks, not split yet` : "Not split yet") : "",
            !one && unsplit ? `${unsplit} not split yet` : "",
            categoryText,
            away ? (one ? "On another Mac" : `${away} on another Mac`) : "",
          ].filter(Boolean).join(" · ");
          const recJobs = jobs.filter((j) => ids.includes(j.recordId ?? ""));
          const runningJob = recJobs.find((j) => j.status === "running");
          const doneJobs = recJobs.filter((j) => j.status === "done").length;
          const showProgress = recJobs.some((j) => j.status === "queued" || j.status === "running");
          const canRepick = !cutting && !repicking && recs.some((r) => here(r) && clipsOf(r.id).length > 0);
          const open = !folded.has(key);
          return (
            <div key={key} className="rec-group">
              <div className="lib-row">
                <GroupHead icon="film" open={open} onToggle={() => renaming !== key && toggleFold(key)}>
                  {renaming === key
                    ? <input className="rename" autoFocus defaultValue={label} list="record-labels" onFocus={(e) => e.currentTarget.select()} onClick={(e) => e.stopPropagation()}
                             onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = label; e.currentTarget.blur(); } }}
                             onBlur={(e) => { relabel(ids, e.currentTarget.value); setRenaming(null); }} />
                    : label || one?.name}
                  <div className="muted small" style={{ fontWeight: 400 }}>{headline}</div>
                </GroupHead>
                <span className="acts">
                  <RecordMenu ids={ids} category={cols.length === 1 ? cols[0] : ""} paths={clipPaths} states={states} refresh={refreshStates}
                              others={groups.filter((g) => g.key !== key && g.label).map((g) => g.label)}
                              onRepick={canRepick ? () => repickGroup(key, recs) : undefined}
                              onRename={() => setRenaming(key)} onCombine={(to) => relabel(ids, to)} />
                </span>
              </div>
              {(showProgress || repicking?.id === key) && (
                <div className="rec-progress">
                  <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                  {repicking?.id === key
                    ? <span>Picking stills {Math.min(repicking.done + 1, repicking.total)} of {repicking.total}</span>
                    : <span>Cutting clip {Math.min(doneJobs + 1, recJobs.length)} of {recJobs.length}{runningJob ? ` · ${runningJob.label}` : ""}</span>}
                  <span className="bar"><span style={{ width: `${Math.round((repicking?.id === key ? repicking.done / (repicking.total || 1) : runningJob?.progress ?? 0) * 100)}%` }} /></span>
                </div>
              )}
              {open && clips.length > 0 && (
                <div className="clip-list">
                  {clips.map((c) => (
                    <div key={c.path}>
                      <div className="clip-item">
                        <Icon name="film" size="sm" />
                        <span className="nm" title={c.path.split("/").pop()}>{clipName(show, c.songId)}<span className="muted small"> · {formatTime(clipLength(c))}{movedTo(c, cols)}</span></span>
                        <CloudButton compact paths={[`${bundle}/${c.path}`]} states={states} refresh={refreshStates} />
                        <SaveCopy path={`${bundle}/${c.path}`} video compact />
                        <button className="icon" title="Play full screen, with its comments" onClick={() => setWatching({ songId: c.songId, path: c.path })}><Icon name="play" size="sm" /></button>
                        <ClipMenu songId={c.songId} clip={c} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {open && stills.length > 0 && (
                <div className="rec-stills">
                  <div className="rs-head">
                    <span><Icon name="image" size="sm" /> {stillsText}{categoryText ? ` · ${categoryText}` : ""}</span>
                    <button className="sm ghost" onClick={() => deleteRecordStills(ids)}><Icon name="trash" size="sm" /> Delete all stills</button>
                  </div>
                  <div className="rs-strip">
                    {stills.map(({ p, r, sid }) => {
                      // Pick another frame from the record on the Mac that has it, else from the song's clip of it.
                      const canPick = sid && ((here(r) && (r.song_marks ?? []).some((m) => m.song_id === sid)) || clipsOf(r.id).some((c) => c.songId === sid));
                      return (
                        <figure key={p} title={sid ? (canPick ? `${clipName(show, sid)}: click to pick another frame` : clipName(show, sid)) : fileName(p)}
                                className={canPick ? "pickable" : ""} onClick={canPick ? () => repickStill(bundle, r, sid, p) : undefined}>
                          <img src={backend.mediaUrl(bundle, p)} alt="" loading="lazy" />
                          <figcaption>{sid ? clipName(show, sid) : fileName(p)}</figcaption>
                          {/* A still no song uses any more is only on the record: it can go from there. */}
                          <button className="icon" title="Delete this still" onClick={(e) => { e.stopPropagation(); if (sid) deleteSongImage(sid, p); else deleteRecordStill(r.id, p); }}><Icon name="x" size="sm" /></button>
                        </figure>
                      );
                    })}
                  </div>
                </div>
              )}
              {open && recs.map((r) => {
                const recClips = clipsOf(r.id);
                const missing = missingClips(r);
                const rMarks = r.song_marks?.length ?? 0;
                const count = one ? "" : recClips.length ? ` · ${recClips.length} clip${recClips.length === 1 ? "" : "s"}` : " · not split yet";
                return (
                  <div key={r.id}>
                    <div className="rec-source">
                      <Icon name="link" size="sm" />
                      {here(r) ? (
                        <>
                          <span className="src" title={r.path}>{one ? "Cut from " : ""}{r.name}{count} · only on this Mac{r.info ? ` · ${infoLine(r.info)}` : ""}</span>
                          {missing.length > 0 && recClips.length > 0 && !cutting && (
                            <button className="sm" title="Some songs were marked but their clips weren't made" onClick={() => runClipJobs(bundle, r, missing, true)}>Make {missing.length} missing clip{missing.length === 1 ? "" : "s"}</button>
                          )}
                          {recutButton(r, recClips)}
                          <button className="sm ghost" onClick={() => setPlaying(playing === r.id ? null : r.id)}>{playing === r.id ? "Hide" : "Play"}</button>
                          <SaveCopy path={r.path} ltc={r.ltc?.channel} video compact />
                          <button className="sm ghost" onClick={() => startImport([], { kind: "record", id: r.id })}><Icon name="scissors" size="sm" /> {rMarks ? "Split again" : "Split into songs"}</button>
                        </>
                      ) : (
                        <>
                          <span className="src" title={r.path}>{one ? "Cut from a show record on another Mac. Only the clips are shared." : `${r.name}${count} · on another Mac`}</span>
                          <Locate kind="record" id={r.id} path={r.path} onFound={refreshStates} />
                        </>
                      )}
                      {!one && <button className="icon" title="Remove this recording, with its clips and stills" onClick={() => removeRecordAndMedia(r.id)}><Icon name="x" size="sm" /></button>}
                    </div>
                    {playing === r.id && <div className="lib-player"><MediaPlayer path={r.path} video ltc={r.ltc?.channel} channels={r.info?.audio_channels} autoPlay /></div>}
                  </div>
                );
              })}
            </div>
          );
        })}
        <datalist id="record-labels">{groups.filter((g) => g.label).map((g) => <option key={g.key} value={g.label} />)}</datalist>
        {images.length > 0 && (
          <div className="rec-group">
            <div className="lib-row">
              <GroupHead icon="image" open={!folded.has("images")} onToggle={() => toggleFold("images")}>
                Renders &amp; stills<div className="muted small" style={{ fontWeight: 400 }}>{images.length} image{images.length === 1 ? "" : "s"} · {imageSongs} song{imageSongs === 1 ? "" : "s"}</div>
              </GroupHead>
              <span className="acts">{images.length > 1 && <CloudButton all paths={images.map((i) => inBundle(i.path))} states={states} refresh={refreshStates} />}</span>
            </div>
            {!folded.has("images") && <div className="clip-list">
              {images.map(({ songId, path, hero }) => {
                const key = `${songId}|${path}`;
                return (
                  <div key={key}>
                    <div className="clip-item">
                      <span className="thumb" onClick={() => setPlaying(playing === key ? null : key)}><img src={backend.mediaUrl(bundle, path)} alt="" loading="lazy" /></span>
                      <span className="nm" title={fileName(path)}>{clipName(show, songId)}{hero && <span className="hero-tag">Hero</span>}<span className="muted small"> · {fileName(path)}</span></span>
                      <CloudButton compact paths={[inBundle(path)]} states={states} refresh={refreshStates} />
                      <SaveCopy path={inBundle(path)} compact />
                      <button className={`icon ${playing === key ? "on" : ""}`} title={playing === key ? "Hide the preview" : "View"} onClick={() => setPlaying(playing === key ? null : key)}><Icon name={playing === key ? "x" : "image"} size="sm" /></button>
                      <button className="icon" title="Delete this image from the show" onClick={() => deleteSongImage(songId, path)}><Icon name="trash" size="sm" /></button>
                    </div>
                    {playing === key && <div className="lib-player"><img className="lib-still" src={backend.mediaUrl(bundle, path)} alt="" /></div>}
                  </div>
                );
              })}
            </div>}
          </div>
        )}
        {records.filter((r) => r.scope === "song").map((r) => {
          const marks = r.song_marks?.length ?? 0;
          const detail = r.scope === "song" ? `Clip · ${songName(r.song_id)}`
            : marks ? `${marks} song${marks === 1 ? "" : "s"} marked` : r.ltc ? (r.ltc.blocks.length ? `${r.ltc.blocks.length} TC blocks` : "No timecode") : "Show record";
          const clips = clipsOf(r.id);
          const missing = r.scope === "show" ? missingClips(r) : [];
          const clipPaths = clips.map((c) => `${bundle}/${c.path}`);
          return (
            <div key={r.id}>
            <div className="lib-row">
              <span className="ic"><Icon name="film" /></span>
              <span className="nm" title={r.path}>{r.name}
                <div className="muted small"><span className="chip linked" title={r.path}><Icon name="link" size="sm" />Linked · stays on this Mac</span> {infoLine(r.info)}</div>
              </span>
              <span className="muted small">{detail}</span>
              <span className="acts">
                {states[r.path] !== "missing" && recutButton(r, clips)}
                {clips.length > 0 && missing.length > 0 && !cutting && (
                  <button className="sm" title="Some songs were marked but their clips weren't made" onClick={() => runClipJobs(bundle, r, missing, true)}>
                    <Icon name="film" size="sm" /> Make {missing.length} missing clip{missing.length === 1 ? "" : "s"}
                  </button>
                )}
                {states[r.path] === "missing" && <Locate kind="record" id={r.id} path={r.path} onFound={refreshStates} />}
                {states[r.path] !== "missing" && <SaveCopy path={r.path} ltc={r.ltc?.channel} video />}
                {clips.length > 0 && (
                  <button className="sm" onClick={() => setOpenClips(openClips === r.id ? null : r.id)}>
                    {clips.length} clip{clips.length === 1 ? "" : "s"} <Icon name={openClips === r.id ? "chevUp" : "chevDown"} size="sm" />
                  </button>
                )}
                {playButton(r.id)}
                {r.scope === "show" && <button className="sm" onClick={() => startImport([], { kind: "record", id: r.id })}><Icon name="scissors" size="sm" /> Split into songs</button>}
                <button className="icon" title="Remove from the show, with its clips and stills (the record stays where it is)" onClick={() => removeRecordAndMedia(r.id)}><Icon name="x" size="sm" /></button>
              </span>
            </div>
            {playing === r.id && <div className="lib-player"><MediaPlayer path={r.path} video ltc={r.ltc?.channel} channels={r.info?.audio_channels} autoPlay /></div>}
            {openClips === r.id && (
              <div className="clip-list">
                {clips.length > 1 && <div className="clip-bulk"><CloudButton all paths={clipPaths} states={states} refresh={refreshStates} /></div>}
                {clips.map((c) => (
                  <div key={c.path}>
                    <div className="clip-item">
                      <Icon name="film" size="sm" />
                      <span className="nm">{songName(c.songId)}<span className="muted small"> · {formatTime(c.in)} – {formatTime(c.out)}{movedTo(c, [r.image_col ?? "hero"])}</span></span>
                      <CloudButton compact paths={[`${bundle}/${c.path}`]} states={states} refresh={refreshStates} />
                      <SaveCopy path={`${bundle}/${c.path}`} video compact />
                      <button className="icon" title="Play full screen, with its comments" onClick={() => setWatching({ songId: c.songId, path: c.path })}><Icon name="play" size="sm" /></button>
                      <ClipMenu songId={c.songId} clip={c} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          );
        })}
        {audio.map((a) => (
          <div key={a.id}>
          <div className="lib-row">
            <span className="ic"><Icon name="music" /></span>
            <span className="nm" title={a.path}>{a.name}<div className="muted small">{infoLine(a.info)}</div></span>
            <span className="muted small">{a.scope === "song" ? `${a.version} · ${songName(a.song_id)}` : `Show audio ${a.version}`}</span>
            <span className="acts">
              {states[a.path] === "missing" && <Locate kind="audio" id={a.id} path={a.path} onFound={refreshStates} />}
              {states[a.path] !== "missing" && <SaveCopy path={a.path} ltc={a.ltc?.channel} />}
              {playButton(a.id)}
              {a.scope === "show" && <button className="sm" onClick={() => startImport([], { kind: "audio", id: a.id })}><Icon name="radio" size="sm" /> Match to songs</button>}
              <button className="icon" title="Remove (the file stays where it is)"
                      onClick={() => update((s) => { removeAudio(s, a.id); if (a.song_id) syncAudioField(s, a.song_id); })}><Icon name="x" size="sm" /></button>
            </span>
          </div>
          {playing === a.id && <div className="lib-player"><MediaPlayer path={a.path} video={false} ltc={a.ltc?.channel} channels={a.info?.audio_channels} autoPlay /></div>}
          </div>
        ))}
        {folders.map((f) => (
          <div key={f.id} className="lib-row">
            <span className="ic"><Icon name="folder" /></span>
            <span className="nm" title={f.path}>{f.label}
              <div className="muted small"><span className="chip linked"><Icon name="link" size="sm" />This Mac only</span> {f.path}</div>
            </span>
            <span className="muted small">Render folder</span>
            <span className="acts">
              <button className="sm" onClick={() => setMediaTab("inbox")}>Open inbox</button>
              <button className="icon" title="Stop watching" onClick={() => unlinkWatchFolder(f.id)}><Icon name="x" size="sm" /></button>
            </span>
          </div>
        ))}
      </div>
      {watching && show.songs[watching.songId] && <MediaViewer song={show.songs[watching.songId]} start={watching.path} play onClose={() => setWatching(null)} />}
    </div>
  );
}

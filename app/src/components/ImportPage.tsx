// Adding media: "What is this media?" → then, for a show record, read its LTC and split it into songs
// (or mark songs by hand when there's no timecode) and cut a clip per song in the background.
import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import { pickTopStills, runClipJobs } from "../jobs";
import {
  addAudio, addImages, addRecord, addSong, categories, deptCategory, ensureCategory, GENERAL, addSongWith, AUDIO_EXTENSIONS, cleanLabel, guessRecordLabel, recordClipName, extension, fileName, guessSong, guessVersion,
  marksToMake, matchBlocks, parseTc, setHero, setMarks, syncAudioField, tcAt, timeAtTc, VIDEO_EXTENSIONS,
} from "../model/ops";
import type { AudioFile, LtcResult, MediaInfo, Show, SongMark, SourceRecord } from "../model/types";
import { useStore } from "../store";
import { Icon, type IconName } from "./icons";
import { DraftInput } from "./fields";
import { MakeChoice, Marker, type Make } from "./Marker";
import { StillPicker } from "./StillPicker";
import { CategoryPicker } from "./Categories";
import { MediaPlayer } from "./Player";
import { SongPicker } from "./SongMenu";
import { linkWatchFolder } from "../watchFolders";
import { infoLine } from "./MediaLists";
import { formatTime } from "./SongDrawer";
import { IMAGE_EXTENSIONS } from "../backend";

type What = "show" | "song" | "renders" | "audio";
type Step = "what" | "scan" | "ltc" | "manual" | "assign" | "done";
type Source = { kind: "record" | "audio"; id: string };

function kindOf(path: string): "video" | "audio" | "image" | "folder" {
  const e = extension(path);
  if (e === "") return "folder";
  if (VIDEO_EXTENSIONS.includes(e)) return "video";
  if (AUDIO_EXTENSIONS.includes(e)) return "audio";
  return IMAGE_EXTENSIONS.includes(e) ? "image" : "video";
}

function guessWhat(paths: string[]): What {
  const kinds = new Set(paths.map(kindOf));
  if (kinds.has("video")) return "show";
  if (kinds.has("audio")) return "audio";
  return "renders";
}

const sourceFile = (show: Show, src: Source): SourceRecord | AudioFile | undefined =>
  src.kind === "record" ? show.records?.find((r) => r.id === src.id) : show.audio?.find((a) => a.id === src.id);

export function ImportPage() {
  const show = useStore((s) => s.show)!;
  const files = useStore((s) => s.importFiles);
  const initialSource = useStore((s) => s.importSource);
  const { setView } = useStore.getState();
  const [source, setSource] = useState<Source | null>(initialSource);
  const [step, setStep] = useState<Step>(() => {
    if (!initialSource) return files?.length ? "what" : "done";
    const f = sourceFile(show, initialSource);
    if (!f?.ltc) return "scan";
    return f.ltc.blocks.length ? "ltc" : initialSource.kind === "record" ? "manual" : "done";
  });
  const [assignPaths, setAssignPaths] = useState<string[]>([]);
  const [assignCategory, setAssignCategory] = useState(""); // the category the images being assigned go in
  const [make, setMake] = useState<Make>("clips"); // asked when the video is added, used when the songs are marked
  const asked = !initialSource; // what to make, the record's name and category were asked when it was added: not again
  const file = source ? sourceFile(show, source) : null;

  const picking = useStore((s) => s.stillPicks.length > 0 || s.jobs.some((j) => j.kind === "thumbnail"));
  const [picked, setPicked] = useState(false); // stays the thumbnail picker once the last one's picked
  useEffect(() => { if (picking) setPicked(true); }, [picking]);
  const thumbs = picking || picked;
  const title = { what: "What is this?", scan: "Reading the file", ltc: "Split by timecode", manual: "Mark the songs", assign: "Assign images", done: thumbs ? "Pick each song's thumbnail" : "Making clips" }[step];
  const back = () => setView("media");

  return (
    <div className="page">
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="icon back-btn" onClick={back} title="Back to Media"><Icon name="arrowL" /></button>
          <div><div className="faint small" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Add media</div><h1>{title}</h1></div>
        </div>
      </div>
      {step === "what" && files && (
        <WhatStep files={files} onNext={(next, src, paths, m, cat) => { if (src) setSource(src); if (paths) setAssignPaths(paths); if (m) setMake(m); if (cat) setAssignCategory(cat); setStep(next); }} />
      )}
      {step === "scan" && file && source && <ScanStep file={file} source={source} onDone={(r) => setStep(r.blocks.length ? "ltc" : source.kind === "record" ? "manual" : "done")} />}
      {step === "ltc" && file?.ltc && source && <LtcStep file={file} source={source} initialMake={make} asked={asked} onManual={() => setStep("manual")} onDone={() => setStep("done")} />}
      {step === "manual" && source?.kind === "record" && file && <Marker record={file as SourceRecord} initialMake={make} asked={asked} onDone={() => setStep("done")} />}
      {step === "assign" && <AssignStep paths={assignPaths} initialCategory={assignCategory} />}
      {step === "done" && (source?.kind === "audio" ? <NoTimecode /> : <DoneStep thumbs={thumbs} />)}
    </div>
  );
}

function NoTimecode() {
  const setView = useStore((s) => s.setView);
  return (
    <div className="placeholder">
      <div className="ic"><Icon name="radio" size="lg" /></div>
      <h3>No timecode in this audio</h3>
      <p>It's linked to the show. Add TC starts to songs by hand.</p>
      <div style={{ marginTop: 16 }}><button className="primary" onClick={() => setView("songs")}>Back to songs</button></div>
    </div>
  );
}

function FileCard({ paths, info }: { paths: string[]; info?: MediaInfo }) {
  const k = kindOf(paths[0]);
  const icon: IconName = k === "audio" ? "music" : k === "image" ? "image" : k === "folder" ? "folder" : "film";
  return (
    <div className="filecard">
      <div className="ic"><Icon name={icon} size="lg" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nm">{fileName(paths[0])}{paths.length > 1 && <span className="muted"> and {paths.length - 1} more</span>}</div>
        {info?.available && <div className="muted small" style={{ marginTop: 2 }}>{infoLine(info)}</div>}
      </div>
    </div>
  );
}

/** What a show record is ("NYC T5"): its clips are named after it. */
function ClipLabel({ value, onChange, asked }: { value: string; onChange: (v: string) => void; asked?: boolean }) {
  const show = useStore((s) => s.show)!;
  const first = show.set_order[0];
  const sample = first ? recordClipName(show, { label: value } as SourceRecord, first) : "";
  return (
    <label className="field" style={{ marginTop: asked ? 0 : 16, maxWidth: 520 }}>
      {!asked && <span className="field-label">What is this record?</span>}
      <input autoFocus={asked} value={value} onChange={(e) => onChange(e.target.value)} />
      {sample && <span className="muted small" style={{ marginTop: 4 }}>Clips are named like <span className="mono">{sample}.mp4</span></span>}
    </label>
  );
}

/** Renders go in Content by default, or General if the show has no Content category. */
const renderCategory = (show: Show) => categories(show).find((c) => c.id === deptCategory("CONTENT"))?.id ?? GENERAL;

function WhatStep({ files, onNext }: { files: string[]; onNext: (step: Step, source?: Source, paths?: string[], make?: Make, category?: string) => void }) {
  const show = useStore((s) => s.show)!;
  const { update, endImport, focusSong, setView, setMediaTab, toast } = useStore.getState();
  const songIds = [...show.set_order, ...show.archive];
  const [what, setWhat] = useState<What>(guessWhat(files));
  const [audioScope, setAudioScope] = useState<"show" | "song">(() => (guessSong(show, files[0]) ? "song" : "show"));
  const [songId, setSongId] = useState(() => guessSong(show, files[0]) ?? songIds[0] ?? "");
  const [version, setVersion] = useState(() => guessVersion(files[0]));
  const [label, setLabel] = useState(() => guessRecordLabel(show, files[0]));
  const [tag, setTag] = useState(GENERAL); // the category (image column id) its thumbnails go in
  const [renderTag, setRenderTag] = useState(() => renderCategory(show)); // the category renders and stills go in
  const folders = files.filter((p) => kindOf(p) === "folder");
  const [folderSong, setFolderSong] = useState(() => (folders[0] && guessSong(show, folders[0])) || ""); // "": different songs
  const [hasLtc, setHasLtc] = useState<"yes" | "no" | "unsure" | null>(null);
  const [make, setMake] = useState<Make>("clips");
  const [info, setInfo] = useState<MediaInfo | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (files.length === 1 && ["video", "audio"].includes(kindOf(files[0]))) backend.probe(files[0]).then(setInfo);
  }, [files]);

  // One question at a time: answering moves on, answered ones fold into a line above (with Change).
  type Q = "what" | "ltc" | "make" | "name" | "category" | "audio" | "song" | "folderSong";
  const questions: Q[] = what === "show" ? ["what", "ltc", "make", "name", "category"] : what === "song" ? ["what", "song", "category"]
    : what === "audio" ? ["what", "audio", ...(audioScope === "song" ? ["song" as const] : [])]
    : ["what", ...(folders.length ? ["folderSong" as const] : []), "category"];
  // Renders have their own category (Content by default); a record's or song clip's stills go in `tag`.
  const [cat, setCat] = what === "renders" ? [renderTag, setRenderTag] : [tag, setTag];
  const [at, setAt] = useState(0);
  const current = questions[Math.min(at, questions.length - 1)];
  const last = at >= questions.length - 1;
  const advance = () => setAt((i) => i + 1);
  const card = (on: boolean, pick: () => void, t: string, d: string, icon?: IconName, colour?: string) => (
    <button key={t} className={`qopt ${on ? "on" : ""}`} onClick={() => { pick(); advance(); }}>
      <span className="radio" />{icon && <span style={{ color: colour, display: "grid" }}><Icon name={icon} size="lg" /></span>}
      <div><div className="t">{t}</div><div className="d">{d}</div></div>
    </button>
  );
  const WHAT: Record<What, string> = { show: "Show record", song: "Song clip", renders: "Renders & stills", audio: "Audio" };
  const LTC = { yes: "Yes", no: "No", unsure: "Not sure" };
  const songLabel = (id: string) => (show.set_order.includes(id) ? `${String(show.set_order.indexOf(id) + 1).padStart(2, "0")} · ` : "Archive · ") + (show.songs[id]?.fields.name || "Untitled");
  const ask: Record<Q, string> = {
    what: "What is this media?", ltc: "Does this video have striped LTC?", make: "What would you like to do?", name: "What is this record?",
    category: what === "renders" ? `Which category ${files.length === 1 && !folders.length ? "does it" : "do they"} go in?` : what === "song" ? "Which category do its stills go in?" : "Which category do its thumbnails go in?",
    audio: "Whole show or one song?", song: "Which song?",
    folderSong: `Which song are the renders in ${folders.length === 1 ? "this folder" : "these folders"} for?`,
  };
  const answer: Record<Q, string> = {
    what: WHAT[what], ltc: hasLtc ? LTC[hasLtc] : "", make: make === "clips" ? "Video clips & thumbnails" : "Thumbnails only", name: label,
    category: categories(show).find((c) => c.id === cat)?.name ?? "",
    folderSong: folderSong ? songLabel(folderSong) : "Different songs", audio: `${audioScope === "show" ? "Whole show" : "One song"}${version.trim() ? ` · ${version.trim()}` : ""}`, song: songId ? songLabel(songId) : "",
  };
  const ready = !busy && (current !== "name" || label.trim() !== "") && (current !== "category" || cat !== "") && (current !== "song" || songId !== "");

  async function next() {
    setBusy(true);
    try {
      const infos = await Promise.all(files.map((p) => (["video", "audio"].includes(kindOf(p)) ? backend.probe(p) : Promise.resolve(undefined))));
      if (what === "show") {
        let first = "";
        update((s) => {
          const image_col = ensureCategory(s, tag);
          files.forEach((p, i) => {
            // No LTC: don't read the audio for it, go straight to marking songs by hand.
            const ltc = hasLtc === "no" ? { channel: null, fps: null, blocks: [], duration: infos[i]?.duration ?? 0 } : undefined;
            const id = addRecord(s, { path: p, scope: "show", info: infos[i], label: cleanLabel(label), image_col, ...(ltc ? { ltc } : {}) });
            if (i === 0) first = id;
          });
        });
        endImport();
        onNext(hasLtc === "no" ? "manual" : "scan", { kind: "record", id: first }, undefined, make);
      } else if (what === "song") {
        update((s) => { const image_col = ensureCategory(s, tag); files.forEach((p, i) => addRecord(s, { path: p, scope: "song", song_id: songId, info: infos[i], image_col })); });
        toast(`Added to ${show.songs[songId]?.fields.name || "the song"}`);
        endImport();
        setView("songs");
        focusSong(songId, "media");
      } else if (what === "renders") {
        const images = files.filter((p) => kindOf(p) === "image");
        if (folders.length) {
          update((s) => { ensureCategory(s, renderTag); });
          folders.forEach((p) => linkWatchFolder(p, { song_id: folderSong || undefined, image_col: renderTag }));
          toast(`Folder linked to the render inbox${folderSong ? ` for ${show.songs[folderSong]?.fields.name || "the song"}` : ""}`);
        }
        if (images.length) return onNext("assign", undefined, images, undefined, renderTag);
        endImport();
        setMediaTab("inbox");
        setView("media");
      } else if (audioScope === "song") {
        update((s) => { files.forEach((p, i) => { addAudio(s, { path: p, scope: "song", song_id: songId, version: version.trim() || guessVersion(p), info: infos[i] }); }); syncAudioField(s, songId); });
        toast(`New audio for ${show.songs[songId]?.fields.name || "the song"}`);
        endImport();
        setView("songs");
        focusSong(songId, "media");
      } else {
        let id = "";
        update((s) => { id = addAudio(s, { path: files[0], scope: "show", version: version.trim(), info: infos[0] }); });
        endImport();
        onNext("scan", { kind: "audio", id });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FileCard paths={files} info={info} />
      <div className="answered-list">
        {questions.slice(0, at).map((q, i) => (
          <div key={q} className="answered">
            <span className="q">{ask[q]}</span><span className="a">{answer[q]}</span>
            <button className="link" onClick={() => setAt(i)}>Change</button>
          </div>
        ))}
      </div>
      <div className="label">{ask[current]}</div>
      {current === "what" && (
        <div className="question">
          {card(what === "show", () => setWhat("show"), "Show record", "Whole show. Split into songs.", "film", "var(--tc)")}
          {card(what === "song", () => setWhat("song"), "Song clip", "One song's video.", "film", "var(--accent)")}
          {card(what === "renders", () => setWhat("renders"), "Renders & stills", "Assign to songs.", "image", "var(--accent)")}
          {card(what === "audio", () => setWhat("audio"), "Audio", "Playback or song audio.", "music", "var(--ok)")}
        </div>
      )}
      {current === "ltc" && (
        <div className="question three">
          {card(hasLtc === "yes", () => setHasLtc("yes"), "Yes", "Split it into songs by its timecode.")}
          {card(hasLtc === "no", () => setHasLtc("no"), "No", "Mark where each song starts by hand.")}
          {card(hasLtc === "unsure", () => setHasLtc("unsure"), "Not sure", "Check the audio for timecode (you can skip it).")}
        </div>
      )}
      {current === "make" && (
        <div className="question">
          {card(make === "clips", () => setMake("clips"), "Video clips & thumbnails", "A 720p clip of each song, with its best frame as the thumbnail.", "film", "var(--tc)")}
          {card(make === "stills", () => setMake("stills"), "Thumbnails only", "No clips: next, you pick each song's thumbnail from its best frames.", "image", "var(--accent)")}
        </div>
      )}
      {current === "name" && <ClipLabel value={label} onChange={setLabel} asked />}
      {current === "category" && <CategoryPicker value={cat} onChange={setCat} />}
      {current === "folderSong" && (
        <select style={{ maxWidth: 420 }} value={folderSong} onChange={(e) => setFolderSong(e.target.value)}>
          <option value="">Different songs: pick each one in the inbox</option>
          {songIds.map((id) => <option key={id} value={id}>{songLabel(id)}</option>)}
        </select>
      )}
      {current === "audio" && (
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div className="seg">
            <button className={audioScope === "show" ? "on" : ""} onClick={() => setAudioScope("show")}>Whole show</button>
            <button className={audioScope === "song" ? "on" : ""} onClick={() => setAudioScope("song")}>One song</button>
          </div>
          <input style={{ width: 160 }} placeholder="Version" value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
      )}
      {current === "song" && (
        <select style={{ maxWidth: 420 }} value={songId} onChange={(e) => setSongId(e.target.value)}>
          {songIds.length === 0 && <option value="">Add songs first</option>}
          {songIds.map((id) => <option key={id} value={id}>{songLabel(id)}</option>)}
        </select>
      )}
      <div className="flow-foot">
        {at > 0 && <button className="ghost" onClick={() => setAt(at - 1)}><Icon name="arrowL" /> Back</button>}
        {last ? (
          <button className="primary lg" onClick={next} disabled={!ready}>{busy ? "Adding…" : "Continue"} <Icon name="arrowR" /></button>
        ) : !["what", "ltc", "make"].includes(current) && (
          <button className="primary lg" onClick={advance} disabled={!ready}>Next <Icon name="arrowR" /></button>
        )}
      </div>
    </>
  );
}

function ScanStep({ file, source, onDone }: { file: SourceRecord | AudioFile; source: Source; onDone: (r: LtcResult) => void }) {
  const update = useStore((s) => s.update);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<LtcResult | null>(file.ltc ?? null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || file.ltc) return;
    started.current = true;
    backend.ltcScan(file.path, setProgress).then((r) => {
      update((s) => { const f = sourceFile(s, source); if (f) f.ltc = r; });
      setResult(r);
      setTimeout(() => onDone(r), 700);
    }, (e) => setError(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (state: "done" | "run" | "no" | "wait", t: string, d?: string, bar?: number) => (
    <div className={`astep ${state === "wait" ? "wait" : ""}`}>
      <span className="st">{state === "done" ? <span className="okc"><Icon name="check" size="sm" /></span> : state === "no" ? <span className="nc"><Icon name="x" size="sm" /></span> : state === "run" ? <div className="spinner" /> : <span className="nc" />}</span>
      <div className="tx"><div>{t}</div>{d && <div>{d}</div>}{bar !== undefined && <div className="progress"><i style={{ width: `${Math.round(bar * 100)}%` }} /></div>}</div>
    </div>
  );
  const found = result && result.channel !== null;
  return (
    <>
      <FileCard paths={[file.path]} info={file.info} />
      <div className="analysis">
        {row("done", "Reading file info", infoLine(file.info) || undefined)}
        {row(file.info?.timecode_track ? "done" : "no", "Timecode track", file.info?.timecode_track ? `Starts ${file.info.timecode_track}` : "None in the file")}
        {row(result ? (found ? "done" : "no") : error ? "no" : "run", "Looking for LTC in the audio",
             result ? (found ? `Found on channel ${result.channel! + 1} · ${result.fps} fps` : "No LTC on any channel") : error ?? undefined, result || error ? undefined : progress)}
        {result && found && row("done", "Timecode blocks", `${result.blocks.length} block${result.blocks.length === 1 ? "" : "s"}`)}
      </div>
      {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
    </>
  );
}

type Assignment = string; // a song id, "" (unassigned), "__new" or "__skip"

/** One part of a TC block. Usually a block is one song, but TC can run on through two sections (Intro → song). */
interface Segment {
  block: number;
  start: number; // file time; the first segment of a block starts at the block start
  song: Assignment;
}

function LtcStep({ file, source, initialMake, asked, onManual, onDone }: { file: SourceRecord | AudioFile; source: Source; initialMake: Make; asked: boolean; onManual: () => void; onDone: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, toast, setView, focusSong } = useStore.getState();
  const ltc = file.ltc!;
  const blocks = ltc.blocks;
  const fps = ltc.fps ?? 25;
  const isRecord = source.kind === "record";
  const byTc = useMemo(() => matchBlocks(show, blocks, fps), [show, blocks, fps]);
  const [segs, setSegs] = useState<Segment[]>(() => {
    const existing = isRecord ? (file as SourceRecord).song_marks ?? [] : [];
    const matched = matchBlocks(show, blocks, fps);
    return blocks.flatMap((b, i) => {
      const inBlock = existing.filter((m) => m.in >= b.file_start - 1 && m.in < b.file_end - 1).sort((x, y) => x.in - y.in);
      if (inBlock.length) return inBlock.map((m, j) => ({ block: i, start: j === 0 ? b.file_start : m.in, song: m.song_id }));
      return [{ block: i, start: b.file_start, song: matched[i] ?? "" }];
    });
  });
  const [make, setMake] = useState<Make>(isRecord ? initialMake : "none");
  const makeClips = make === "clips";
  const [label, setLabel] = useState(() => (isRecord ? (file as SourceRecord).label ?? guessRecordLabel(show, file.path) : ""));
  const [tag, setTag] = useState(() => (isRecord ? (file as SourceRecord).image_col ?? GENERAL : ""));
  const wantsStills = make !== "none";
  const player = useRef<HTMLVideoElement>(null);
  const [showPlayer, setShowPlayer] = useState(true);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const el = player.current;
    if (!el || !showPlayer) return;
    const tick = () => setNow(el.currentTime);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("seeked", tick);
    return () => { el.removeEventListener("timeupdate", tick); el.removeEventListener("seeked", tick); };
  }, [showPlayer]);
  const songIds = [...show.set_order, ...show.archive];
  const noSongs = show.set_order.length === 0;
  const isSong = (a: Assignment) => Boolean(a) && a !== "__skip";
  const used = new Set(segs.map((g) => g.song).filter((a) => isSong(a) && a !== "__new"));
  const missing = show.set_order.filter((id) => !used.has(id));
  const unmatched = segs.filter((g) => !g.song).length;
  const dur = ltc.duration || blocks[blocks.length - 1]?.file_end || 1;
  const name = (id: string) => show.songs[id]?.fields.name || "Untitled";
  const endOf = (k: number) => (segs[k + 1]?.block === segs[k].block ? segs[k + 1].start : blocks[segs[k].block].file_end);
  const tcOf = (k: number) => tcAt(blocks[segs[k].block], segs[k].start, fps);

  /** Move the player to `t` seconds into the file (showing it if it's hidden), optionally starting playback. */
  function seekTo(t: number, play = false) {
    const go = () => {
      const el = player.current;
      if (!el) return;
      el.currentTime = t;
      setNow(t);
      if (play) el.play().catch(() => {});
    };
    if (showPlayer && player.current) go();
    else { setShowPlayer(true); setTimeout(go, 50); }
  }
  const playAt = (t: number) => seekTo(t, true);
  const current = segs.findIndex((g, k) => now >= g.start && now < endOf(k));

  function pick(k: number, value: Assignment) {
    setSegs((cur) => cur.map((g, j) => (j === k ? { ...g, song: value } : g.song === value && isSong(value) && value !== "__new" ? { ...g, song: "" } : g)));
  }

  /** Insert a split after part `k` at `at`, giving the new part to `song` (and taking that song off any other part). */
  function insertSplit(k: number, at: number, song: Assignment) {
    const taken = (g: Segment) => isSong(song) && song !== "__new" && g.song === song;
    setSegs((cur) => [...cur.slice(0, k + 1).map((g) => (taken(g) ? { ...g, song: "" } : g)), { block: cur[k].block, start: at, song },
      ...cur.slice(k + 1).map((g) => (taken(g) ? { ...g, song: "" } : g))]);
  }

  /** Split block `block` at the player's position if it's inside the block, otherwise halve its last part. */
  function split(block: number, song: Assignment = "") {
    const parts = segs.map((g, k) => ({ g, k })).filter(({ g }) => g.block === block);
    const now = showPlayer ? player.current?.currentTime : undefined;
    const hit = now === undefined ? undefined : parts.find(({ g, k }) => now > g.start + 1 && now < endOf(k) - 1);
    const { g, k } = hit ?? parts[parts.length - 1];
    insertSplit(k, hit ? now! : g.start + (endOf(k) - g.start) / 2, song);
  }

  /** Split whichever part the player is in, at the player's position. */
  function splitHere(song: Assignment = "") {
    const t = player.current?.currentTime ?? now;
    const k = segs.findIndex((g, j) => t > g.start + 1 && t < endOf(j) - 1);
    if (k < 0) return toast("Move the player inside a block, at least a second from its edges");
    insertSplit(k, t, song);
    if (song) toast(`Split at ${tcAt(blocks[segs[k].block], t, fps)} for ${song === "__new" ? "a new song" : name(song)}`);
  }

  /** Drag split `k` along the timeline, between the parts either side of it. */
  const dragged = useRef(false);
  function dragSplit(k: number, e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget.parentElement!.getBoundingClientRect();
    const lo = segs[k - 1].start + 1, hi = endOf(k) - 1;
    let t = segs[k].start;
    const move = (ev: PointerEvent) => {
      dragged.current = true;
      t = Math.min(hi, Math.max(lo, ((ev.clientX - track.left) / track.width) * dur));
      setSegs((cur) => cur.map((g, j) => (j === k ? { ...g, start: t } : g)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragged.current) seekTo(t);
      setTimeout(() => { dragged.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function moveSplit(k: number, t: number | null) {
    if (t === null) return toast("That TC isn't inside this block");
    const lo = segs[k - 1].start + 1, hi = endOf(k) - 1;
    if (t <= lo || t >= hi) return toast("A split has to sit between the parts around it");
    setSegs((cur) => cur.map((g, j) => (j === k ? { ...g, start: t } : g)));
  }

  const removeSplit = (k: number) => setSegs((cur) => cur.filter((_, j) => j !== k));

  /** A song with no TC right after this segment's song in the running order: TC probably runs on into it. */
  function followOn(k: number): string | null {
    if (endOf(k) !== blocks[segs[k].block].file_end || !isSong(segs[k].song)) return null;
    const next = show.set_order[show.set_order.indexOf(segs[k].song) + 1];
    return next && !show.songs[next]?.fields.tc && !used.has(next) ? next : null;
  }

  function createAll() {
    update((s) => { for (const b of blocks) { const id = addSongWith(s, `Song ${b.tc_start.slice(0, 5)}`, b.tc_start); s.songs[id].segues_into_next = true; } });
    const matched = matchBlocks(useStore.getState().show!, blocks, fps);
    setSegs(blocks.map((b, i) => ({ block: i, start: b.file_start, song: matched[i] ?? "" })));
    toast(`Created ${blocks.length} songs. Rename them on the Songs page.`);
  }

  function confirm() {
    const marks: SongMark[] = [];
    update((s) => {
      segs.forEach((g, k) => {
        const tc = tcOf(k);
        let id = g.song;
        if (id === "__new") id = addSongWith(s, `New song ${tc.slice(0, 5)}`, tc);
        if (!id || id === "__skip" || !s.songs[id]) return;
        if (!s.songs[id].fields.tc) s.songs[id].fields.tc = tc;
        marks.push({ song_id: id, in: g.start, out: endOf(k), source: "auto_tc" });
      });
      if (isRecord) {
        setMarks(s, file.id, marks);
        const r = s.records?.find((x) => x.id === file.id);
        if (r) r.label = cleanLabel(label);
        if (r && tag) r.image_col = ensureCategory(s, tag);
      }
    });
    if (!isRecord) {
      toast(`Matched ${marks.length} songs to the show audio`);
      setView("songs");
      return;
    }
    // Songs that already have their clip (or thumbnail) from this record aren't made again.
    const todo = marksToMake(useStore.getState().show!, file.id, marks, makeClips);
    if (make !== "none" && todo.length) {
      const record = useStore.getState().show?.records?.find((x) => x.id === file.id);
      runClipJobs(bundle, { ...(file as SourceRecord), label: cleanLabel(label), image_col: record?.image_col, song_marks: marks }, todo, true, makeClips);
      onDone();
    } else {
      toast(make !== "none" && marks.length ? `Marked ${marks.length} songs. Every song already has its ${makeClips ? "clip" : "thumbnail"}.` : `Marked ${marks.length} songs`);
      setView("songs");
      if (marks[0]) focusSong(marks[0].song_id, "media");
    }
  }

  const first = (k: number) => k === 0 || segs[k - 1].block !== segs[k].block;
  const status = (k: number) => {
    const a = segs[k].song;
    if (a === "__skip") return <span className="chip">Skipped</span>;
    if (a === "__new") return <span className="chip accent">New song</span>;
    if (!a) return <span className="chip warn"><Icon name="alert" size="sm" />Unassigned</span>;
    if (!first(k)) return <span className="chip accent"><Icon name="scissors" size="sm" />Split</span>;
    return a === byTc[segs[k].block] ? <span className="chip ok"><Icon name="check" size="sm" />TC match</span> : <span className="chip accent">You picked</span>;
  };
  const colour = (i: number) => `hsl(${(i * 47 + 210) % 360} 70% 82%)`;
  const assignedCount = segs.filter((g) => isSong(g.song)).length;
  const toMake = isRecord
    ? marksToMake(show, file.id, segs.flatMap((g, k) => (isSong(g.song) ? [{ song_id: g.song, in: g.start, out: endOf(k), source: "auto_tc" as const }] : [])), makeClips).length
    : 0;

  return (
    <>
      <div className="result-banner">
        <div className="ic"><Icon name="radio" size="lg" /></div>
        <div style={{ flex: 1 }}><div className="t">Timecode found: {blocks.length} blocks</div><div className="d">{noSongs ? "No songs yet. Create them from the blocks." : `${byTc.filter(Boolean).length} matched by TC start. Check the rest.`}</div></div>
        <div className="chips">
          <span className="chip tc">LTC · ch {(ltc.channel ?? 0) + 1}</span><span className="chip">{fps} fps</span>
          {!noSongs && unmatched > 0 && <span className="chip warn">{unmatched} to check</span>}
          {!noSongs && missing.length > 0 && <span className="chip bad">{missing.length} not found</span>}
          <button className="sm" onClick={() => setShowPlayer(!showPlayer)}>{showPlayer ? "Hide player" : <><Icon name="play" size="sm" /> Play</>}</button>
        </div>
      </div>
      {noSongs && (
        <div className="panel" style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, borderColor: "var(--accent)" }}>
          <div style={{ flex: 1 }}><strong>Create songs from the TC map</strong><div className="muted small">One per block, TC filled in.</div></div>
          <button className="primary" onClick={createAll}>Create {blocks.length} songs</button>
        </div>
      )}
      {showPlayer && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <MediaPlayer path={file.path} video={isRecord} ltc={ltc.channel} channels={file.info?.audio_channels} mediaRef={player} />
          <div className="split-bar">
            {current >= 0
              ? <span className="small"><span className="mono" style={{ color: "var(--tc)" }}>{tcAt(blocks[segs[current].block], now, fps)}</span>
                  <span className="muted"> · in {isSong(segs[current].song) && segs[current].song !== "__new" ? name(segs[current].song) : `block ${segs[current].block + 1}`}</span></span>
              : <span className="muted small">Outside the timecode</span>}
            <span className="spacer" />
            <span className="muted small">Pause where the next section starts, then</span>
            <button className="sm" disabled={current < 0} onClick={() => splitHere()}><Icon name="scissors" size="sm" /> Split here</button>
            <select className="sm" value="" disabled={current < 0} onChange={(e) => e.target.value && splitHere(e.target.value)}>
              <option value="">Split here for…</option>
              {missing.length > 0 && <optgroup label="Not found">{missing.map((id) => <option key={id} value={id}>{name(id)}</option>)}</optgroup>}
              <optgroup label="All songs">
                <option value="__new">+ New song</option>
                {songIds.filter((id) => !missing.includes(id)).map((id) => <option key={id} value={id}>{name(id)}</option>)}
              </optgroup>
            </select>
          </div>
        </div>
      )}
      <div className="timeline">
        <div className="tl-track" onClick={(e) => { if (dragged.current) return; const r = e.currentTarget.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * dur); }}>
          {segs.map((g, k) => (
            <div key={k} className={`tl-seg ${isSong(g.song) ? "" : "hatch"}`} title={`${tcOf(k)}${isSong(g.song) && g.song !== "__new" ? ` · ${name(g.song)}` : ""}`}
                 style={{ left: `${(g.start / dur) * 100}%`, width: `${((endOf(k) - g.start) / dur) * 100}%`, background: colour(g.block) }}>
              <span className="tcl">{tcOf(k).slice(0, 5)}</span>
              <span className="l">{g.song === "__new" ? "New song" : isSong(g.song) ? name(g.song) : g.song === "__skip" ? "Skipped" : "Unassigned"}</span>
            </div>
          ))}
          {segs.map((g, k) => !first(k) && (
            <div key={`split-${k}`} className="tl-split" style={{ left: `${(g.start / dur) * 100}%` }} title={`Drag to move this split (${tcOf(k)})`}
                 onPointerDown={(e) => dragSplit(k, e)} onClick={(e) => e.stopPropagation()} />
          ))}
          {showPlayer && <div className="tl-head" style={{ left: `${(now / dur) * 100}%` }} />}
        </div>
        <div className="tl-scale">{[0, 0.2, 0.4, 0.6, 0.8, 1].map((x) => <span key={x}>{formatTime(dur * x)}</span>)}</div>
      </div>
      <div className="btable">
        <div className="tr th"><span>#</span><span>TC start</span><span>In file</span><span>Length</span><span>Song</span><span>Match</span><span /></div>
        {segs.map((g, k) => {
          const next = followOn(k);
          return (
            <div key={`${g.block}-${k}`}>
              <div className={`tr ${g.song ? "" : "unmatched"} ${first(k) ? "" : "split-row"} ${showPlayer && k === current ? "cur" : ""}`}
                   title="Go to this point in the player"
                   onClick={(e) => { if (!(e.target as HTMLElement).closest("button, select, input")) seekTo(g.start + 0.01); }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="sw" style={{ background: colour(g.block) }} /><span className="faint small">{first(k) ? g.block + 1 : "↳"}</span></span>
                {first(k)
                  ? <button className="link mono" style={{ color: "var(--tc)", fontSize: 12.5, justifyContent: "flex-start" }} title="Play from here" onClick={() => playAt(g.start)}><Icon name="play" size="sm" />{tcOf(k)}</button>
                  : <DraftInput mono className="tc-input" value={tcOf(k)} onCommit={(v) => moveSplit(k, timeAtTc(blocks[g.block], parseTc(v) ?? v, fps))} />}
                <span className="mono muted small">{formatTime(g.start)} – {formatTime(endOf(k))}</span>
                <span className="mono muted small">{formatTime(endOf(k) - g.start)}</span>
                <select value={g.song} onChange={(e) => pick(k, e.target.value)}>
                  <option value="">Choose a song…</option>
                  <option value="__new">+ New song</option>
                  <option value="__skip">Not a song (skip)</option>
                  {songIds.map((id) => <option key={id} value={id}>{show.set_order.includes(id) ? `${String(show.set_order.indexOf(id) + 1).padStart(2, "0")} · ` : ""}{name(id)}</option>)}
                </select>
                <span>{status(k)}</span>
                <span className="row-tools">
                  {!first(k) && showPlayer && <button className="icon" title="Move this split to the player position" onClick={() => moveSplit(k, player.current?.currentTime ?? null)}><Icon name="flag" size="sm" /></button>}
                  {!first(k)
                    ? <button className="icon" title="Remove this split" onClick={() => removeSplit(k)}><Icon name="x" size="sm" /></button>
                    : <button className="icon" title="Split this block (at the player position, or halfway)" onClick={() => split(g.block)}><Icon name="scissors" size="sm" /></button>}
                </span>
              </div>
              {next && (
                <div className="hint-row">
                  <span className="muted small">{name(next)} has no TC. If the timecode runs on into it, split this block.</span>
                  <button className="sm" onClick={() => split(g.block, next)}><Icon name="scissors" size="sm" /> Split for {name(next)}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!noSongs && missing.length > 0 && (
        <div className="missing-box"><Icon name="alert" /><div><strong style={{ fontWeight: 500 }}>Not found:</strong> {missing.map(name).join(", ")}<div className="muted small">No block starts at their TC. Pick them for a block, or play to where they start and use “Split here for…”.</div></div></div>
      )}
      {isRecord && (
        <>
          {!asked && (
            <>
              <div className="opts">
                <MakeChoice make={make} onMake={setMake} allowNone />
              </div>
              {makeClips && <ClipLabel value={label} onChange={setLabel} />}
              {wantsStills && <div style={{ marginTop: 16 }}><div className="label">Category</div><CategoryPicker value={tag} onChange={setTag} /></div>}
            </>
          )}
          <div className="note"><Icon name="clock" size="sm" />Cut on the decoded LTC frames, so the video's frame rate doesn't matter.</div>
        </>
      )}
      <div className="flow-foot">
        {isRecord && <button className="ghost" onClick={onManual}><Icon name="hand" /> Mark by hand instead</button>}
        <span className="spacer" />
        <button className="primary lg" onClick={confirm} disabled={!assignedCount || (isRecord && wantsStills && !tag)}>
          {isRecord ? (make === "none" ? `Mark ${assignedCount} songs` : toMake ? `Create ${toMake} ${makeClips ? "clip" : "thumbnail"}${toMake === 1 ? "" : "s"}` : `Mark ${assignedCount} songs`) : `Match ${assignedCount} songs`} <Icon name="arrowR" />
        </button>
      </div>
    </>
  );
}

function AssignStep({ paths, initialCategory }: { paths: string[]; initialCategory: string }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update, setView, setMediaTab, toast, endImport } = useStore.getState();
  const [rows, setRows] = useState(() => paths.map((p) => ({ path: p, songId: guessSong(show, p) ?? "" })));
  const [hero, setHero_] = useState(true);
  const [category, setCategory] = useState(() => initialCategory || renderCategory(show));
  const [busy, setBusy] = useState(false);
  const assigned = rows.filter((r) => r.songId);

  async function apply() {
    setBusy(true);
    try {
      const imported = await Promise.all(assigned.map(async (r) => ({ songId: r.songId, rel: await backend.importMedia(bundle, r.path, "renders") })));
      update((s) => { for (const { songId, rel } of imported) { addImages(s, songId, [rel], ensureCategory(s, category)); if (hero) setHero(s, songId, rel); } });
      toast(`Added ${imported.length} image${imported.length === 1 ? "" : "s"}`);
      endImport();
      setView("songs");
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function linkFolder() {
    const folder = paths[0].split("/").slice(0, -1).join("/");
    linkWatchFolder(folder, { image_col: category });
    endImport();
    setMediaTab("inbox");
    setView("media");
    toast("Folder linked to the render inbox");
  }

  return (
    <>
      <FileCard paths={paths} />
      <div className="section-head"><h2>Pick a song for each</h2><button className="sm" onClick={linkFolder}><Icon name="folder" size="sm" /> Send the whole folder to the inbox</button></div>
      <div className="assign-rows">
        {rows.map((r, i) => (
          <div key={r.path} className="assign-row">
            <img src={backend.fileUrl(r.path)} alt="" />
            <span className="nm">{fileName(r.path)}</span>
            <SongPicker value={r.songId} placeholder="Skip" options={[{ id: "", label: "Skip" }]}
                        onChange={(id) => setRows((all) => all.map((x, j) => (j === i ? { ...x, songId: id } : x)))}
                        onNew={(name) => { let id = ""; update((s) => { id = addSong(s, "set_order", undefined, name); }); toast(`${name} added to the set`); return id; }} />
            <button className="icon" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="x" size="sm" /></button>
          </div>
        ))}
      </div>
      <div className="assign-cat">
        <span className="field-label">Category</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories(show).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.column} column)</option>)}
        </select>
      </div>
      <div className="flow-foot">
        <label className="check hint"><input type="checkbox" checked={hero} onChange={() => setHero_(!hero)} /> Make it the song's main image</label>
        <button className="primary lg" disabled={!assigned.length || busy} onClick={apply}>{busy ? "Adding…" : `Add ${assigned.length} image${assigned.length === 1 ? "" : "s"}`} <Icon name="arrowR" /></button>
      </div>
    </>
  );
}

/** `thumbs`: picking thumbnails (now, or until the last was picked) rather than making clips. */
function DoneStep({ thumbs }: { thumbs: boolean }) {
  const jobs = useStore((s) => s.jobs);
  const picks = useStore((s) => s.stillPicks);
  const bundle = useStore((s) => s.bundle)!;
  const { setView, toast } = useStore.getState();
  const [fromMedia] = useState(() => useStore.getState().pickFocus !== null); // a still clicked on the Media page
  const finished = jobs.every((j) => j.status === "done" || j.status === "error");
  const failed = jobs.filter((j) => j.status === "error");
  // Picking one still from the Media page: back there once it's done.
  useEffect(() => {
    if (fromMedia && thumbs && !picks.length) { toast("Thumbnail updated"); setView("media"); }
  }, [fromMedia, thumbs, picks.length, toast, setView]);
  if (!thumbs && !jobs.length) return <div className="placeholder"><h3>Nothing to do</h3><div style={{ marginTop: 14 }}><button onClick={() => setView("songs")}>Back to songs</button></div></div>;
  const waiting = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  return (
    <>
      {thumbs ? (
        <>
          <StillPicker />
          {!picks.length && (
            <div className="placeholder">
              {finished ? <><div className="ic"><Icon name="check" size="lg" /></div><h3>Every song has its thumbnail</h3></>
                : <><div className="spinner" style={{ margin: "0 auto 12px" }} /><h3>Finding each song's best frames</h3><p>{waiting} to go</p></>}
            </div>
          )}
        </>
      ) : (
        <div className="done-list">
          {jobs.map((j, i) => (
            <div key={j.id} className="done-row" title={j.error}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <span style={{ fontWeight: 500 }}>{j.label}</span>
              <div className="progress"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
              <span>{j.status === "done" ? <span className="chip ok"><Icon name="check" size="sm" />Done</span>
                : j.status === "error" ? <span className="chip bad">Failed</span>
                : j.status === "running" ? <span className="chip">Working</span> : <span className="chip">Queued</span>}</span>
            </div>
          ))}
        </div>
      )}
      {failed.length > 0 && <p className="error">{failed[0].error}</p>}
      <div className="flow-foot">
        <span className="hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {thumbs ? (picks.length && waiting ? <><div className="spinner" />{waiting} more song{waiting === 1 ? "" : "s"} on the way</> : "")
            : finished ? "Added to each song, with its best frame as the thumbnail." : <><div className="spinner" />Runs in the background.</>}
        </span>
        {thumbs && picks.some((p) => p.candidates.length) && <button onClick={() => pickTopStills(bundle)} disabled={picks.every((p) => p.saving)}>Keep the top pick for the rest</button>}
        {!thumbs && <button onClick={() => setView("media")}>Add more media</button>}
        <button className="primary" onClick={() => setView("songs")}>Back to songs <Icon name="arrowR" /></button>
      </div>
    </>
  );
}

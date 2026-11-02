// Add both or replace: asked when media is added to songs that already have some of its kind (videos in the same
// category, or audio), with what each song has now beside what's coming.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { backend } from "../backend";
import { categories, clipCategory, fileName, GENERAL, inBundle, songAudio, songRecords } from "../model/ops";
import type { MediaInfo, Show, SongMark, SourceRecord } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";
import { formatTime } from "./SongDrawer";

/**
 * A video or audio file in the dialog, played in place on a click. A video shows its still, else its frame at `at`
 * (seconds), and plays from there.
 */
type Pic = { key: string; label: string; detail: string; src: string; at: number; still?: string; audio?: boolean };
type Row = { songId: string; name: string; now: Pic[]; next: Pic[] };
/** `place`: where the media is (" in General"), for audio nothing. */
type Ask = { audio: boolean; place: string; nowLabel: string; newLabel: string; note: string; rows: Row[]; done: (replace: string[] | null) => void };

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

const middle = (from: number, to: number) => from + Math.min(5, Math.max(0, to - from) / 2); // a frame a little way in
const VIDEO_NOTE = "Replaced clips move to the bin. Your own video files stay where they are.";

/** A song's videos in a category (its clips, but those cut from `except`, and its own videos). */
function videosNow(show: Show, bundle: string, songId: string, category: string, except?: string): Pic[] {
  const recordName = (id: string) => { const r = show.records?.find((x) => x.id === id); return r ? r.label || r.name : ""; };
  return [
    ...(show.songs[songId]?.clips ?? []).filter((c) => c.record_id !== except && clipCategory(show, c) === category).map((c) => ({
      key: c.path, label: recordName(c.record_id) || fileName(c.path), detail: `${formatTime(c.in)} – ${formatTime(c.out)}`,
      src: backend.mediaUrl(bundle, c.path), at: middle(0, c.out - c.in), still: c.still && backend.mediaUrl(bundle, c.still),
    })),
    ...songRecords(show, songId).filter((r) => (r.image_col ?? GENERAL) === category).map((r) => ({
      key: r.id, label: r.label || r.name, detail: r.info?.duration ? `The song's own video · ${formatTime(r.info.duration)}` : "The song's own video",
      src: backend.streamUrl(r.path), at: middle(0, r.info?.duration ?? 0),
    })),
  ];
}

/** Put the question up; it resolves to the songs to replace in, [] to add both, or null when cancelled. */
function ask(question: Omit<Ask, "done">): Promise<string[] | null> {
  if (!question.rows.length) return Promise.resolve([]);
  return new Promise((resolve) => useAsk.setState({ ask: { ...question, done: (replace) => { useAsk.setState({ ask: null }); resolve(replace); } } }));
}

const categoryName = (show: Show, id: string) => categories(show).find((c) => c.id === id)?.name ?? "this category";

/**
 * Ask whether the songs about to get clips from `record` should lose the videos they already have in its category
 * (clips from other records, or their own videos). Resolves to the songs to replace them in ([] to add both, or when
 * none has any), or null when cancelled. Re-cuts from the same record don't count.
 */
export function askToReplace(record: SourceRecord, marks: SongMark[]): Promise<string[] | null> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) return Promise.resolve([]);
  const category = record.image_col ?? GENERAL;
  const rows: Row[] = [];
  for (const m of marks) {
    const song = show.songs[m.song_id];
    if (!song || rows.some((r) => r.songId === m.song_id)) continue;
    const now = videosNow(show, bundle, m.song_id, category, record.id);
    if (!now.length) continue;
    const next = { key: "new", label: record.label || record.name, detail: `${formatTime(m.in)} – ${formatTime(m.out)}`, src: backend.streamUrl(record.path), at: middle(m.in, m.out) };
    rows.push({ songId: m.song_id, name: song.fields.name || "Untitled", now, next: [next] });
  }
  const cat = categoryName(show, category);
  return ask({ audio: false, place: ` in ${cat}`, nowLabel: `In ${cat} now`, newLabel: "New clip", note: VIDEO_NOTE, rows });
}

type NewFile = { path: string; info?: MediaInfo };

/** Ask whether a song's videos in `category` make way for these new ones: true to replace, false to add both, null when cancelled. */
export async function askToReplaceVideos(songId: string, category: string, files: NewFile[]): Promise<boolean | null> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle || !show.songs[songId]) return false;
  const now = videosNow(show, bundle, songId, category);
  const next = files.map((f) => ({ key: f.path, label: fileName(f.path), detail: f.info?.duration ? formatTime(f.info.duration) : "Linked as it is", src: backend.streamUrl(f.path), at: middle(0, f.info?.duration ?? 0) }));
  const cat = categoryName(show, category);
  const rows = now.length ? [{ songId, name: show.songs[songId].fields.name || "Untitled", now, next }] : [];
  const answer = await ask({ audio: false, place: ` in ${cat}`, nowLabel: `In ${cat} now`, newLabel: files.length === 1 ? "New video" : "New videos", note: VIDEO_NOTE, rows });
  return answer && answer.length > 0;
}

/** Ask whether a song's audio makes way for these new files: true to replace, false to add both, null when cancelled. */
export async function askToReplaceAudio(songId: string, files: (NewFile & { version: string })[]): Promise<boolean | null> {
  const { show, bundle } = useStore.getState();
  if (!show?.songs[songId] || !bundle) return false;
  const pic = (key: string, version: string, path: string, info?: MediaInfo) => ({
    key, label: version ? `Audio ${version}` : "Audio", detail: [fileName(path), info?.duration && formatTime(info.duration)].filter(Boolean).join(" · "),
    src: backend.streamUrl(path), at: 0, audio: true,
  });
  const now = songAudio(show, songId).map((a) => pic(a.id, a.version, inBundle(bundle, a.path), a.info));
  const next = files.map((f) => pic(f.path, f.version, f.path, f.info));
  const rows = now.length ? [{ songId, name: show.songs[songId].fields.name || "Untitled", now, next }] : [];
  const answer = await ask({ audio: true, place: "", nowLabel: "Audio now", newLabel: "New audio", note: "Replaced audio comes off the song, and its copy in the show moves to the bin.", rows });
  return answer && answer.length > 0;
}

/** A video's still (or frame), playing in place once clicked, or an audio file's player. `gone`: it's being replaced. */
function Thumb({ pic, gone }: { pic: Pic; gone?: boolean }) {
  const [playing, setPlaying] = useState(false);
  if (pic.audio) return (
    <div className={`replace-pic ${gone ? "gone" : ""}`}>
      <div className="replace-audio">
        <span className="ic"><Icon name="music" /></span>
        <div className="replace-audio-text"><strong title={pic.label}>{pic.label}</strong><span className="muted small" title={pic.detail}>{pic.detail}</span></div>
        {gone && <span className="pill">Replaced</span>}
      </div>
      <audio src={pic.src} controls preload="none" />
    </div>
  );
  return (
    <div className={`replace-pic ${gone ? "gone" : ""}`}>
      <div className="clip-pic" title={playing ? "" : "Play it here"} onClick={() => setPlaying(true)}>
        {playing ? <video src={pic.src} autoPlay controls playsInline onLoadedMetadata={(e) => { e.currentTarget.currentTime = pic.at; }} />
          : pic.still ? <img src={pic.still} alt="" />
          : <video src={`${pic.src}#t=${pic.at}`} preload="auto" muted playsInline />}
        {!playing && <span className="clip-play"><Icon name="play" size="sm" /></span>}
        {gone && !playing && <span className="pill">Replaced</span>}
      </div>
      <strong title={pic.label}>{pic.label}</strong>
      <span className="muted small">{pic.detail}</span>
    </div>
  );
}

/** The dialog, while there's something to ask. */
export function ReplaceDialog() {
  const ask = useAsk((s) => s.ask);
  // Songs whose videos are replaced (with several songs, each is picked; all to start with).
  const [replacing, setReplacing] = useState<Set<string>>(new Set());
  useEffect(() => { setReplacing(new Set(ask?.rows.map((r) => r.songId))); }, [ask]);
  useEffect(() => {
    if (!ask) return;
    // Keys stay in the dialog: the marking screen's shortcuts would otherwise play and mark behind it.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") ask.done(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ask]);
  if (!ask) return null;
  const { rows, place, nowLabel, newLabel, note, done } = ask;
  const many = rows.length > 1;
  const pick = (id: string, on: boolean) => setReplacing((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  const all = (on: boolean) => setReplacing(on ? new Set(rows.map((r) => r.songId)) : new Set());
  const noun = ask.audio ? "audio" : "video";
  const has = (n: number) => (ask.audio ? (n === 1 ? "audio" : `${n} audio versions`) : n === 1 ? "a video" : `${n} videos`);
  const kept = rows.length - replacing.size;
  const summary = [replacing.size && `Replacing ${replacing.size}`, kept && `adding both to ${kept}`].filter(Boolean).join(" · ");
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="modal replace-dialog" role="dialog" aria-label="Add both or replace">
        <header className="modal-head">
          <div>
            <h3>{many ? `Replace their ${noun}, or add both?` : `Replace the ${noun} in ${rows[0].name}, or add both?`}</h3>
            <p>{many ? `${rows.length} songs already have ${has(1)}${place}.` : `It already has ${has(rows[0].now.length)}${place}.`} {note}</p>
          </div>
        </header>
        <div className="modal-body replace-rows">
          {many && (
            <div className="replace-all">
              <button className="link" onClick={() => all(true)}>Replace all</button>
              <button className="link" onClick={() => all(false)}>Add both for all</button>
            </div>
          )}
          {rows.map((r) => {
            const going = many && replacing.has(r.songId);
            return (
              <div key={r.songId} className="replace-row">
                {many && (
                  <div className="replace-row-head">
                    <strong>{r.name}</strong>
                    <div className="seg">
                      <button className={going ? "" : "on"} onClick={() => pick(r.songId, false)}>Add both</button>
                      <button className={going ? "on" : ""} onClick={() => pick(r.songId, true)}>Replace</button>
                    </div>
                  </div>
                )}
                <div className="replace-pair">
                  <div className="replace-side">
                    <div className="label">{nowLabel}</div>
                    {r.now.map((p) => <Thumb key={p.key} pic={p} gone={going} />)}
                  </div>
                  <span className="replace-arrow" title={!many ? "" : going ? "Replaced by the new one" : "Both stay"}><Icon name={many && !going ? "plus" : "arrowR"} /></span>
                  <div className="replace-side">
                    <div className="label">{newLabel}</div>
                    {r.next.map((p) => <Thumb key={p.key} pic={p} />)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <footer className="modal-foot">
          {many ? (
            <>
              <span className="hint">{summary}</span>
              <button className="ghost" onClick={() => done(null)}>Cancel</button>
              <button className="primary" onClick={() => done([...replacing])}>Make the clips</button>
            </>
          ) : (
            <>
              <button className="ghost" onClick={() => done(null)}>Cancel</button>
              <button onClick={() => done([])}>Add both</button>
              <button className="primary" onClick={() => done([rows[0].songId])}>Replace</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

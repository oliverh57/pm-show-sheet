// Right-hand workspace for the selected song (or the show itself): everything you can add to it.
import { useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import {
  formatDuration, listOf, removeAudio, removeRecord, removeWatchFolder, setField, showAudio, showRecords,
  songAudio, songRecords, syncAudioField,
} from "../model/ops";
import type { AudioFile, MediaInfo, SourceRecord } from "../model/types";
import { SHOW_ID, useStore, type MediaType } from "../store";
import { DraftInput } from "./fields";
import { Colours, Media, Notes, Overview } from "./SongSections";

const SECTIONS = [
  { id: "renders", label: "Renders" },
  { id: "audio", label: "Audio" },
  { id: "records", label: "Records" },
  { id: "colours", label: "Colours" },
  { id: "details", label: "Details" },
  { id: "notes", label: "Notes" },
];

export function SongWorkspace() {
  const show = useStore((s) => s.show)!;
  const songId = useStore((s) => s.selectedSongId);
  const focus = useStore((s) => s.focusSection);
  const update = useStore((s) => s.update);
  const openAddMedia = useStore((s) => s.openAddMedia);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) bodyRef.current?.querySelector(`#sec-${focus.section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 }); // scrollTo may return a Promise: never return it from an effect
  }, [songId]);

  if (!songId || songId === SHOW_ID) return <ShowWorkspace />;
  const song = show.songs[songId];
  if (!song) return <div className="ws ws-empty muted">Select a song</div>;

  const add = (type: MediaType) => openAddMedia({ type, songId });
  const jump = (id: string) => bodyRef.current?.querySelector(`#sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <section className="ws" data-song-id={song.id}>
      <header className="ws-head">
        <div className="ws-title">
          <DraftInput className="ws-num" value={song.fields.num ?? ""} placeholder="#" onCommit={(v) => update((s) => setField(s, song.id, "num", v))} />
          <DraftInput className="ws-name" value={song.fields.name ?? ""} placeholder="Song name" onCommit={(v) => update((s) => setField(s, song.id, "name", v))} />
          {listOf(show, song.id) === "archive" && <span className="pill">ARCHIVED</span>}
        </div>
        <div className="ws-actions">
          <button className="big" onClick={() => add("renders")}>+ Renders</button>
          <button className="big" onClick={() => add("song_audio")}>+ Audio</button>
          <button className="big" onClick={() => add("song_record")}>+ Song record</button>
        </div>
        <nav className="ws-nav">{SECTIONS.map((s) => <button key={s.id} onClick={() => jump(s.id)}>{s.label}</button>)}</nav>
      </header>
      <div className="ws-body" ref={bodyRef}>
        <Section id="renders" title="RENDERS"><Media song={song} /></Section>
        <Section id="audio" title="AUDIO" action={<button onClick={() => add("song_audio")}>+ Add version</button>}>
          <AudioList files={songAudio(show, song.id)} empty="No audio for this song yet. Add a version to track what's current."
                     onRemove={(id) => update((s) => { removeAudio(s, id); syncAudioField(s, song.id); })} />
          {showAudio(show)[0] && <p className="muted small">Also in the show audio: {showAudio(show)[0].name} ({showAudio(show)[0].version})</p>}
        </Section>
        <Section id="records" title="RECORDS" action={<button onClick={() => add("song_record")}>+ Add record</button>}>
          <RecordList records={songRecords(show, song.id)} empty="No recordings of this song yet." onRemove={(id) => update((s) => removeRecord(s, id))} />
        </Section>
        <Section id="colours" title="COLOURS"><Colours song={song} /></Section>
        <Section id="details" title="DETAILS"><Overview show={show} song={song} /></Section>
        <Section id="notes" title="NOTES"><Notes show={show} song={song} /></Section>
      </div>
    </section>
  );
}

function ShowWorkspace() {
  const show = useStore((s) => s.show)!;
  const update = useStore((s) => s.update);
  const openAddMedia = useStore((s) => s.openAddMedia);
  const setView = useStore((s) => s.setView);
  const folders = show.watch_folders ?? [];

  return (
    <section className="ws" data-show-drop>
      <header className="ws-head">
        <div className="ws-title"><span className="ws-name static">SHOW MEDIA</span></div>
        <div className="ws-actions">
          <button className="big" onClick={() => openAddMedia({ type: "show_record" })}>+ Show record</button>
          <button className="big" onClick={() => openAddMedia({ type: "show_audio" })}>+ Show audio</button>
          <button className="big" onClick={() => openAddMedia({ type: "watch_folder" })}>+ Watch folder</button>
        </div>
      </header>
      <div className="ws-body">
        <Section id="show-records" title="SHOW RECORDS" action={<button onClick={() => openAddMedia({ type: "show_record" })}>+ Add record</button>}>
          <RecordList records={showRecords(show)} empty="No whole-show recordings yet (wide, multicam, content or LTC records)."
                      onRemove={(id) => update((s) => removeRecord(s, id))} />
        </Section>
        <Section id="show-audio" title="SHOW AUDIO" action={<button onClick={() => openAddMedia({ type: "show_audio" })}>+ Add version</button>}>
          <AudioList files={showAudio(show)} empty="No whole-show playback audio yet." onRemove={(id) => update((s) => removeAudio(s, id))} />
        </Section>
        <Section id="watch" title="RENDER WATCH FOLDERS" action={<button onClick={() => setView("inbox")}>Open render inbox</button>}>
          {folders.length === 0 && <p className="muted">Add the folder Depence exports into; new renders show up in the render inbox to approve.</p>}
          {folders.map((f) => (
            <div key={f.id} className="media-row">
              <div className="media-main"><strong>{f.label}</strong><span className="muted small path">{f.path}</span></div>
              <button className="icon" onClick={() => update((s) => removeWatchFolder(s, f.id))} title="Stop watching">×</button>
            </div>
          ))}
        </Section>
      </div>
    </section>
  );
}

function Section({ id, title, action, children }: { id: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="ws-section" id={`sec-${id}`}>
      <div className="ws-section-head"><h3>{title}</h3>{action}</div>
      {children}
    </section>
  );
}

export function infoLine(info?: MediaInfo): string {
  if (!info?.available) return "";
  const parts = [
    formatDuration(info.duration),
    info.width && info.height ? `${info.width}×${info.height}` : "",
    info.fps ? `${info.fps} fps` : "",
    info.audio_channels ? `${info.audio_channels} ch` : "",
    info.sample_rate ? `${info.sample_rate / 1000} kHz` : "",
    info.timecode_track ? `TC track ${info.timecode_track}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function AudioList({ files, empty, onRemove }: { files: AudioFile[]; empty: string; onRemove: (id: string) => void }) {
  const [playing, setPlaying] = useState<string | null>(null);
  if (files.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="media-list">
      {files.map((a, i) => (
        <div key={a.id} className="media-row">
          <span className={`version ${i === 0 ? "current" : ""}`}>{a.version || "—"}</span>
          <div className="media-main">
            <strong>{a.name}{i === 0 && <span className="pill">CURRENT</span>}</strong>
            <span className="muted small">{infoLine(a.info)}{a.note ? ` · ${a.note}` : ""} · added {new Date(a.added_at).toLocaleDateString()}</span>
            {playing === a.id && <audio controls autoPlay src={backend.fileUrl(a.path)} />}
          </div>
          <button onClick={() => setPlaying(playing === a.id ? null : a.id)}>{playing === a.id ? "Hide" : "▶ Play"}</button>
          <button className="icon" onClick={() => onRemove(a.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}

function RecordList({ records, empty, onRemove }: { records: SourceRecord[]; empty: string; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (records.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="media-list">
      {records.map((r) => (
        <div key={r.id} className="media-row record">
          <div className="media-main">
            <strong>{r.name}</strong>
            <span className="muted small">{infoLine(r.info) || "details unavailable"}{r.note ? ` · ${r.note}` : ""}</span>
            {open === r.id && <video controls preload="metadata" src={backend.fileUrl(r.path)} />}
          </div>
          <button onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "▶ Watch"}</button>
          <button className="icon" onClick={() => onRemove(r.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}


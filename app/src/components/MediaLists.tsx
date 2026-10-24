// Lists of audio versions and recordings, with in-place players.
import { useState } from "react";
import { formatDuration } from "../model/ops";
import type { AudioFile, MediaInfo, SourceRecord } from "../model/types";
import { Icon } from "./icons";
import { MediaPlayer } from "./Player";
import { SaveCopy } from "./SaveCopy";

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

export function AudioList({ files, empty, onRemove }: { files: AudioFile[]; empty: string; onRemove: (id: string) => void }) {
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
            {playing === a.id && <MediaPlayer path={a.path} video={false} ltc={a.ltc?.channel} channels={a.info?.audio_channels} autoPlay />}
          </div>
          <SaveCopy path={a.path} ltc={a.ltc?.channel} />
          <button className="sm" onClick={() => setPlaying(playing === a.id ? null : a.id)}>{playing === a.id ? "Hide" : <><Icon name="play" size="sm" /> Play</>}</button>
          <button className="icon" onClick={() => onRemove(a.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}

export function RecordList({ records, empty, onRemove }: { records: SourceRecord[]; empty: string; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (records.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="media-list">
      {records.map((r) => (
        <div key={r.id} className="media-row record">
          <div className="media-main">
            <strong>{r.name}</strong>
            <span className="muted small">{infoLine(r.info) || "details unavailable"}{r.note ? ` · ${r.note}` : ""}</span>
            {open === r.id && <MediaPlayer path={r.path} video ltc={r.ltc?.channel} channels={r.info?.audio_channels} autoPlay />}
          </div>
          <SaveCopy path={r.path} ltc={r.ltc?.channel} video />
          <button className="sm" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : <><Icon name="play" size="sm" /> Watch</>}</button>
          <button className="icon" onClick={() => onRemove(r.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}


// Lists of audio versions and recordings. Both play in the media viewer.
import { formatDuration } from "../model/ops";
import type { AudioFile, MediaInfo, SourceRecord } from "../model/types";
import { Icon } from "./icons";
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

export function AudioList({ files, empty, onPlay, onRemove }: { files: AudioFile[]; empty: string; onPlay: (id: string) => void; onRemove: (id: string) => void }) {
  if (files.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="media-list">
      {files.map((a, i) => (
        <div key={a.id} className="media-row">
          <span className={`version ${i === 0 ? "current" : ""}`}>{a.version || "—"}</span>
          <div className="media-main">
            <strong>{a.name}{i === 0 && <span className="pill">CURRENT</span>}</strong>
            <span className="muted small">{infoLine(a.info)}{a.note ? ` · ${a.note}` : ""} · added {new Date(a.added_at).toLocaleDateString()}</span>
          </div>
          <SaveCopy path={a.path} ltc={a.ltc?.channel} />
          <button className="sm" title="Play it full screen" onClick={() => onPlay(a.id)}><Icon name="play" size="sm" /> Play</button>
          <button className="icon" onClick={() => onRemove(a.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}

export function RecordList({ records, empty, onWatch, onRemove }: { records: SourceRecord[]; empty: string; onWatch: (id: string) => void; onRemove: (id: string) => void }) {
  if (records.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="media-list">
      {records.map((r) => (
        <div key={r.id} className="media-row record">
          <div className="media-main">
            <strong>{r.name}</strong>
            <span className="muted small">{infoLine(r.info) || "details unavailable"}{r.note ? ` · ${r.note}` : ""}</span>
          </div>
          <SaveCopy path={r.path} ltc={r.ltc?.channel} video />
          <button className="sm" title="Watch it full screen, with its comments beside it" onClick={() => onWatch(r.id)}><Icon name="play" size="sm" /> Watch</button>
          <button className="icon" onClick={() => onRemove(r.id)} title="Remove (the file stays where it is)">×</button>
        </div>
      ))}
    </div>
  );
}


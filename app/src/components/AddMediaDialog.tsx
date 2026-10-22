// Add media: pick what you're adding, choose (or drop) files, say which song and which version.
import { useEffect, useRef, useState } from "react";
import { backend, type FileKind } from "../backend";
import {
  addAudio, addImages, addRecord, addWatchFolder, fileName, guessSong, guessVersion, setHero, syncAudioField,
} from "../model/ops";
import type { MediaInfo, Show } from "../model/types";
import { SHOW_ID, useStore, type MediaType } from "../store";
import { infoLine } from "./SongWorkspace";

interface TypeDef {
  id: MediaType;
  title: string;
  desc: string;
  glyph: string;
  kind: FileKind | "folder";
  perSong: boolean;
  versioned: boolean;
}

export const MEDIA_TYPES: TypeDef[] = [
  { id: "show_record", title: "Show record", desc: "Whole-show video: wide, multicam, content or LTC record. Linked, not copied.", glyph: "▶▶", kind: "video", perSong: false, versioned: false },
  { id: "song_record", title: "Song record", desc: "A recording of one song. Linked, not copied.", glyph: "▶", kind: "video", perSong: true, versioned: false },
  { id: "show_audio", title: "Show audio", desc: "Continuous playback for the whole show (with or without LTC).", glyph: "♫♫", kind: "audio", perSong: false, versioned: true },
  { id: "song_audio", title: "Song audio", desc: "A new audio version for a song. Becomes its current version.", glyph: "♫", kind: "audio", perSong: true, versioned: true },
  { id: "renders", title: "Renders", desc: "Stills for a song. Copied into the show.", glyph: "▣", kind: "image", perSong: true, versioned: false },
  { id: "watch_folder", title: "Watch folder", desc: "A Depence export folder. New renders appear in the render inbox to approve.", glyph: "⌂", kind: "folder", perSong: false, versioned: false },
];

interface Row {
  path: string;
  songId: string;
  version: string;
  info?: MediaInfo;
}

function defaultSong(show: Show, path: string, preset?: string | null): string {
  return guessSong(show, path) ?? (preset && preset !== SHOW_ID ? preset : "");
}

export function AddMediaDialog() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const preset = useStore((s) => s.addMedia)!;
  const selected = useStore((s) => s.selectedSongId);
  const close = useStore((s) => s.closeAddMedia);
  const update = useStore((s) => s.update);
  const focusSong = useStore((s) => s.focusSong);
  const setView = useStore((s) => s.setView);

  const [type, setType] = useState<TypeDef | null>(MEDIA_TYPES.find((t) => t.id === preset.type) ?? null);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [makeHero, setMakeHero] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetSong = preset.songId ?? selected;
  const probing = useRef(new Set<string>());

  function setFiles(paths: string[]) {
    setRows(paths.map((p) => ({ path: p, songId: defaultSong(show, p, presetSong), version: guessVersion(p) })));
  }

  useEffect(() => {
    if (preset.files?.length) setFiles(preset.files);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Read duration / format details for video and audio as soon as files are chosen.
  useEffect(() => {
    if (!type || (type.kind !== "video" && type.kind !== "audio")) return;
    for (const r of rows) {
      if (r.info || probing.current.has(r.path)) continue;
      probing.current.add(r.path);
      backend.probe(r.path).then((info) => setRows((cur) => cur.map((x) => (x.path === r.path ? { ...x, info } : x))));
    }
  }, [rows, type]);

  async function choose() {
    if (!type) return;
    if (type.kind === "folder") {
      const folder = await backend.chooseFolder("Choose the folder Depence exports renders into");
      if (folder) setFiles([folder]);
    } else {
      const paths = await backend.chooseFiles(type.kind, true);
      if (paths.length) setFiles([...rows.map((r) => r.path), ...paths]);
    }
  }

  const missingSong = type?.perSong && rows.some((r) => !r.songId);
  const missingVersion = type?.versioned && rows.some((r) => !r.version.trim());

  async function apply() {
    if (!type || rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (type.id === "renders") {
        const imported = await Promise.all(rows.map(async (r) => ({ songId: r.songId, rel: await backend.importMedia(bundle, r.path, "renders") })));
        update((s) => {
          for (const { songId, rel } of imported) {
            addImages(s, songId, [rel]);
            if (makeHero) setHero(s, songId, rel);
          }
        });
        focusSong(imported[0].songId, "renders");
      } else if (type.id === "watch_folder") {
        update((s) => { for (const r of rows) addWatchFolder(s, r.path); });
        setView("inbox");
      } else {
        const infos = await Promise.all(rows.map((r) => r.info ?? backend.probe(r.path)));
        const scope = type.perSong ? "song" : "show";
        update((s) => {
          rows.forEach((r, i) => {
            const base = { path: r.path, scope, song_id: type.perSong ? r.songId : null, note: note || undefined, info: infos[i] } as const;
            if (type.kind === "audio") {
              addAudio(s, { ...base, version: r.version.trim() });
              if (type.perSong) syncAudioField(s, r.songId);
            } else {
              addRecord(s, base);
            }
          });
        });
        if (type.perSong) focusSong(rows[0].songId, type.kind === "audio" ? "audio" : "records");
        else focusSong(SHOW_ID);
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const songOptions = [...show.set_order, ...show.archive];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal add-media" role="dialog" aria-label="Add media">
        <header className="modal-head">
          <h2>{type ? <><button className="link" onClick={() => { setType(null); setRows([]); }}>Add media</button> / {type.title}</> : "Add media"}</h2>
          <button className="icon" onClick={close}>×</button>
        </header>

        {!type && (
          <div className="type-tiles">
            {MEDIA_TYPES.map((t) => (
              <button key={t.id} className="type-tile" onClick={() => setType(t)}>
                <span className="glyph">{t.glyph}</span>
                <span className="tile-title">{t.title}</span>
                <span className="muted small">{t.desc}</span>
              </button>
            ))}
          </div>
        )}

        {type && (
          <div className="stack">
            <p className="muted">{type.desc}</p>
            <div className="dropzone big">
              <span>{rows.length ? `${rows.length} ${type.kind === "folder" ? "folder" : "file"}${rows.length === 1 ? "" : "s"} chosen` : backend.isDesktop ? "Drop files from Finder anywhere on the window, or" : "Choosing files needs the desktop app"}</span>
              {backend.isDesktop && <button onClick={choose}>{type.kind === "folder" ? "Choose folder…" : rows.length ? "Add more…" : "Choose files…"}</button>}
            </div>

            {rows.length > 0 && (
              <div className="file-rows">
                {rows.map((r, i) => (
                  <div key={r.path} className="file-row">
                    <div className="media-main">
                      <strong>{fileName(r.path)}</strong>
                      <span className="muted small">{type.kind === "folder" ? r.path : infoLine(r.info) || (type.kind === "image" ? "" : "reading details…")}</span>
                    </div>
                    {type.perSong && (
                      <select value={r.songId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, songId: e.target.value } : x)))}>
                        <option value="">Choose song…</option>
                        {songOptions.map((id) => <option key={id} value={id}>{show.songs[id].fields.num ? `#${show.songs[id].fields.num} ` : ""}{show.songs[id].fields.name}</option>)}
                      </select>
                    )}
                    {type.versioned && (
                      <input className="version-input" placeholder="Version e.g. V3" value={r.version}
                             onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, version: e.target.value } : x)))} />
                    )}
                    <button className="icon" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}

            {(type.kind === "video" || type.kind === "audio") && (
              <input placeholder="Note (optional), e.g. Night 2 wide, MD's new edit" value={note} onChange={(e) => setNote(e.target.value)} />
            )}
            {type.id === "renders" && (
              <label className="check"><input type="checkbox" checked={makeHero} onChange={() => setMakeHero(!makeHero)} /> Make the new render the song's hero</label>
            )}
            {error && <p className="error">{error}</p>}
            <div className="modal-foot">
              {missingSong && <span className="muted small">Choose a song for every file</span>}
              {missingVersion && <span className="muted small">Give every audio file a version</span>}
              <button onClick={close}>Cancel</button>
              <button className="primary" disabled={busy || rows.length === 0 || missingSong || missingVersion} onClick={apply}>
                {busy ? "Adding…" : `Add ${type.title.toLowerCase()}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Guess what a set of dropped paths is, given whether they landed on a song. */
export function guessType(paths: string[], onSong: boolean): MediaType {
  const ext = (p: string) => (fileName(p).includes(".") ? fileName(p).split(".").pop()!.toLowerCase() : "");
  if (paths.every((p) => ext(p) === "")) return "watch_folder";
  const kinds = new Set(paths.map((p) => {
    const e = ext(p);
    return ["wav", "aif", "aiff", "mp3", "m4a", "flac", "aac"].includes(e) ? "audio" : ["mp4", "mov", "m4v", "mxf", "avi", "mkv"].includes(e) ? "video" : "image";
  }));
  if (kinds.has("audio")) return onSong ? "song_audio" : "show_audio";
  if (kinds.has("video")) return onSong ? "song_record" : "show_record";
  return "renders";
}

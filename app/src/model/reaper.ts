// A REAPER project of the running order: the songs one after another, a marker (and the song's BPM) at each one's
// start, and its media in a group of tracks per kind: the song's audio, then each category's records (General, Content,
// LX…). A group's LTC goes on a track of its own in it, out of the mix, to line the show's timecode up. Within a song
// its media is locked together by that timecode: each clip sits where its record's LTC says it plays against the song's
// TC, and media with no LTC starts with the song. The video is the
// songs' clips, which are always in the show's Google Drive folder: a show record can be on another Mac, or a cloud
// placeholder REAPER would hang on. Pure: the caller says which files are on this Mac, downloads the clips it's told
// to, and writes the text.
import { DEPT_COLOURS } from "../google/sheet";
import {
  categories, clipCategory, deptColour, GENERAL, clipLabel, clipLength, extension, ltcFromName, showAudio, songAudio, songNumber, tcSeconds,
} from "./ops";
import type { Clip, LtcResult, Show } from "./types";

/** How long a song with no media is on the timeline (seconds), so its marker doesn't land on the next one's. */
export const EMPTY_SONG = 30;
/** Media whose LTC is further than this (seconds) from the song's TC isn't the same timecode: it starts with the song. */
export const MAX_TC_GAP = 10 * 60;

export interface ReaperItem {
  position: number;
  length: number;
  offset: number; // seconds into the file
  file: string; // absolute
  name: string;
  chanmode: number; // REAPER's take channel mode: 0 as it is, 3 + n channel n alone (3 left, 4 right)
  video: boolean; // false: the file's sound only (an LTC track's copy of a video)
}

export interface ReaperTrack {
  name: string;
  items: ReaperItem[];
  folder?: "parent" | "last"; // a group: its first track holds the rest (other records of a song, the LTC)
  ltc?: boolean; // timecode: not sent to the mix, to be routed to an output
  colour: string; // "#RRGGBB": its group's (a category's is its department's band in the Sheet), the LTC's own
  grid?: boolean; // draws every video below it side by side
}

export interface ReaperSet {
  tracks: ReaperTrack[];
  markers: { position: number; name: string }[];
  tempo: { position: number; bpm: number }[];
  length: number;
  /** Clips (bundle-relative) the project uses that are only in Google Drive: download them before opening it. */
  download: string[];
  /** Audio files the project would use that aren't on this Mac (linked on another, or only in the cloud): left out. */
  missing: string[];
  /** Songs marked in a record with no clip cut from it: nothing of theirs from that record to put in. */
  uncut: number;
}

/**
 * Where one song's media comes from: stretches of a file, played one after another (a clip's stretches between the
 * pauses cut out of it), each with the show TC it starts at (seconds), where its LTC says.
 */
interface Source {
  file: string;
  name: string;
  pieces: { offset: number; length: number; tc: number | null }[];
  ltc: number | null; // the audio channel carrying LTC
}

/** The TC (seconds) at `t` seconds into a file, from its LTC; null where it has none. */
function tcAtTime(ltc: LtcResult | undefined, t: number): number | null {
  const fps = ltc?.fps ?? 25;
  const block = ltc?.blocks.find((b) => t >= b.file_start - 0.05 && t < b.file_end);
  const start = block ? tcSeconds(block.tc_start, fps) : null;
  return block && start !== null ? start + Math.max(0, t - block.file_start) : null;
}

/** A clip's stretches between the pauses cut out of it: where each is in the clip file, and the TC it starts at. */
function clipPieces(clip: Clip, ltc: LtcResult | undefined): Source["pieces"] {
  const out: Source["pieces"] = [];
  let from = clip.in, offset = 0;
  const stretch = (a: number, b: number) => {
    if (b <= a) return;
    out.push({ offset, length: b - a, tc: tcAtTime(ltc, a) });
    offset += b - a;
  };
  for (const [a, b] of [...(clip.cuts ?? [])].sort((x, y) => x[0] - y[0])) {
    stretch(from, a);
    from = Math.max(from, b);
  }
  stretch(from, clip.out);
  return out;
}

/**
 * Where each of a source's pieces starts, in seconds from the song's TC `zero`: at its TC when it has one near
 * enough, else straight after the piece before (or before the piece after); from 0 when none has.
 */
function lineUp(s: Source, zero: number | null): number[] {
  const at = s.pieces.map((p) => (p.tc !== null && zero !== null && Math.abs(p.tc - zero) <= MAX_TC_GAP ? p.tc - zero : null));
  const first = at.findIndex((x) => x !== null);
  const out = s.pieces.map(() => 0);
  if (first < 0) {
    for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + s.pieces[i - 1].length;
    return out;
  }
  out[first] = at[first]!;
  for (let i = first - 1; i >= 0; i--) out[i] = out[i + 1] - s.pieces[i].length;
  for (let i = first + 1; i < out.length; i++) out[i] = at[i] ?? out[i - 1] + s.pieces[i - 1].length;
  return out;
}

/** REAPER's channel mode that leaves out a file's LTC channel: the other side alone (0 when there's none). */
export const withoutLtc = (ltc: number | null) => (ltc === null ? 0 : ltc === 0 ? 4 : 3);
/** REAPER's channel mode that plays just the LTC channel. */
export const onlyLtc = (ltc: number) => 3 + ltc;

/** Track colours: the ones that aren't a department's. */
export const TRACK_COLOURS = { video: "#5A5A5A", audio: "#3FAE5A", ltc: "#B29DEF", general: "#E8C547", other: "#8C8C8C" };

/** A category's colour: its department's band in the Sheet (one too dark to tell apart in REAPER gets grey), General's own. */
function categoryColour(show: Show, id: string): string {
  if (id === GENERAL) return TRACK_COLOURS.general;
  const dept = show.columns.find((c) => c.id === id)?.dept;
  const hex = dept ? deptColour(show, dept) ?? DEPT_COLOURS[dept] : undefined;
  const [r, g, b] = hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [0, 0, 0];
  return hex && 0.299 * r + 0.587 * g + 0.114 * b > 60 ? hex.toUpperCase() : TRACK_COLOURS.other;
}

/** A category's name and colour in REAPER. */
function categoryName(show: Show, id: string): string {
  return categories(show).find((c) => c.id === id)?.name ?? show.columns.find((c) => c.id === id)?.label ?? id;
}

/** Categories in the show's order, then any others in `ids` (ones it no longer has). */
function inOrder(show: Show, ids: string[]): string[] {
  const known = categories(show).map((c) => c.id);
  return [...known.filter((id) => ids.includes(id)), ...ids.filter((id) => !known.includes(id))];
}

/** A clip track the export can include: a category with clips in the running order, and the records they're cut from. */
export interface ClipChoice {
  category: string;
  name: string;
  colour: string;
  records: { id: string; label: string; songs: string[] }[]; // newest first, as the tracks go; the songs with clips from it, in running order
}

/** The clip tracks the running order has, to choose from. */
export function reaperChoices(show: Show): ClipChoice[] {
  const records = show.records ?? [];
  const age = (id: string) => records.findIndex((r) => r.id === id);
  const found = new Map<string, Map<string, { label: string; songs: Set<string> }>>();
  for (const songId of show.set_order) {
    for (const clip of show.songs[songId]?.clips ?? []) {
      const category = clipCategory(show, clip);
      const byRecord = found.get(category) ?? new Map();
      found.set(category, byRecord);
      const r = byRecord.get(clip.record_id) ?? { label: clipLabel(show, clip), songs: new Set<string>() };
      byRecord.set(clip.record_id, r);
      r.songs.add(songId);
    }
  }
  return inOrder(show, [...found.keys()]).map((category) => ({
    category, name: categoryName(show, category), colour: categoryColour(show, category),
    records: [...found.get(category)!].sort((a, b) => age(b[0]) - age(a[0]))
      .map(([id, r]) => ({ id, label: r.label, songs: [...r.songs].map((songId) => show.songs[songId].fields.name || "Song") })),
  }));
}

/** Every file the project could use (absolute), to ask which are on this Mac. */
export function reaperFiles(show: Show, bundle: string): string[] {
  return [...new Set([
    ...(show.audio ?? []).map((a) => a.path),
    ...show.set_order.flatMap((id) => (show.songs[id]?.clips ?? []).map((c) => `${bundle}/${c.path}`)),
  ])];
}

/**
 * The running order (not the archive) as a REAPER project. Each song's clips go in their categories' groups, the
 * newest record's first. A song's audio is its own audio version (the one its AUDIO VERSION names, else the newest),
 * else its part of the show audio, from its TC to the next song's. The song's marker is at its TC (its TC field, else
 * the earliest of its media's), with anything that plays before that just ahead of it. `include` picks the records
 * whose clips go in (all of them unless given).
 */
export function reaperSet(show: Show, bundle: string, here: (path: string) => boolean, include: (recordId: string) => boolean = () => true): ReaperSet {
  const download = new Set<string>();
  const missing = new Set<string>();
  const records = show.records ?? [];
  let uncut = 0;
  const songTcs = show.set_order.map((id) => tcSeconds(show.songs[id]?.fields.tc ?? "")).filter((t): t is number => t !== null);

  function audioFor(songId: string): Source | null {
    const song = show.songs[songId];
    const own = songAudio(show, songId);
    const pick = own.find((a) => a.version && a.version === song.fields.audio) ?? own[0];
    if (pick && here(pick.path) && pick.info?.duration) {
      return { file: pick.path, name: pick.version || pick.name, pieces: [{ offset: 0, length: pick.info.duration, tc: tcAtTime(pick.ltc, 0) }], ltc: pick.ltc?.channel ?? null };
    }
    for (const a of showAudio(show)) {
      if (!a.ltc?.blocks.length || !here(a.path)) continue;
      const fps = a.ltc.fps ?? 25;
      const at = tcSeconds(song.fields.tc ?? "", fps);
      if (at === null) break;
      for (const b of a.ltc.blocks) {
        const t = b.file_start + at - (tcSeconds(b.tc_start, fps) ?? NaN);
        if (!(t >= b.file_start && t < b.file_end)) continue;
        const next = Math.min(...songTcs.filter((x) => x > at));
        const end = Math.min(b.file_end, t + next - at);
        return { file: a.path, name: a.version || a.name, pieces: [{ offset: t, length: end - t, tc: at }], ltc: a.ltc.channel };
      }
    }
    if (pick) missing.add(pick.name);
    return null;
  }

  function mediaFor(songId: string): { category: string; source: Source }[] {
    const song = show.songs[songId];
    // The newest record's clips first (it goes on the category's own track); clips whose record has gone last.
    const age = (id: string) => records.findIndex((r) => r.id === id);
    const clips = (song.clips ?? []).filter((c) => include(c.record_id)).sort((a, b) => age(b.record_id) - age(a.record_id));
    uncut += records.filter((r) => include(r.id) && r.song_marks?.some((m) => m.song_id === songId) && !clips.some((c) => c.record_id === r.id)).length;
    return clips.map((clip) => {
      const file = `${bundle}/${clip.path}`;
      if (!here(file)) download.add(clip.path);
      const record = records.find((r) => r.id === clip.record_id);
      // A clip from before its cuts were kept on it (or whose record's gone) is one piece, its length.
      const pieces = record ? clipPieces(clip, record.ltc) : [{ offset: 0, length: clipLength(clip), tc: null }];
      return { category: clipCategory(show, clip), source: { file, name: `${song.fields.name || "Song"} · ${clipLabel(show, clip)}`, pieces, ltc: ltcFromName(clip.path) } };
    });
  }

  // Each group's tracks: a lane per source a song has in it (the newest first), and their LTC.
  const AUDIO = "__audio";
  const groups = new Map<string, { lanes: ReaperItem[][]; ltc: ReaperItem[][] }>();
  const markers: ReaperSet["markers"] = [];
  const tempo: ReaperSet["tempo"] = [];
  const place = (group: string, lane: number, s: Source, starts: number[], origin: number) => {
    const g = groups.get(group) ?? { lanes: [], ltc: [] };
    groups.set(group, g);
    s.pieces.forEach((p, i) => {
      const item = { position: origin + starts[i], length: p.length, offset: p.offset, file: s.file, name: s.name };
      (g.lanes[lane] ??= []).push({ ...item, chanmode: withoutLtc(s.ltc), video: true });
      if (s.ltc !== null) (g.ltc[lane] ??= []).push({ ...item, name: `${s.name} · LTC`, chanmode: onlyLtc(s.ltc), video: false });
    });
  };

  let end = 0; // where the last song's media ends
  for (const id of show.set_order) {
    const song = show.songs[id];
    if (!song) continue;
    const a = audioFor(id);
    const media = mediaFor(id);
    const sources: [string, Source][] = [...(a ? [[AUDIO, a] as [string, Source]] : []), ...media.map((m): [string, Source] => [m.category, m.source])];
    // Line it all up on the song's TC; it starts where the earliest of it does.
    const zero = tcSeconds(song.fields.tc ?? "") ?? sources.flatMap(([, s]) => s.pieces.map((p) => p.tc)).reduce<number | null>((m, t) => (t === null ? m : m === null ? t : Math.min(m, t)), null);
    const starts = sources.map(([, s]) => lineUp(s, zero));
    const origin = end + Math.max(0, ...starts.flat().map((t) => -t));
    markers.push({ position: origin, name: `${songNumber(show, id)} ${song.fields.name || "Song"}` });
    const bpm = parseFloat(song.fields.bpm ?? "");
    if (bpm >= 20 && bpm <= 400) tempo.push({ position: origin, bpm });
    const used = new Map<string, number>();
    sources.forEach(([group, source], k) => {
      const lane = used.get(group) ?? 0;
      used.set(group, lane + 1);
      place(group, lane, source, starts[k], origin);
    });
    end = sources.length ? Math.max(...sources.flatMap(([, s], k) => s.pieces.map((p, i) => origin + starts[k][i] + p.length))) : origin + EMPTY_SONG;
  }

  // Groups: the audio, then each category in the show's order (any it no longer has after those).
  const order = [AUDIO, ...inOrder(show, [...groups.keys()].filter((k) => k !== AUDIO))];
  const grouped: ReaperTrack[] = [];
  for (const id of order) {
    const g = groups.get(id);
    if (!g) continue;
    const name = id === AUDIO ? "Audio" : categoryName(show, id);
    const lane = (i: number) => (i ? `${name} ${i + 1}` : name);
    const colour = id === AUDIO ? TRACK_COLOURS.audio : categoryColour(show, id);
    const tracks: ReaperTrack[] = [
      ...g.lanes.map((items, i) => ({ name: lane(i), items, colour })),
      ...g.ltc.flatMap((items, i) => (items ? [{ name: `${id === AUDIO ? "" : `${lane(i)} `}LTC`, items, ltc: true, colour: TRACK_COLOURS.ltc }] : [])),
    ];
    if (tracks.length > 1) {
      tracks[0].folder = "parent";
      tracks[tracks.length - 1].folder = "last";
    }
    grouped.push(...tracks);
  }
  const videos = [...groups].filter(([id]) => id !== AUDIO).reduce((n, [, g]) => n + g.lanes.length, 0);
  const tracks: ReaperTrack[] = [...(videos > 1 ? [{ name: "Video", items: [], grid: true, colour: TRACK_COLOURS.video }] : []), ...grouped];
  // Tempo only changes where the BPM does.
  const changes = tempo.filter((t, i) => i === 0 || t.bpm !== tempo[i - 1].bpm);
  return { tracks, markers, tempo: changes, length: end, download: [...download], missing: [...missing], uncut };
}

/** A string as REAPER writes one: in double quotes, else single quotes or backticks when it has those in it. */
export function rppString(s: string): string {
  const t = s.replace(/[\r\n]+/g, " ");
  if (!t.includes('"')) return `"${t}"`;
  if (!t.includes("'")) return `'${t}'`;
  if (!t.includes("`")) return `\`${t}\``;
  return `"${t.replace(/"/g, "'")}"`;
}

/** The kind of source REAPER reads a file as. */
function sourceType(file: string): string {
  const ext = extension(file);
  if (["wav", "aif", "aiff", "w64", "bwf"].includes(ext)) return "WAVE";
  if (ext === "mp3") return "MP3";
  if (ext === "flac") return "FLAC";
  if (ext === "ogg") return "VORBIS";
  return "VIDEO"; // video, m4a, aac
}

/** The video processor on the Video track: every video on the tracks below it, in a grid. */
const GRID = [
  "// Every video on the tracks below, side by side",
  "n = input_track_count();",
  "gfx_set(0, 0, 0, 1);",
  "gfx_fillrect(0, 0, project_w, project_h);",
  "n > 0 ? (",
  "  cols = ceil(sqrt(n));",
  "  rows = ceil(n / cols);",
  "  w = project_w / cols;",
  "  h = project_h / rows;",
  "  i = 0;",
  "  loop(n,",
  "    gfx_blit(input_track(i), 1, (i % cols) * w, floor(i / cols) * h, w, h);",
  "    i += 1;",
  "  );",
  ");",
];

const num = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** A colour as REAPER writes a track's: "#RRGGBB" as 0xBBGGRR, flagged as set. */
export function rppColour(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0x1000000 | (b << 16) | (g << 8) | r;
}

/** The .rpp text of a set. */
export function reaperProject(set: ReaperSet): string {
  const lines: string[] = [];
  const put = (depth: number, line: string) => lines.push(`${"  ".repeat(depth)}${line}`);
  put(0, `<REAPER_PROJECT 0.1 "7.0" ${Math.floor(Date.now() / 1000)}`);
  put(1, "TIMELOCKMODE 0"); // items, markers and tempo stay at their times when a BPM changes
  put(1, "TEMPOENVLOCKMODE 0");
  put(1, `TEMPO ${num(set.tempo[0]?.bpm ?? 120)} 4 4`);
  if (set.tempo.length > 1) {
    put(1, "<TEMPOENVEX");
    put(2, "ACT 1 -1");
    put(2, "VIS 1 0 1");
    put(2, "DEFSHAPE 1 -1 -1");
    for (const t of set.tempo) put(2, `PT ${num(t.position)} ${num(t.bpm)} 1`);
    put(1, ">");
  }
  set.markers.forEach((m, i) => put(1, `MARKER ${i + 1} ${num(m.position)} ${rppString(m.name)} 0 0 1`));
  for (const t of set.tracks) {
    put(1, "<TRACK");
    put(2, `NAME ${rppString(t.name)}`);
    put(2, `PEAKCOL ${rppColour(t.colour)}`);
    put(2, `ISBUS ${t.folder === "parent" ? "1 1" : t.folder === "last" ? "2 -1" : "0 0"}`);
    if (t.ltc) put(2, "MAINSEND 0 0");
    if (t.grid) {
      put(2, "<FXCHAIN");
      put(3, "SHOW 0");
      put(3, "LASTSEL 0");
      put(3, "DOCKED 0");
      put(3, "BYPASS 0 0 0");
      put(3, '<VIDEO_EFFECT "Video processor" ""');
      put(4, "<CODE");
      for (const l of GRID) put(5, `|${l}`);
      put(4, ">");
      put(3, ">");
      put(3, "FLOATPOS 0 0 0 0");
      put(3, "WAK 0 0");
      put(2, ">");
    }
    for (const it of t.items) {
      put(2, "<ITEM");
      put(3, `POSITION ${num(it.position)}`);
      put(3, `LENGTH ${num(it.length)}`);
      put(3, `NAME ${rppString(it.name)}`);
      put(3, `SOFFS ${num(it.offset)}`);
      put(3, `CHANMODE ${it.chanmode}`);
      put(3, `<SOURCE ${sourceType(it.file)}`);
      if (!it.video && sourceType(it.file) === "VIDEO") put(4, "VIDEO_DISABLED");
      put(4, `FILE ${rppString(it.file)}`);
      put(3, ">");
      put(2, ">");
    }
    put(1, ">");
  }
  put(0, ">");
  return `${lines.join("\n")}\n`;
}

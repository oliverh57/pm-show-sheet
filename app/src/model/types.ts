// Show data. Same JSON shape as prototypes/google-sheets/show.json, so a bundle's
// project.json can be published by the Google prototype unchanged.

export type Dept = "CORE" | "STATUS" | "COLOUR" | "CONTENT" | "LX" | "VIDEO" | "CAMERAS" | "STAGING" | "SFX" | "MD";
export type ColumnType = "text" | "longtext" | "tc" | "tick" | "colour" | "image";

export interface ColumnDef {
  id: string;
  label: string;
  dept: Dept;
  type: ColumnType;
  width?: number;
  index?: number; // colour columns: which swatch
  editable?: boolean; // collaborators may edit in the Sheet
  on_slide?: boolean;
}

export interface ColourSwatch {
  hex: string;
  label?: string; // gel code or name, e.g. "L201", "OW"
}

export interface Song {
  id: string;
  fields: Record<string, string>;
  statuses: Record<string, boolean>;
  colours: ColourSwatch[];
  hero?: string; // path relative to the bundle, e.g. media/renders/x.jpg
  gallery?: string[]; // every image added to the song (bundle-relative); hero is one of them
  segues_into_next?: boolean;
}

export interface Note {
  id: string;
  song_id: string | null;
  song_name?: string; // typed in the Sheet but not matched to a song
  text: string;
  tc: string;
  from: string;
  assignee: string;
  done: boolean;
  source?: "app" | "sheet";
}

export interface Session {
  id: string;
  label: string;
  notes: Note[];
}

/** What ffprobe reports about a video or audio file. */
export interface MediaInfo {
  available?: boolean;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  video_codec?: string | null;
  audio_channels?: number | null;
  sample_rate?: number | null;
  timecode_track?: string | null;
}

export type Scope = "show" | "song";

/** A recording of the show (whole show) or of one song. Linked in place, never copied. */
export interface SourceRecord {
  id: string;
  path: string;
  name: string;
  scope: Scope;
  song_id?: string | null;
  note?: string;
  info?: MediaInfo;
  added_at: string;
}

/** A playback audio file: the whole show (continuous) or one song. Linked in place. */
export interface AudioFile {
  id: string;
  path: string;
  name: string;
  scope: Scope;
  song_id?: string | null;
  version: string; // as the user labels it: V3, 012025, Spotify…
  note?: string;
  info?: MediaInfo;
  added_at: string;
}

/** A Depence (or other) export folder feeding the render inbox. */
export interface WatchFolder {
  id: string;
  path: string;
  label: string;
  added_at: string;
}

/** Per-machine cull decisions, keyed by the render's path on this machine (bundle inbox.json). */
export type InboxState = Record<string, { flag: "approved" | "rejected"; song_id?: string; imported_as?: string }>;

export interface Show {
  id: string;
  name: string;
  branding?: { logo?: string };
  records?: SourceRecord[];
  audio?: AudioFile[];
  watch_folders?: WatchFolder[];
  columns: ColumnDef[];
  set_order: string[];
  archive: string[];
  songs: Record<string, Song>;
  sessions: Session[];
  conflicts?: Record<string, unknown>;
  comments?: unknown[];
}

export type ListName = "set_order" | "archive";

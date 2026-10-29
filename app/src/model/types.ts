// Show data. Same JSON shape as prototypes/google-sheets/show.json, so a bundle's
// project.json can be published by the Google prototype unchanged.

/** A category (department, a band in the Sheet): one of DEPTS ("CORE", "STATUS", "LX"…) or one the show added ("LASERS"). */
export type Dept = string;

/** A category the show added (Show.departments), with its band colour. Built-in ones listed here have no colour of their own. */
export interface DeptDef {
  id: string;
  colour?: string;
  label?: string; // its name, if it's been renamed: the id stays, so its fields, media and colour stay with it
}
// "colour" is one of the song's lighting swatches; "palette" is a custom field with swatches of its own, picked the same way
// (Song.swatches); "choice" is one of `options`; "clip" links to the song's clips from one category's records (in the Sheet and on the slide).
export type ColumnType = "text" | "longtext" | "tc" | "tick" | "colour" | "image" | "palette" | "choice" | "clip";

export interface ColumnDef {
  id: string;
  label: string;
  dept: Dept;
  type: ColumnType;
  width?: number;
  index?: number; // colour columns: which swatch
  editable?: boolean; // collaborators may edit in the Sheet
  on_slide?: boolean;
  on_card?: boolean; // long-text note fields shown on every song card
  options?: string[]; // choice columns: the only values allowed
  category?: string; // clip columns: the category (image column id) whose records' clips it shows, next to that picture; unset shows every clip
}

export interface ColourSwatch {
  hex: string;
  label?: string; // colour name, e.g. "Steel Blue", "CTB", "Deep Red"
  pie?: string[]; // a multi-colour swatch (RGB / CMY rainbow): these hexes as equal slices; hex is the single-colour fallback
}

export interface Song {
  id: string;
  fields: Record<string, string>;
  statuses: Record<string, boolean>;
  colours: ColourSwatch[];
  swatches?: Record<string, ColourSwatch[]>; // colour (palette) fields, by column id
  hero?: string; // path relative to the bundle, e.g. media/grabs/x.jpg: the main image (General, the SONG IMAGE column), also its card
  images?: Record<string, string>; // the other image columns' images (bundle-relative, from the gallery), by column id
  gallery?: string[]; // every image added to the song (bundle-relative); hero is one of them
  hero_crop?: CropRect & { src: string }; // when the hero is a crop (media/crops/) of src, a gallery image
  segues_into_next?: boolean;
  clips?: Clip[]; // low-quality clips cut from show records
}

/** Part of an image, in fractions of its width and height. */
export interface CropRect { x: number; y: number; w: number; h: number }

/** A clip cut from a record for one song (bundle-relative path). */
export interface Clip {
  path: string;
  record_id: string;
  in: number; // seconds into the record
  out: number;
  source: "auto_tc" | "manual";
  still?: string; // the still grabbed with it (bundle-relative), if any
  burn_tc?: boolean; // cut with the record's TC drawn in the bottom-right corner
  cuts?: [number, number][]; // long pauses cut out of it, in seconds into the record (see SongMark)
  category?: string; // the category (image column id) it was moved into, when not its record's
}

/** One continuous run of LTC in a file: a TC block, usually one song. */
export interface TcBlock {
  file_start: number; // seconds into the file
  file_end: number;
  tc_start: string; // HH:MM:SS:FF
  tc_end: string;
}

/** Where a song sits in a show record. */
export interface SongMark {
  song_id: string;
  in: number;
  out: number;
  source: "auto_tc" | "manual";
  /** Long pauses inside it (seconds into the record, in order), cut out of its clip with a GAP CUT card. */
  cuts?: [number, number][];
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

/**
 * A comment on a song's video or image (Frame.io style); on a video it's timecoded. It's placed in a show record, not a clip file: a clip is a window
 * on its record, so the comment shows on the clip and on the whole record, and outlives re-cutting the clip.
 */
export interface ReviewComment {
  id: string;
  song_id: string | null;
  record_id?: string; // missing for a comment on an image, or typed in the Sheet with a TC that isn't in any record
  image?: string; // a comment on an image (bundle-relative, as in the song's gallery): it has no time
  t: number; // seconds into the record (0 on an image)
  t_out?: number; // the end of a range comment
  tc?: string; // show TC at t (from the record's LTC), as typed in the Sheet if it has no record
  tc_out?: string;
  text: string;
  dept?: Dept;
  from: string;
  email?: string;
  at: string; // ISO time it was written
  edited_at?: string; // ISO time its text was last changed, after it was written
  draw?: string; // SVG path drawn on the frame, in a 0–1000 square stretched over the picture
  still?: string; // the frame at t (bundle-relative, media/grabs/), shown in the Sheet
  done: boolean;
  resolved_at?: string; // ISO time it was resolved: resolved comments are deleted once older than Show.keep_resolved_days
  replies: ReviewReply[];
  source: "app" | "sheet";
}

export interface ReviewReply {
  id: string;
  from: string;
  email?: string;
  at: string;
  text: string;
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
  /** What the record is ("NYC T5"), for naming its clips "NYC T5_SHOW RECORD_CLIPPED 01 INTRO". */
  label?: string;
  /** The category (image column) its stills go into ("hero" for General). */
  image_col?: string;
  /** Stills made from it (bundle-relative), so they can be found and deleted together. */
  stills?: string[];
  info?: MediaInfo;
  added_at: string;
  ltc?: LtcResult;
  song_marks?: SongMark[];
  /** Draw its TC into its clips' bottom-right corner, like the clock on a show record ("● [25] 09:01:42:19"). */
  burn_tc?: boolean;
}

/** What scanning a file for LTC found. */
export interface LtcResult {
  channel: number | null; // 0-based audio channel carrying LTC, null if none
  fps: number | null;
  blocks: TcBlock[];
  duration: number;
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
  ltc?: LtcResult;
}

/** A Depence (or other) export folder feeding the render inbox. */
export interface WatchFolder {
  id: string;
  path: string;
  label: string;
  added_at: string;
  /** The song its renders are for, picked first in the inbox; none when they're for different songs. */
  song_id?: string;
  /** The category (image column id) its renders go in; Content when unset. */
  image_col?: string;
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
  departments?: DeptDef[]; // categories added in Fields, kept while they have no fields
  set_order: string[];
  archive: string[];
  songs: Record<string, Song>;
  sessions: Session[];
  conflicts?: Record<string, unknown>;
  setup?: { step: number; done: boolean }; // the guided setup for a new show
  added_columns?: string[]; // default columns added to the show after it was made, so a deleted one isn't added back
  migrations?: string[]; // one-time fixes already run on the show, so they don't undo later edits
  google?: GoogleSync;
  venue?: string;
  date?: string;
  cover?: string; // the show's main image (bundle-relative, one of its songs' images), picked in Show settings; else the first song's hero
  comments?: unknown[];
  reviews?: ReviewComment[]; // comments on videos and images, in the order written
  keep_resolved_days?: number | null; // how long resolved comments are kept before they're deleted (KEEP_RESOLVED_DAYS when unset); null keeps them
}

export type ListName = "set_order" | "archive";

/** Where the show's Google Sheet and deck are, and what was last pushed (for the three-way pull). */
export interface GoogleSync {
  folder_id?: string;
  media_folder_id?: string;
  spreadsheet_id?: string;
  sheet_url?: string;
  tab_id?: number;
  archive_tab_id?: number; // the ARCHIVED SONGS tab, once made
  review_tab_id?: number; // the REVIEW tab (video comments), once made
  presentation_id?: string;
  slides_url?: string;
  slides_rev?: number;
  deck_hash?: string; // what the deck showed when last drawn
  published?: Record<string, string | boolean>; // "show|<song>|<column>" → value as pushed
  images?: Record<string, string>; // bundle-relative image path → Drive file id
  clips?: Record<string, string>; // bundle-relative clip path → Drive file id (the app uploads them with the show: src/drive/media.ts)
  named?: string; // the show name the Sheet and deck were last titled with
  app_editors?: string[]; // everyone who uses the show in the app: they can edit the Sheet's locked columns (their sync writes them)
  sheet_pull?: SheetPull; // what the last pull of the Sheet brought in, so every Mac can say who typed it
}

/** Edits a pull brought in from the Google Sheet: who typed them (as near as the Sheet's history tells), and where. */
export interface SheetPull {
  at: number; // ms
  by: { name: string; email?: string };
  songs: Record<string, string[]>; // song id → what changed on it (keys, as in drive/edits.ts)
}

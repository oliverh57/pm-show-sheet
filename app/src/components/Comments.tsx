// Every comment in one place: the Comments page (all songs, grouped by song) and a song's Comments tab. Each comment shows
// the picture it's on (its frame, with any drawing) and which image, clip or record that is; clicking it opens that media
// at the comment. Reply, resolve and delete work as in the viewer's panel. A song's tab can also take a comment on the song
// itself, not on any frame or image.
import { useState } from "react";
import { backend } from "../backend";
import { addReview, clipLabel, deptList, deptName, keepResolvedDays, setReviewDone, songNumber } from "../model/ops";
import type { ReviewComment, Show, Song } from "../model/types";
import { useStore } from "../store";
import { Icon, type IconName } from "./icons";
import { commentItem, MediaViewer, mediaOf } from "./MediaViewer";
import { Thread } from "./Review";
import { formatTime } from "./SongDrawer";

type Filter = "open" | "done" | "all";

/** What a comment is on, for its card: the kind of media and a line naming it. */
export function commentMedia(show: Show, bundle: string, c: ReviewComment): { icon: IconName; label: string } {
  const song = c.song_id ? show.songs[c.song_id] : undefined;
  if (c.image) {
    const item = song && mediaOf(show, bundle, song).find((x) => x.kind === "image" && x.src === c.image);
    return { icon: "image", label: `${item?.label ?? "Image"} · ${c.image.split("/").pop()}` };
  }
  const record = (show.records ?? []).find((r) => r.id === c.record_id);
  if (!record) return c.tc ? { icon: "sheet", label: "Not in a video: TC typed in the Sheet" } : { icon: "music", label: "On the song" };
  const clip = (song?.clips ?? []).find((cl) => cl.record_id === record.id && c.t >= cl.in && c.t <= cl.out);
  if (clip) return { icon: "film", label: `Clip of ${clipLabel(show, clip)} · ${formatTime(c.t - clip.in)} in` };
  return { icon: "film", label: `${record.label || record.name} · ${formatTime(c.t)} in` };
}

const tcLabel = (c: ReviewComment) => (t: number) => (c.image ? "" : (t === c.t_out ? c.tc_out : c.tc) ?? (c.record_id ? formatTime(t) : ""));

/** A comment with the picture it's on and what that is. */
function CommentCard({ c, replying, onReply, onView }: { c: ReviewComment; replying: boolean; onReply: () => void; onView?: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const media = commentMedia(show, bundle, c);
  const placed = Boolean(c.still || c.image || c.record_id); // on a picture: one on the song itself has none to show
  return (
    <div className={`cm-card ${c.done ? "done" : ""} ${placed ? "" : "plain"}`}>
      {placed && (
        <button className="cm-still" disabled={!onView} onClick={onView} title={onView ? "Open it at this comment" : undefined}>
          {c.still ? <img src={backend.mediaUrl(bundle, c.still)} alt="" loading="lazy" draggable={false} /> : <Icon name={media.icon} />}
          {c.still && c.draw && <svg viewBox="0 0 1000 1000" preserveAspectRatio="none"><path d={c.draw} /></svg>}
        </button>
      )}
      <div className="cm-body">
        <button className="cm-media" disabled={!onView} onClick={onView}><Icon name={media.icon} size="sm" /> <span>{media.label}</span></button>
        <Thread c={c} n={0} label={tcLabel(c)} selected={false} replying={replying} onOpen={() => onView?.()} onReply={onReply} />
      </div>
    </div>
  );
}

/** The comments, newest first within each song, with the viewer they open in. `bySong` heads them by song in running order. */
function CommentList({ comments, bySong, empty }: { comments: ReviewComment[]; bySong: boolean; empty: string }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const update = useStore((s) => s.update);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ song: Song; start: string; comment: string } | null>(null);
  const order = new Map([...show.set_order, ...show.archive].map((id, i) => [id, i]));
  const place = (c: ReviewComment) => order.get(c.song_id ?? "") ?? Infinity;
  const sorted = [...comments].sort((a, b) => place(a) - place(b) || Number(a.done) - Number(b.done) || b.at.localeCompare(a.at));
  const groups: { songId: string | null; comments: ReviewComment[] }[] = [];
  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (last && (!bySong || last.songId === c.song_id)) last.comments.push(c);
    else groups.push({ songId: c.song_id, comments: [c] });
  }
  const viewer = (c: ReviewComment) => {
    const song = c.song_id ? show.songs[c.song_id] : undefined;
    const start = song && commentItem(show, bundle, song, c);
    return song && start ? () => setViewing({ song, start, comment: c.id }) : undefined;
  };
  if (!comments.length) return <div className="cm-empty">{empty}</div>;
  return (
    <div className="review-panel light cm-list">
      {groups.map((g) => {
        const song = g.songId ? show.songs[g.songId] : undefined;
        const open = g.comments.filter((c) => !c.done);
        return (
          <section key={g.songId ?? "none"} className="cm-group">
            {bySong && (
              <div className="cm-song">
                <span className="th">{song?.hero ? <img src={backend.mediaUrl(bundle, song.hero)} alt="" /> : <Icon name="music" size="sm" />}</span>
                <b>{song ? `${songNumber(show, song.id)} ${song.fields.name || "Untitled"}`.trim() : "No song"}</b>
                <span className="muted small">{open.length} open</span>
                <span style={{ flex: 1 }} />
                {open.length > 1 && <button className="ghost sm" onClick={() => update((s) => { for (const c of open) setReviewDone(s, c.id, true); })}><Icon name="check" size="sm" /> Resolve all</button>}
                {song && <button className="ghost sm" onClick={() => useStore.getState().focusSong(song.id, "comments")}>Open song</button>}
              </div>
            )}
            {g.comments.map((c) => (
              <CommentCard key={c.id} c={c} replying={replyTo === c.id} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} onView={viewer(c)} />
            ))}
          </section>
        );
      })}
      {viewing && <MediaViewer song={viewing.song} start={viewing.start} comment={viewing.comment} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** Open / Resolved / All, and the department. */
function useCommentFilters(comments: ReviewComment[]) {
  const show = useStore((s) => s.show)!;
  const [filter, setFilter] = useState<Filter>("open");
  const [dept, setDept] = useState("");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = comments.filter((c) => (filter === "all" || (filter === "done") === c.done) && (!dept || c.dept === dept)
    && (!q || [c.text, c.from, ...c.replies.map((r) => r.text)].some((t) => t.toLowerCase().includes(q))));
  const depts = deptList(show).filter((d) => comments.some((c) => c.dept === d));
  const count = (f: Filter) => comments.filter((c) => f === "all" || (f === "done") === c.done).length;
  const controls = (
    <>
      <div className="seg">
        {(["open", "done", "all"] as Filter[]).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{{ open: "Open", done: "Resolved", all: "All" }[f]} <span className="n">{count(f)}</span></button>
        ))}
      </div>
      {depts.length > 0 && (
        <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className="cm-dept">
          <option value="">All departments</option>
          {depts.map((d) => <option key={d} value={d}>{deptName(d, show)}</option>)}
        </select>
      )}
      <input className="cm-search" type="search" value={query} placeholder="Search comments" aria-label="Search comments" onChange={(e) => setQuery(e.target.value)} />
    </>
  );
  const empty = q || dept ? "No comments match" : filter === "open" ? (comments.length ? "No open comments: all resolved" : "No comments yet") : filter === "done" ? "No resolved comments" : "No comments yet";
  return { shown, controls, empty };
}

/** When resolved comments go, as a line under the list. */
function KeepNote() {
  const show = useStore((s) => s.show)!;
  const setView = useStore((s) => s.setView);
  const days = keepResolvedDays(show);
  return (
    <p className="muted small cm-keep">
      {days === null ? "Resolved comments are kept." : `Resolved comments are deleted after ${days} day${days === 1 ? "" : "s"}.`}{" "}
      <button className="link sm" onClick={() => setView("settings")}>Change in Show settings</button>
    </p>
  );
}

/** Every comment on the show's videos and images, by song. */
export function CommentsPage() {
  const show = useStore((s) => s.show)!;
  const comments = show.reviews ?? [];
  const { shown, controls, empty } = useCommentFilters(comments);
  const open = comments.filter((c) => !c.done).length;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Comments</h1><div className="sub">{comments.length ? `${open} open · ${comments.length - open} resolved` : "Comment on a song's clips and images to start"}</div></div>
      </div>
      <div className="cm-bar">{controls}</div>
      <CommentList comments={shown} bySong empty={comments.length ? empty : "No comments yet. Open a clip or image (or Present, then Comments) and press C to write one."} />
      <KeepNote />
    </div>
  );
}

/** Write a comment on the song itself: no frame or image, just the song. */
function SongComposer({ song }: { song: Song }) {
  const show = useStore((s) => s.show)!;
  const user = useStore((s) => s.user);
  const readOnly = useStore((s) => s.readOnly);
  const update = useStore((s) => s.update);
  const [text, setText] = useState("");
  const [dept, setDept] = useState("");
  const [error, setError] = useState(false);
  const depts = deptList(show).filter((d) => !["CORE", "STATUS", "COLOUR"].includes(d));
  const post = () => {
    const body = text.trim();
    if (!body) { setError(true); return; }
    update((s) => { addReview(s, { song_id: song.id, t: 0, text: body, from: user?.name || user?.email || "Me", ...(user?.email && { email: user.email }), ...(dept && { dept }) }); });
    setText(""); setError(false);
  };
  if (readOnly) return null;
  return (
    <div className="review-panel light cm-compose">
      <div className="rv-compose">
        <div className="rv-at">
          <span className="on-image">On the song</span>
          <span style={{ flex: 1 }} />
          <select value={dept} onChange={(e) => setDept(e.target.value)} title="Department">
            <option value="">No department</option>
            {depts.map((d) => <option key={d} value={d}>{deptName(d, show)}</option>)}
          </select>
        </div>
        <textarea rows={2} value={text} placeholder="Leave a comment on the song…" aria-label="Comment on the song"
                  onChange={(e) => { setText(e.target.value); setError(false); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); }
                    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); }
                  }} />
        {error && <div className="rv-error">Type a comment first</div>}
        <div className="rv-tools">
          <span className="muted small">For a frame or an image, open it from Media and press C.</span>
          <span style={{ flex: 1 }} />
          <button className="primary sm" onClick={post}>Comment</button>
        </div>
      </div>
    </div>
  );
}

/** A song's comments, for its Comments tab, with a box for one on the song itself. */
export function SongComments({ song }: { song: Song }) {
  const show = useStore((s) => s.show)!;
  const comments = (show.reviews ?? []).filter((c) => c.song_id === song.id);
  const { shown, controls, empty } = useCommentFilters(comments);
  return (
    <>
      <SongComposer song={song} />
      <div className="cm-bar">{controls}</div>
      <CommentList comments={shown} bySong={false} empty={comments.length ? empty : "No comments on this song yet."} />
      <KeepNote />
    </>
  );
}

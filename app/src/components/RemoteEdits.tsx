// The notice that someone else edited the open show (like Google Sheets'): who, and what, with Show edits to highlight
// the songs and fields they changed. The highlights stay until the notice is closed.
import { editorColour, editorKey, editorName, highlightCss } from "../drive/edits";
import { clipName } from "../model/ops";
import { useStore } from "../store";
import { Icon } from "./icons";

const FIRST_LINES = 3;

export function RemoteEditsNotice() {
  const show = useStore((s) => s.show);
  const edits = useStore((s) => s.remoteEdits);
  const showing = useStore((s) => s.showingEdits);
  const { showEdits, closeEdits, focusSong } = useStore.getState();
  if (!show || !edits) return null;

  const songs = Object.entries(edits.songs).filter(([id]) => show.songs[id]);
  // "in the Google Sheet" when that's where all of it was typed; otherwise each Sheet editor says so.
  const inSheet = edits.by.every((e) => e.via === "sheet");
  const names = edits.by.map((e) => (e.via === "sheet" && !inSheet ? `${editorName(e)} (in the Sheet)` : editorName(e)));
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  const what = `${songs.length ? `${songs.length} song${songs.length === 1 ? "" : "s"}` : "the show"}${inSheet ? " in the Google Sheet" : ""}`;
  const lines = showing ? songs : songs.slice(0, FIRST_LINES);
  const more = songs.length - lines.length;

  return (
    <>
      {showing && <style>{highlightCss(show, edits)}</style>}
      <div className={`edits-notice ${showing ? "showing" : ""}`} role="status">
        <div className="en-head">
          <span className="en-avatars">
            {edits.by.slice(0, 3).map((e) => (
              <span key={editorKey(e)} className="avatar" style={{ background: editorColour(editorKey(e)) }} title={e.email || e.name}>
                {initials(e.name)}
                {e.via === "sheet" && <span className="en-via" title="In the Google Sheet"><Icon name="sheet" size="sm" /></span>}
              </span>
            ))}
          </span>
          <div className="en-title">
            {showing ? <>Showing edits by <b>{who}</b>{inSheet && " in the Google Sheet"}</> : <><b>{who}</b> edited {what}</>}
          </div>
          <button className="icon" title={showing ? "Hide the edits" : "Close"} aria-label="Close" onClick={closeEdits}><Icon name="x" size="sm" /></button>
        </div>
        {(lines.length > 0 || edits.show.length > 0) && (
          <ul className="en-list">
            {lines.map(([id, s]) => (
              <li key={id}>
                <button className="en-song" title="Open the song" onClick={() => focusSong(id)}>
                  {showing && <i style={{ background: editorColour(s.by[s.by.length - 1] ?? "") }} />}
                  <span className="nm">{clipName(show, id)}</span>
                  <span className="what">{s.labels.join(", ")}</span>
                  {!inSheet && s.by[s.by.length - 1]?.startsWith("sheet:") && <span className="en-sheet" title="In the Google Sheet"><Icon name="sheet" size="sm" /></span>}
                </button>
              </li>
            ))}
            {more > 0 && <li className="en-more">and {more} more song{more === 1 ? "" : "s"}</li>}
            {edits.show.length > 0 && <li className="en-show"><span className="nm">Show</span><span className="what">{edits.show.join(", ")}</span></li>}
          </ul>
        )}
        <div className="en-foot">
          {showing
            ? <><span className="muted">Highlighted until you close this</span><button className="sm" onClick={closeEdits}>Hide edits</button></>
            : <>{songs.length > 0 && <button className="sm primary" onClick={showEdits}>Show edits</button>}
                <button className="sm ghost" onClick={closeEdits}>Dismiss</button></>}
        </div>
      </div>
    </>
  );
}

const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

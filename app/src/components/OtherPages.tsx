// Share & publish (the always-on Google Sheet and deck, location, people) and the Sheet grid.
import { useEffect, useState } from "react";
import { backend } from "../backend";
import { syncNow, useSyncStatus } from "../google/sync";
import { deleteOpenShow, openInDrive, renameOpenShow, timeAgo } from "../library";
import { applySheetValue, bundleName, clipName, keepResolvedDays, showCover, showImages } from "../model/ops";
import { DraftInput } from "./fields";
import { useStore } from "../store";
import { chooseAndMove } from "./Shell";
import { Grid } from "./Grid";
import { PeoplePanel } from "./People";
import { GoogleDriveMark, Icon } from "./icons";

export function SharePage() {
  const show = useStore((s) => s.show)!;
  const location = useStore((s) => s.location);
  const sync = useSyncStatus();
  const { update, updateQuiet } = useStore.getState();
  const gs = show.google ?? {};
  const conflicts = Object.entries((show.conflicts ?? {}) as Record<string, { sheet: string | boolean; app: string | boolean }>)
    .map(([key, c]) => { const [, songId, colId] = key.split("|"); return { key, songId, colId, ...c }; })
    .filter((c) => show.songs[c.songId] && show.columns.some((col) => col.id === c.colId));
  const dropConflict = (key: string) => updateQuiet((s) => { const next = { ...(s.conflicts ?? {}) }; delete next[key]; s.conflicts = next; });
  const useSheet = (c: (typeof conflicts)[number]) => {
    update((s) => {
      const col = s.columns.find((x) => x.id === c.colId);
      if (col) applySheetValue(s, c.songId, col, c.sheet);
    });
    dropConflict(c.key);
  };
  async function signInAgain() {
    try {
      useStore.getState().setUser(await backend.signIn());
      syncNow(true);
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""));
    }
  }
  const doc = (kind: "sheet" | "deck") => {
    const url = kind === "sheet" ? gs.sheet_url : gs.slides_url;
    const busy = kind === "deck" && sync.deck !== "idle";
    return (
      <div className="gdoc">
        <div className={`ic ${kind}`}><Icon name={kind === "sheet" ? "sheet" : "slides"} size="lg" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{show.name} | {kind === "sheet" ? "SHOW SHEET" : "SHOW DECK"}</div>
          <div className="d">{!url ? (sync.state === "off" ? "Not created yet" : "Creating…") : kind === "sheet" ? "Updates a few seconds after each change" : busy ? (sync.deck === "drawing" ? "Updating…" : "Updates when you pause") : "Up to date"}</div>
        </div>
        <button className="sm" disabled={!url} onClick={() => url && backend.openWeb(url)}><Icon name="external" size="sm" /> Open</button>
      </div>
    );
  };
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Share &amp; publish</h1><div className="sub">Your Google Sheet and Slides deck stay in sync with this show</div></div>
        <div className="acts">
          <SyncBadge />
          <button className="sm" disabled={!backend.isDesktop} onClick={() => syncNow(true)}>Sync now</button>
        </div>
      </div>
      <div className="share-grid">{doc("sheet")}{doc("deck")}</div>
      {sync.state === "error" && <div className="missing-box" style={{ marginTop: 0, marginBottom: 12 }}><Icon name="alert" /><div><strong style={{ fontWeight: 500 }}>Sync stopped:</strong> {sync.message}
        {sync.message?.startsWith("Sign in to Google again")
          ? <div style={{ marginTop: 8 }}><button className="sm primary" onClick={signInAgain}>Sign in again</button></div>
          : <div className="muted small">It tries again every 30 seconds.</div>}</div></div>}
      {conflicts.length > 0 && (
        <div className="panel">
          <div className="label">Sheet edits that clashed</div>
          <p className="muted small" style={{ marginTop: 0 }}>Someone changed these in the Sheet while they were also changed here. The app's version is in the Sheet for now.</p>
          {conflicts.map((c) => (
            <div key={c.key} className="conflict">
              <div className="what"><strong>{show.songs[c.songId].fields.name}</strong> · {show.columns.find((x) => x.id === c.colId)!.label}</div>
              <div className="vals"><span><span className="muted small">Sheet</span> {String(c.sheet) || "—"}</span><span><span className="muted small">App</span> {String(c.app) || "—"}</span></div>
              <div className="acts"><button className="sm" onClick={() => useSheet(c)}>Use Sheet's</button><button className="sm ghost" onClick={() => dropConflict(c.key)}>Keep app's</button></div>
            </div>
          ))}
        </div>
      )}
      <div className="panel">
        <div className="label">Sync</div>
        <p style={{ margin: 0 }}>Collaborators can edit the ✎ columns in the Sheet; their changes come into the app within a minute.{gs.folder_id && <> <button className="link" onClick={() => backend.openWeb(`https://drive.google.com/drive/folders/${gs.folder_id}`)}>Open the Drive folder</button></>}</p>
      </div>
      <div className="panel">
        <div className="label">Location</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 500 }}>{location ?? "Google Drive"}</div><div className="muted small" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{bundleName(show.name)}.showsheet</div></div>
          <button onClick={() => chooseAndMove()}><Icon name="folder" size="sm" /> Move to another folder…</button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>Move it into a shared drive to share it with the team.</p>
      </div>
      <PeoplePanel />
    </div>
  );
}

/** "Synced 12s ago" / "Syncing…" / "Sync stopped". */
export function SyncBadge() {
  const sync = useSyncStatus();
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 10000); return () => window.clearInterval(t); }, []);
  const signIn = sync.state === "error" && sync.message?.startsWith("Sign in to Google again");
  const label = signIn ? "Sign in to Google again" : { off: sync.message ?? "Sync off", syncing: "Syncing…", error: "Sync stopped", ok: sync.lastSync ? `Synced ${timeAgo(sync.lastSync)}` : "Synced" }[sync.state];
  return <span className={`sync-badge ${sync.state}`} title={sync.message ?? undefined}><span className="dot" />{label}</span>;
}

/** Show settings: name, venue, date, where it's saved and its Google files. Opened from the show name in the sidebar. */
export function SettingsPage() {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const location = useStore((s) => s.location);
  const readOnly = useStore((s) => s.readOnly);
  const [deleting, setDeleting] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const { update, setColumnsOpen } = useStore.getState();
  const gs = show.google ?? {};
  const set = (fn: (s: typeof show) => void) => update(fn);
  return (
    <div className="page narrow">
      <div className="page-head"><div><h1>Show settings</h1><div className="sub">{show.name}</div></div></div>
      <section className="sgroup">
        <div className="label">Show</div>
        <div className="panel slist">
          <SRow title="Name"><DraftInput value={show.name} onCommit={(v) => { renameOpenShow(v); }} /></SRow>
          <SRow title="Venue or tour"><DraftInput value={show.venue ?? ""} placeholder="e.g. Alexandra Palace" onCommit={(v) => set((s) => { s.venue = v.trim() || undefined; })} /></SRow>
          <SRow title="Date"><DraftInput value={show.date ?? ""} placeholder="e.g. 14 March 2026" onCommit={(v) => set((s) => { s.date = v.trim() || undefined; })} /></SRow>
          <CoverRow onChoose={() => setPickingCover(true)} />
        </div>
      </section>
      <section className="sgroup">
        <div className="label">Google Drive</div>
        <div className="panel slist">
          <SRow title={location ?? "Google Drive"} hint={`${bundleName(show.name)}.showsheet`} wrapTitle>
            <button onClick={() => openInDrive(bundle)}><GoogleDriveMark className="ico sm" /> Open</button>
            <button onClick={() => chooseAndMove()}><Icon name="folder" size="sm" /> Move…</button>
          </SRow>
          <SRow title="Google Sheet and deck" hint="They live in the show's folder and update by themselves">
            <button disabled={!gs.sheet_url} onClick={() => gs.sheet_url && backend.openWeb(gs.sheet_url)}><Icon name="sheet" size="sm" /> Sheet</button>
            <button disabled={!gs.slides_url} onClick={() => gs.slides_url && backend.openWeb(gs.slides_url)}><Icon name="slides" size="sm" /> Deck</button>
          </SRow>
        </div>
        {readOnly && <p className="error sgroup-note">{readOnly}</p>}
      </section>
      <section className="sgroup">
        <div className="label">Songs and comments</div>
        <div className="panel slist">
          <SRow title="Fields" hint="The fields every song has, and their columns in the Sheet">
            <button onClick={() => setColumnsOpen(true)}>Edit fields…</button>
          </SRow>
          <SRow title="Keep resolved comments for" hint="Then they're deleted from the show and the Sheet's REVIEW tab. Open comments are never deleted.">
            <KeepResolved />
          </SRow>
        </div>
      </section>
      <section className="sgroup">
        <div className="panel slist danger-zone">
          <SRow title="Delete show" hint="Deletes this show and everything saved in it">
            <button className="danger" disabled={Boolean(readOnly)} onClick={() => setDeleting(true)}><Icon name="trash" size="sm" /> Delete show…</button>
          </SRow>
        </div>
      </section>
      {deleting && <DeleteShowDialog onClose={() => setDeleting(false)} />}
      {pickingCover && <CoverPicker onClose={() => setPickingCover(false)} />}
    </div>
  );
}

const KEEP_OPTIONS: [number | null, string][] = [[1, "1 day"], [3, "3 days"], [7, "1 week"], [14, "2 weeks"], [30, "30 days"], [null, "Forever"]];

/** How long resolved comments are kept before they're deleted. */
export function KeepResolved() {
  const show = useStore((s) => s.show)!;
  const readOnly = useStore((s) => s.readOnly);
  const update = useStore((s) => s.update);
  const days = keepResolvedDays(show);
  const options = KEEP_OPTIONS.some(([d]) => d === days) ? KEEP_OPTIONS : [...KEEP_OPTIONS, [days, `${days} days`] as [number | null, string]];
  return (
    <select value={String(days)} disabled={Boolean(readOnly)} aria-label="Keep resolved comments for"
            onChange={(e) => { const v = e.target.value === "null" ? null : Number(e.target.value); update((s) => { s.keep_resolved_days = v; }); }}>
      {options.map(([d, label]) => <option key={String(d)} value={String(d)}>{label}</option>)}
    </select>
  );
}

/** One settings row: a title (and hint under it) on the left, its control on the right. */
export function SRow({ title, hint, wrapTitle, children }: { title: string; hint?: string; wrapTitle?: boolean; children: React.ReactNode }) {
  return (
    <div className="srow">
      <div className={`srow-text ${wrapTitle ? "wrap" : ""}`}>
        <div className="t">{title}</div>
        {hint && <div className="h">{hint}</div>}
      </div>
      <div className="srow-ctl">{children}</div>
    </div>
  );
}

/** The show's main image (its card in All shows and the sidebar), and the button to choose another. */
function CoverRow({ onChoose }: { onChoose: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const readOnly = useStore((s) => s.readOnly);
  const cover = showCover(show);
  const picked = cover !== undefined && cover === show.cover;
  const count = showImages(show).length;
  return (
    <SRow title="Main image" hint={!cover ? "None yet: add images to a song" : picked ? "Chosen from the show's media" : "The first song's image"}>
      <div className="cover-thumb">{cover ? <img src={backend.mediaUrl(bundle, cover)} alt="" /> : <Icon name="image" />}</div>
      <button disabled={Boolean(readOnly) || count === 0} onClick={onChoose}>Choose…</button>
    </SRow>
  );
}

/** Pick the show's main image from the images added to its songs, or go back to the first song's. */
function CoverPicker({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const { update } = useStore.getState();
  const current = showCover(show);
  const auto = show.cover === undefined || current !== show.cover;
  const choose = (path: string | undefined) => {
    update((s) => { if (path) s.cover = path; else delete s.cover; });
    onClose();
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-label="Choose the main image" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
        <div className="modal-head"><div><h3>Choose the main image</h3><p>Shown on the show's card in All shows and at the top of the sidebar</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <div className="cover-grid">
            <button className={`cover-pick auto ${auto ? "on" : ""}`} onClick={() => choose(undefined)} title="Use the first song's main image">
              <span className="img"><Icon name="music" /></span>
              <span className="nm">First song's image</span>
            </button>
            {showImages(show).map(({ songId, path }) => (
              <button key={path} className={`cover-pick ${!auto && path === show.cover ? "on" : ""}`} onClick={() => choose(path)} title={path.split("/").pop()}>
                <span className="img"><img src={backend.mediaUrl(bundle, path)} alt="" loading="lazy" draggable={false} /></span>
                <span className="nm">{clipName(show, songId)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot"><button onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}

function DeleteShowDialog({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const others = useStore((s) => s.others);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const songs = Object.values(show.songs);
  const images = songs.reduce((n, s) => n + (s.gallery?.length ?? (s.hero ? 1 : 0)), 0);
  const clips = songs.reduce((n, s) => n + (s.clips?.length ?? 0), 0);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const note = await deleteOpenShow();
      toast(note ?? `Deleted ${show.name}`);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal narrow" role="alertdialog" aria-label="Delete show">
        <div className="modal-head"><div><h3>Delete {show.name}?</h3><p>This deletes the show's folder and everything in it.</p></div></div>
        <div className="modal-body">
          <ul className="delete-list">
            <li><b>{songs.length}</b> song{songs.length === 1 ? "" : "s"} and all their notes</li>
            <li><b>{images}</b> render{images === 1 ? "" : "s"} and still{images === 1 ? "" : "s"}, <b>{clips}</b> clip{clips === 1 ? "" : "s"}</li>
            {show.google?.spreadsheet_id && <li>Its Google Sheet and Slides deck</li>}
            <li>For everyone: it's in Google Drive, so it goes from the team's Drive too</li>
          </ul>
          <p className="muted small">It goes to the Trash and Google Drive's bin, where it can be restored for 30 days. Linked show records and audio files stay where they are.</p>
          {others.length > 0 && <p className="error">{others.map((o) => o.name).join(", ")} {others.length === 1 ? "has" : "have"} this show open right now.</p>}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot"><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary delete-btn" disabled={busy} onClick={remove}><Icon name="trash" size="sm" /> {busy ? "Deleting…" : "Delete show"}</button></div>
      </div>
    </div>
  );
}

export function SheetPage() {
  const setColumnsOpen = useStore((s) => s.setColumnsOpen);
  return (
    <div className="page full">
      <div className="page-head">
        <div><h1>Sheet view</h1><div className="sub">Every field in one grid</div></div>
        <div className="acts"><button onClick={() => setColumnsOpen(true)}><Icon name="sheet" size="sm" /> Columns</button></div>
      </div>
      <div className="sheet-wrap"><Grid /></div>
    </div>
  );
}

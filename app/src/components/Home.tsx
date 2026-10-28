// All shows: every show you can open in Google Drive (My Drive, shared drives and Shared with me), newest first, plus New show.
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend, type ShowSummary } from "../backend";
import { cachedShows, createShow, type DriveFolder, newShowFolder, openShow, rememberNewShowFolder, scanShows, timeAgo } from "../library";
import { bundleName } from "../model/ops";
import { downloadShow, showOnlineOnly } from "../storage";
import { useStore } from "../store";
import { DriveFolderPicker } from "./DriveFolderPicker";
import { Avatar, GoogleDriveMark, Icon } from "./icons";
import { VersionLine } from "./UpdateBar";

export function Home() {
  const [shows, setShows] = useState<ShowSummary[]>(cachedShows);
  const [scanning, setScanning] = useState(true);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<{ path: string; text: string } | null>(null); // a show whose media is downloading or being removed

  async function refresh() {
    setScanning(true);
    setError(null);
    const found = await scanShows((s) => {
      setShows((cur) => [s, ...cur.filter((x) => x.path !== s.path)].sort((a, b) => b.modified_ms - a.modified_ms));
    });
    setShows(found);
    setScanning(false);
  }
  useEffect(() => {
    refresh().catch((e) => { setError(String(e)); setScanning(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(path: string) {
    setError(null);
    setOpening(path);
    try {
      await openShow(path);
    } catch (e) {
      setError(`Couldn't open that show: ${String(e).replace(/^Error: /, "")}`);
    }
    setOpening(null);
  }

  async function downloadAll(s: ShowSummary) {
    setError(null);
    setMedia({ path: s.path, text: "Looking in Google Drive…" });
    try {
      const n = await downloadShow(s.path, (done, total) => setMedia({ path: s.path, text: `Downloading ${done} of ${total}` }));
      useStore.getState().toast(n ? `Downloaded ${n} file${n === 1 ? "" : "s"} of ${s.name}` : `All of ${s.name}'s media is already on this Mac`);
    } catch (e) {
      setError(`Couldn't download all of ${s.name}: ${String(e).replace(/^Error: /, "")}`);
    }
    setMedia(null);
  }

  async function onlineOnly(s: ShowSummary) {
    setError(null);
    setMedia({ path: s.path, text: "Removing downloads…" });
    try {
      const n = await showOnlineOnly(s.path);
      useStore.getState().toast(n ? `Removed ${n} file${n === 1 ? "" : "s"} of ${s.name} from this Mac: they download again when they're shown` : `None of ${s.name}'s media is on this Mac`);
    } catch (e) {
      setError(`Couldn't remove ${s.name}'s downloads: ${String(e).replace(/^Error: /, "")}`);
    }
    setMedia(null);
  }

  const q = query.trim().toLowerCase();
  const list = shows.filter((s) => !q || `${s.name} ${s.venue ?? ""} ${s.date ?? ""} ${s.where ?? ""}`.toLowerCase().includes(q));

  return (
    <div className="home">
      <header className="topbar">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <span className="product">Show Sheet</span>
        <div className="search"><Icon name="search" /><input placeholder="Search shows" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <button className="drive-pill" onClick={() => backend.openWeb("https://drive.google.com/drive/")}><GoogleDriveMark /> Google Drive</button>
        <button className="icon" onClick={() => useStore.getState().setView("prefs")} title="Settings (⌘,)" aria-label="Settings"><Icon name="settings" /></button>
        <UserMenu />
      </header>
      <div className="home-inner">
        <div className="home-hero">
          <div>
            <h1>All shows</h1>
            <p className="scan-line">{scanning ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />Looking in Google Drive…</> : `${shows.length} show${shows.length === 1 ? "" : "s"} in Google Drive`}</p>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="projects">
          <button className="pcard new-card" onClick={() => setCreating(true)}><div><Icon name="plus" size="lg" />New show</div></button>
          {list.map((s, i) => (
            <div key={s.path} className="pcard-wrap" style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}>
            <button className="pcard" onClick={() => open(s.path)} disabled={opening !== null}>
              <div className="cover">
                {s.cover ? <img src={backend.fileUrl(s.cover)} alt="" /> : <div className="ph"><Icon name="music" /></div>}
                {media?.path === s.path && <span className="media-busy"><span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />{media.text}</span>}
              </div>
              <div className="body">
                <div className="name">{s.name}</div>
                <div className="meta">{[s.venue, s.date].filter(Boolean).join(" · ") || "No venue or date yet"}</div>
                <div className="where"><GoogleDriveMark /> {s.where ?? "Google Drive"}</div>
                <div className="foot">
                  <span className="chip">{s.songs} song{s.songs === 1 ? "" : "s"}</span>
                  {s.canEdit === false && <span className="chip">View only</span>}
                  <span>{opening === s.path ? "Opening…" : `Edited ${timeAgo(s.modified_ms)}`}</span>
                </div>
              </div>
            </button>
            {backend.isDesktop && (
              <div className="pcard-acts">
                <button className="icon" disabled={media !== null} title="Download all its media to this Mac" aria-label="Download all media" onClick={() => downloadAll(s)}><Icon name="download" size="sm" /></button>
                <button className="icon" disabled={media !== null} title="Make all its media online only: remove it from this Mac (it stays in Google Drive and downloads again when it's shown)" aria-label="Make all media online only" onClick={() => onlineOnly(s)}><Icon name="cloud" size="sm" /></button>
              </div>
            )}
            </div>
          ))}
        </div>
        {!scanning && q && list.length === 0 && <p className="muted">No shows match “{query}”.</p>}
        {!scanning && !q && shows.length === 0 && <p className="muted">No shows in Google Drive yet, and none shared with you.</p>}
        <div className="home-foot">
          <span><button className="link" onClick={() => refresh().catch((e) => { setError(String(e)); setScanning(false); })} disabled={scanning}>Look again</button></span>
        </div>
        <div className="home-foot"><VersionLine /></div>
      </div>
      {creating && <NewShowDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function UserMenu() {
  const user = useStore((s) => s.user)!;
  const setUser = useStore((s) => s.setUser);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="menu-btn" onClick={() => setOpen(!open)}><Avatar name={user.name} picture={user.picture} /></button>
      {open && (
        <div className="menu">
          <div className="who"><Avatar name={user.name} picture={user.picture} /><div><div>{user.name}</div><div className="email">{user.email}</div></div></div>
          <button onClick={() => useStore.getState().setView("prefs")}>Settings…</button>
          <button onClick={async () => { await backend.signOut(); setUser(null); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function NewShowDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [date, setDate] = useState("");
  const [folder, setFolder] = useState<DriveFolder>(newShowFolder);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      rememberNewShowFolder(folder);
      await createShow(folder, { name: name.trim(), venue: venue.trim(), date: date.trim() });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      setBusy(false);
    }
  }

  if (choosing) {
    return <DriveFolderPicker title="Save the new show in…" action="Save here" onClose={() => setChoosing(false)}
                              onPick={(f) => { setFolder(f); setChoosing(false); }} />;
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="New show" onKeyDown={(e) => e.key === "Enter" && create()}>
        <div className="modal-head"><div><h3>New show</h3><p>You can change this later.</p></div><button className="icon" onClick={onClose}><Icon name="x" /></button></div>
        <div className="modal-body">
          <label className="field"><span className="field-label">Show name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={{ height: 42, fontSize: 16, fontWeight: 500 }} /></label>
          <div className="row2">
            <label className="field"><span className="field-label">Venue or tour</span><input value={venue} onChange={(e) => setVenue(e.target.value)} /></label>
            <label className="field"><span className="field-label">Date</span><input value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <span className="field-label" style={{ marginBottom: 6 }}>Saved to</span>
          <div className="save-loc">
            <GoogleDriveMark />
            <span style={{ flex: 1 }}>{folder.label} › <b>{bundleName(name.toUpperCase() || "Untitled show")}</b></span>
            <button className="sm ghost" onClick={() => setChoosing(true)} disabled={!backend.isDesktop}>Change…</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot"><button onClick={onClose}>Cancel</button><button className="primary" onClick={create} disabled={!name.trim() || busy}>{busy ? "Creating…" : "Create show"} <Icon name="arrowR" /></button></div>
      </div>
    </div>
  );
}

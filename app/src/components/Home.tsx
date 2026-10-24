// All shows: every show in your Google Drive (My Drive and shared drives), newest first, plus New show.
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend, type ShowSummary } from "../backend";
import {
  cachedShows, createShow, describeLocation, driveRoot, newShowFolder, openShow, readOnlyReason, rememberNewShowFolder, scanShows, timeAgo,
} from "../library";
import { bundleName } from "../model/ops";
import { useStore } from "../store";
import { Avatar, GoogleDriveMark, Icon } from "./icons";
import { SharedWithYou } from "./People";
import { VersionLine } from "./UpdateBar";

const DRIVE_DOWNLOAD = "https://www.google.com/drive/download/";

export function Home() {
  const user = useStore((s) => s.user)!;
  const [shows, setShows] = useState<ShowSummary[]>(cachedShows);
  const [scanning, setScanning] = useState(true);
  const [driveFound, setDriveFound] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ path: string; reason: string } | null>(null);

  async function refresh() {
    setScanning(true);
    setDriveFound(Boolean(await backend.showsFolder(user.email)));
    const found = await scanShows(user.email, (s) => {
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
    try {
      await openShow(path);
    } catch (e) {
      setError(`Couldn't open that show: ${e}`);
    }
  }

  /** Shows can only be edited in your Google Drive: anywhere else, warn and open read only. */
  async function openOther() {
    const path = await backend.chooseBundle();
    if (!path) return;
    const reason = readOnlyReason(path, user.email);
    if (reason) setWarning({ path, reason });
    else open(path);
  }

  const q = query.trim().toLowerCase();
  const list = shows.filter((s) => !q || `${s.name} ${s.venue ?? ""} ${s.date ?? ""} ${s.path}`.toLowerCase().includes(q));

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
            <p className="scan-line">{scanning ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />Looking in your Google Drive and shared drives…</> : `${shows.length} show${shows.length === 1 ? "" : "s"} in Google Drive`}</p>
          </div>
        </div>
        {driveFound === false && (
          <div className="banner">
            <GoogleDriveMark />
            <div><strong>Google Drive isn't on this Mac.</strong> Shows are kept in Google Drive: install Google Drive for desktop and sign in with {user.email}.</div>
            <button className="sm" onClick={() => backend.openWeb(DRIVE_DOWNLOAD)}>Get Google Drive</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <SharedWithYou onAdded={() => refresh()} />
        <div className="projects">
          {driveFound !== false && <button className="pcard new-card" onClick={() => setCreating(true)}><div><Icon name="plus" size="lg" />New show</div></button>}
          {list.map((s, i) => (
            <button key={s.path} className="pcard" style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }} onClick={() => open(s.path)} title={s.path}>
              <div className="cover">{s.cover ? <img src={backend.fileUrl(s.cover)} alt="" /> : <div className="ph"><Icon name="music" /></div>}</div>
              <div className="body">
                <div className="name">{s.name}</div>
                <div className="meta">{[s.venue, s.date].filter(Boolean).join(" · ") || "No venue or date yet"}</div>
                <div className="where" title={s.path}><GoogleDriveMark /> {describeLocation(s.path)}</div>
                <div className="foot"><span className="chip">{s.songs} song{s.songs === 1 ? "" : "s"}</span><span>Edited {timeAgo(s.modified_ms)}</span></div>
              </div>
            </button>
          ))}
        </div>
        {!scanning && q && list.length === 0 && <p className="muted">No shows match “{query}”.</p>}
        {!scanning && !q && shows.length === 0 && driveFound && <p className="muted">No shows in your Google Drive yet.</p>}
        <div className="home-foot">
          <span><button className="link" onClick={() => refresh()} disabled={scanning}>Look again</button></span>
          <span><button className="link" onClick={openOther}>Open a show from somewhere else…</button></span>
        </div>
        <div className="home-foot"><VersionLine /></div>
      </div>
      {creating && <NewShowDialog shows={shows} onClose={() => setCreating(false)} />}
      {warning && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setWarning(null)}>
          <div className="modal narrow" role="alertdialog">
            <div className="modal-head"><div><h3>Open read only?</h3><p>{warning.reason}</p></div></div>
            <div className="modal-body"><p className="muted small" style={{ margin: 0 }}>Shows are kept in the Pixelmappers Google Drive. You can look at this one, then move it into Drive to edit it.</p></div>
            <div className="modal-foot"><button onClick={() => setWarning(null)}>Cancel</button><button className="primary" onClick={() => { const p = warning.path; setWarning(null); open(p); }}>Open read only</button></div>
          </div>
        </div>
      )}
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

function NewShowDialog({ shows, onClose }: { shows: ShowSummary[]; onClose: () => void }) {
  const user = useStore((s) => s.user)!;
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [date, setDate] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    newShowFolder(user.email, shows).then(setFolder);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseFolder() {
    const path = await backend.chooseFolder("Save the new show in…", driveRoot(folder ?? "") ?? undefined);
    if (!path) return;
    if (readOnlyReason(`${path}/x`, user.email)) return setError("Choose a folder in your Google Drive (My Drive or a shared drive).");
    setError(null);
    setFolder(path);
  }

  async function create() {
    if (!name.trim() || !folder) return;
    setBusy(true);
    setError(null);
    try {
      rememberNewShowFolder(folder);
      await createShow(folder, { name: name.trim(), venue: venue.trim(), date: date.trim() });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
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
            <span style={{ flex: 1 }}>{folder ? <>{describeLocation(`${folder}/x`)} › <b>{bundleName(name.toUpperCase() || "Untitled show")}</b></> : "Finding your Google Drive…"}</span>
            <button className="sm ghost" onClick={chooseFolder}>Change…</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot"><button onClick={onClose}>Cancel</button><button className="primary" onClick={create} disabled={!name.trim() || !folder || busy}>{busy ? "Creating…" : "Create show"} <Icon name="arrowR" /></button></div>
      </div>
    </div>
  );
}

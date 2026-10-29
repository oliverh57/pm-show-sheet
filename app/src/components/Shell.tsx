// The window around a show: sidebar, the read-only and offline banners, and toasts.
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import logo from "../assets/logo.png";
import { backend } from "../backend";
import { moveOpenShow, openInDrive } from "../library";
import { showCover } from "../model/ops";
import { useStore, type View } from "../store";
import { DriveFolderPicker } from "./DriveFolderPicker";
import { openClashes } from "../drive/offline";
import { editedAgo } from "../drive/presence";
import { ClashDialog, OfflineReviewDialog } from "./OfflineReview";
import { SyncBadge } from "./OtherPages";
import { Avatar, GoogleDriveMark, Icon, type IconName } from "./icons";

const NAV: { view: View; label: string; icon: IconName }[] = [
  { view: "songs", label: "Songs", icon: "music" },
  { view: "media", label: "Media", icon: "film" },
  { view: "comments", label: "Comments", icon: "comment" },
];
const COLLAB_NAV: { view: View; label: string; icon: IconName }[] = [
  { view: "share", label: "Share & publish", icon: "share" },
  { view: "sheet", label: "Sheet view", icon: "sheet" },
];

const useMoving = create<{ open: boolean }>(() => ({ open: false }));

/** Ask for a folder in Google Drive and move the open show into it. */
export function chooseAndMove() {
  useMoving.setState({ open: true });
}

function MoveDialog() {
  const open = useMoving((s) => s.open);
  if (!open) return null;
  const close = () => useMoving.setState({ open: false });
  return (
    <DriveFolderPicker title="Move this show to…" action="Move here" onClose={close} onPick={async (folder) => {
      close();
      const { toast } = useStore.getState();
      try {
        await moveOpenShow(folder);
        toast(`Moved to ${folder.label}`);
      } catch (e) {
        toast(String(e).replace(/^Error: /, ""));
      }
    }} />
  );
}

export function Sidebar({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const bundle = useStore((s) => s.bundle)!;
  const view = useStore((s) => s.view);
  const user = useStore((s) => s.user);
  const others = useStore((s) => s.others);
  const readOnly = useStore((s) => s.readOnly);
  const saveState = useStore((s) => s.saveState);
  const saveError = useStore((s) => s.saveError);
  const connection = useStore((s) => s.connection);
  const location = useStore((s) => s.location);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const { setView, undo, redo } = useStore.getState();
  const cover = showCover(show);
  const openComments = (show.reviews ?? []).filter((c) => !c.done).length;

  const item = ({ view: v, label, icon }: (typeof NAV)[number]) => (
    <button key={v} className={view === v || (v === "media" && view === "import") ? "on" : ""} onClick={() => setView(v)}>
      <Icon name={icon} /> {label}
      {v === "songs" && <span className="count">{show.set_order.length}</span>}
      {v === "comments" && openComments > 0 && <span className="count open" title={`${openComments} open`}>{openComments}</span>}
    </button>
  );

  return (
    <aside className="side">
      <div className="side-top">
        <div className="side-bar">
          <button className="back" onClick={onClose}><Icon name="chevL" size="sm" /> All shows</button>
          {!readOnly && <>
            <button className="icon" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo"><Icon name="undo" size="sm" /></button>
            <button className="icon" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo"><Icon name="redo" size="sm" /></button>
          </>}
        </div>
        <button className={`show-switch ${view === "settings" ? "on" : ""}`} onClick={() => setView("settings")} title="Show settings">
          <div className="art">{cover ? <img src={backend.mediaUrl(bundle, cover)} alt="" /> : <img src={logo} alt="" style={{ filter: "var(--logo-filter)", objectFit: "contain", padding: 6 }} />}</div>
          <div className="nm">{show.name}<div className="sub">{[show.venue, show.date].filter(Boolean).join(" · ") || "Show settings"}</div></div>
        </button>
      </div>
      <nav className="nav">{NAV.map(item)}<div className="sep" />{COLLAB_NAV.map(item)}</nav>
      <div className="side-foot">
        {others.length > 0 && (
          <div className="here" title={others.map((o) => `${o.name} (${o.email})${o.editedAt ? ` · ${editedAgo(o.editedAt)}` : ""}`).join("\n")}>
            <span className="avatars">{others.slice(0, 3).map((o) => <Avatar key={o.email} name={o.name} />)}</span>
            <span className="nm">{others.length === 1 ? `${others[0].name.split(" ")[0]} also has this open` : `${others.length} others have this open`}</span>
          </div>
        )}
        <JobsProgress />
        <div className={`sync ${saveState === "saving" ? "saving" : saveState === "error" || saveState === "offline" ? "error" : ""}`} title={saveError ?? undefined}>
          {readOnly ? <b>View only</b> : <>
            {saveState === "saving" && "Saving…"}
            {saveState === "unsaved" && "Unsaved changes"}
            {saveState === "offline" && (connection === "back" ? "Saved on this Mac: to approve" : "Saved on this Mac: offline")}
            {saveState === "error" && "Couldn't save"}
            {saveState === "saved" && <>Saved to <b>Google Drive</b></>}
          </>}
          <div className="loc">{location ?? "Google Drive"}</div>
        </div>
        {!readOnly && <button className="sync-line" onClick={() => setView("share")}><SyncBadge /></button>}
        <div className="row">
          <button className="sm" style={{ flex: 1 }} onClick={() => openInDrive(bundle)} title="Open this show's folder on drive.google.com">
            <GoogleDriveMark className="ico sm" /> Open in Drive
          </button>
        </div>
        {user && (
          <div className="user">
            <Avatar name={user.name} picture={user.picture} /><span className="nm">{user.email}</span>
            <button className={`icon ${view === "prefs" ? "on" : ""}`} onClick={() => setView("prefs")} title="Settings (⌘,)" aria-label="Settings"><Icon name="settings" size="sm" /></button>
          </div>
        )}
      </div>
      <MoveDialog />
    </aside>
  );
}

/** Across the top of a read-only show: why. */
export function ReadOnlyBanner() {
  const readOnly = useStore((s) => s.readOnly);
  if (!readOnly) return null;
  return (
    <div className="readonly-banner">
      <Icon name="alert" size="sm" />
      <span>You can look at this show, but {readOnly}</span>
    </div>
  );
}

/** Across the top while working offline: that saves stay on this Mac, and wait to be approved once Drive is back. */
export function OfflineBanner() {
  const connection = useStore((s) => s.connection);
  const readOnly = useStore((s) => s.readOnly);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => { if (connection !== "back") setReviewing(false); }, [connection]);
  if (connection === "online") return null;
  return (<>
    <div className={`offline-banner ${connection}`}>
      <Icon name={connection === "back" ? "cloud" : "alert"} size="sm" />
      {connection === "offline" && (readOnly
        ? <span><b>You're working offline.</b> This is the copy of the show on this Mac.</span>
        : <span><b>You're working offline.</b> Your changes are saved on this Mac. When you're back online you'll need to approve them before they go to Google Drive.</span>)}
      {connection === "back" && <>
        <span><b>You're back online.</b> The changes you made offline haven't been uploaded yet. Nobody else sees them until you approve them.</span>
        <button className="sm primary" onClick={() => setReviewing(true)}>Review changes</button>
      </>}
    </div>
    {reviewing && <OfflineReviewDialog onClose={() => setReviewing(false)} />}
  </>);
}

/** Across the top while something clashes with someone else's edit and nobody has picked a version; and the clash dialog. */
export function ClashBanner() {
  const show = useStore((s) => s.show);
  const drive = useStore((s) => s.clashes);
  const open = useStore((s) => s.clashesOpen);
  const me = useStore((s) => s.user?.email);
  const { setClashesOpen } = useStore.getState();
  const count = useMemo(() => (show ? openClashes(show, drive, me).length : 0), [show, drive, me]);
  if (!count && !open) return null;
  return (<>
    {count > 0 && (
      <div className="offline-banner">
        <Icon name="alert" size="sm" />
        <span><b>Someone else changed {count === 1 ? "something you changed" : `${count} things you changed`}</b> at the same time as you. Yours are kept until you pick.</span>
        <button className="sm primary" onClick={() => setClashesOpen(true)}>Review</button>
      </div>
    )}
    {open && count > 0 && <ClashDialog onClose={() => setClashesOpen(false)} />}
  </>);
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return <div className="toasts">{toasts.map((t) => <div key={t.id} className="toast"><Icon name="check" />{t.text}</div>)}</div>;
}

/** Above the Drive status while clips or thumbnails are being made: how far along, and the thumbnails waiting to be picked. */
function JobsProgress() {
  const jobs = useStore((s) => s.jobs);
  const picks = useStore((s) => s.stillPicks.length);
  const { setView, openPicks } = useStore.getState();
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  if (!active && !picks) return null;
  const done = jobs.filter((j) => j.status === "done" || j.status === "error").length;
  const running = jobs.find((j) => j.status === "running");
  // Only clips still being cut go to the Media page; finished ones don't stop "Pick N thumbnails" opening the picker.
  const clips = active && jobs.some((j) => j.kind !== "thumbnail" && (j.status === "queued" || j.status === "running"));
  const fraction = jobs.length ? (done + (running?.progress ?? 0)) / jobs.length : 1;
  return (
    <button className="jobs-progress" onClick={() => (clips ? setView("media") : openPicks())} title={clips ? "See them on the Media page" : "Pick each song's thumbnail"}>
      {active ? (
        <>
          <div className="jp-line">
            <span className="spinner" />
            <span className="t">{clips ? "Cutting clips" : "Making thumbnails"}</span>
            <span className="n">{Math.min(done + 1, jobs.length)} of {jobs.length}</span>
          </div>
          <div className="jp-bar"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
          <div className="jp-sub">{running?.label ?? "Starting…"}{picks ? ` · ${picks} thumbnail${picks === 1 ? "" : "s"} to pick` : ""}</div>
        </>
      ) : (
        <div className="jp-line"><span className="t">Pick {picks} thumbnail{picks === 1 ? "" : "s"}</span><span className="n">Pick →</span></div>
      )}
    </button>
  );
}


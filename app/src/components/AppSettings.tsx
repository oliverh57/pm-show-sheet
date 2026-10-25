// App settings (⌘,): appearance, storage, account and updates. These belong to this Mac, not to a show; show
// settings are under the show's name in the sidebar. Laid out like Show settings (see OtherPages.tsx).
import { useState } from "react";
import logo from "../assets/logo.png";
import { backend } from "../backend";
import { cachedShows } from "../library";
import { makeAllOnlineOnly, setUnusedDays, UNUSED_OPTIONS, useStorage } from "../storage";
import { useStore } from "../store";
import { setThemePref, useTheme, type ThemePref } from "../theme";
import { checkForUpdates, useUpdates } from "../updates";
import { Avatar, Icon, type IconName } from "./icons";
import { SRow } from "./OtherPages";

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function AppSettings({ onBack }: { onBack?: () => void }) {
  const user = useStore((s) => s.user);
  const show = useStore((s) => s.show);
  const pref = useTheme((s) => s.pref);
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          {onBack && <button className="ghost sm back-link" onClick={onBack}><Icon name="chevL" size="sm" /> All shows</button>}
          <h1>Settings</h1>
          <div className="sub">For this Mac{show ? " · Show settings are under the show's name" : ""}</div>
        </div>
      </div>
      <section className="sgroup">
        <div className="label">Appearance</div>
        <div className="panel">
          <div className="theme-opts" role="radiogroup" aria-label="Appearance">
            {THEMES.map((t) => (
              <button key={t.value} role="radio" aria-checked={pref === t.value} className={`theme-opt ${pref === t.value ? "on" : ""}`} onClick={() => setThemePref(t.value)}>
                <span className={`theme-preview ${t.value}`}><i /><i /></span>
                <span className="nm"><Icon name={t.icon} size="sm" /> {t.label}</span>
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>System matches your Mac's appearance and switches with it.</p>
        </div>
      </section>
      <StorageGroup />
      {user && (
        <section className="sgroup">
          <div className="label">Account</div>
          <div className="panel slist">
            <div className="srow" style={{ gap: 12 }}>
              <Avatar name={user.name} picture={user.picture} />
              <div className="srow-text"><div className="t">{user.name}</div><div className="h">{user.email}</div></div>
              <div className="srow-ctl">
                {show
                  ? <span className="muted small">Close the show to sign out</span>
                  : <button onClick={async () => { await backend.signOut(); useStore.getState().setUser(null); useStore.getState().setView("songs"); }}><Icon name="logout" size="sm" /> Sign out</button>}
              </div>
            </div>
          </div>
        </section>
      )}
      <UpdatesGroup />
    </div>
  );
}

/** Online only: removing show media from this Mac while it stays in Google Drive. */
function StorageGroup() {
  const days = useStorage((s) => s.unusedDays);
  const openBundle = useStore((s) => s.bundle);
  const toast = useStore((s) => s.toast);
  const [progress, setProgress] = useState<string | null>(null);

  async function makeAll() {
    const bundles = [...new Set([...(openBundle ? [openBundle] : []), ...cachedShows().map((s) => s.path)])];
    if (!bundles.length) return toast("No shows found yet. Open All shows to look for them.");
    if (!(await backend.confirm(`Make every file in ${bundles.length === 1 ? "your show" : `your ${bundles.length} shows`} online only? They stay in Google Drive and download again when they're opened.`))) return;
    setProgress("Working…");
    try {
      const r = await makeAllOnlineOnly(bundles, (done, total) => setProgress(`Working… ${done + 1}/${total} shows`));
      toast([
        r.done ? `${r.done} file${r.done === 1 ? " is" : "s are"} now online only` : "Nothing more to make online only",
        r.uploading && `${r.uploading} still uploading`,
        ...r.notes.slice(0, 3),
      ].filter(Boolean).join(" · "));
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    }
    setProgress(null);
  }

  return (
    <section className="sgroup">
      <div className="label">Storage</div>
      <div className="panel slist">
        <SRow title="Make unused files online only" hint="Records, audio and clips not opened on this Mac for a while. They stay in Google Drive and download again when they're opened.">
          <select value={days} aria-label="Make unused files online only" onChange={(e) => setUnusedDays(Number(e.target.value))}>
            {UNUSED_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
        </SRow>
        <SRow title="All files" hint="Every show's media, images too. Files still uploading stay until they're in Google Drive.">
          <button disabled={Boolean(progress)} onClick={makeAll}><Icon name="cloud" size="sm" /> {progress ?? "Make all online only"}</button>
        </SRow>
      </div>
    </section>
  );
}

const UPDATE_STATUS: Record<string, string> = {
  checking: "Checking for updates…",
  "up-to-date": "Up to date",
  error: "Couldn't check for updates",
};

function UpdatesGroup() {
  const { current, status, version, progress, error } = useUpdates();
  const hint = current
    ? status === "downloading" ? `Downloading ${version}${progress ? ` (${Math.round(progress * 100)}%)` : ""}…`
      : status === "ready" ? `${version} is ready, restart to update` : UPDATE_STATUS[status] ?? "Updates download by themselves"
    : "Updates are checked in the desktop app";
  return (
    <section className="sgroup">
      <div className="label">Updates</div>
      <div className="panel slist">
        <SRow title={current ? `Version ${current}` : "PM Show Sheet"} hint={status === "error" && error ? `${hint}: ${error}` : hint}>
          {current && <button disabled={status === "checking" || status === "downloading" || status === "ready"} onClick={checkForUpdates}>Check for updates</button>}
        </SRow>
      </div>
    </section>
  );
}

/** Settings opened from All shows: the same page under the All shows top bar. */
export function HomeSettings() {
  const back = () => useStore.getState().setView("songs");
  return (
    <div className="home">
      <header className="topbar">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <span className="product">Show Sheet</span>
      </header>
      <AppSettings onBack={back} />
    </div>
  );
}

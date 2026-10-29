// App settings (⌘,): appearance, storage, account and updates. These belong to this Mac, not to a show; show
// settings are under the show's name in the sidebar. Laid out like Show settings (see OtherPages.tsx).
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend } from "../backend";
import { cachedShows } from "../library";
import { LIMIT_OPTIONS, removeAllDownloads, setCacheLimit, setUnusedDays, UNUSED_OPTIONS, useStorage } from "../storage";
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

/** 1.8 GB, 240 MB, 12 KB. */
export function formatSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Downloads: removing show media from this Mac while it stays in Google Drive. */
function StorageGroup() {
  const days = useStorage((s) => s.unusedDays);
  const limit = useStorage((s) => s.cacheLimit);
  const openBundle = useStore((s) => s.bundle);
  const toast = useStore((s) => s.toast);
  const [progress, setProgress] = useState<string | null>(null);
  const [space, setSpace] = useState<{ cache: number; total: number; free: number } | null>(null);
  const measure = () => { backend.driveStorage().then(setSpace, () => setSpace(null)); };
  useEffect(measure, []);
  const size = space?.cache ?? null;

  async function changeLimit(bytes: number) {
    try {
      const freed = await setCacheLimit(bytes);
      if (freed) toast(`Deleted ${formatSize(freed)} of the media used longest ago to fit`);
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    }
    measure();
  }

  async function removeAll() {
    // Every show copied to this Mac, including ones no longer in the All shows list.
    const copies = await backend.driveCachedShows().catch(() => [] as string[]);
    const bundles = [...new Set([...(openBundle ? [openBundle] : []), ...cachedShows().map((s) => s.path), ...copies])];
    if (!bundles.length) return toast("No media is cached on this Mac");
    if (!(await backend.confirm(`Delete the cached clips and images of ${bundles.length === 1 ? "your show" : `all ${bundles.length} shows`} from this Mac? They stay in Google Drive and download again when they're shown.`))) return;
    setProgress("Deleting…");
    try {
      const n = await removeAllDownloads(bundles, (done, total) => setProgress(`Deleting… ${done + 1}/${total} shows`));
      toast(n ? `Deleted ${n} cached file${n === 1 ? "" : "s"} from this Mac` : "Nothing more to delete");
    } catch (e) {
      toast(String(e).replace(/^Error: /, ""));
    }
    setProgress(null);
    measure();
  }

  return (
    <section className="sgroup">
      <div className="label">Storage</div>
      <div className="panel slist">
        {space && space.total > 0 && <StorageBar space={space} limit={limit} />}
        <SRow title="Remove downloads of unused shows" hint="Clips of shows not opened on this Mac for a while. They stay in Google Drive and download again when they're shown.">
          <select value={days} aria-label="Remove downloads of unused shows" onChange={(e) => setUnusedDays(Number(e.target.value))}>
            {UNUSED_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
        </SRow>
        <SRow title="Media cache" hint={`Shows' clips and images copied from Google Drive${size === null ? "" : ` · ${formatSize(size)} on this Mac`}`}>
          <button onClick={() => backend.driveOpenCache().catch((e) => toast(String(e).replace(/^Error: /, "")))}><Icon name="folder" size="sm" /> Open media cache</button>
        </SRow>
        <SRow title="Maximum media cache" hint="When it's full, the media used longest ago is deleted from this Mac to make room for new downloads. It stays in Google Drive.">
          <select value={limit} aria-label="Maximum media cache" onChange={(e) => changeLimit(Number(e.target.value))}>
            {LIMIT_OPTIONS.map((o) => <option key={o.bytes} value={o.bytes}>{o.label}</option>)}
          </select>
        </SRow>
        <SRow title="Delete all cached media" hint="Every show's clips and images. Files still uploading stay until they're in Google Drive. Records and audio aren't touched.">
          <button disabled={Boolean(progress)} onClick={removeAll}><Icon name="trash" size="sm" /> {progress ?? "Delete all cached media"}</button>
        </SRow>
      </div>
    </section>
  );
}

/**
 * The media cache as a bar: against its maximum when there is one, else against the disk it's on (show media, everything
 * else, free).
 */
function StorageBar({ space, limit }: { space: { cache: number; total: number; free: number }; limit: number }) {
  const pct = (n: number, of: number) => `${Math.min(100, (n / of) * 100)}%`;
  const other = Math.max(0, space.total - space.free - space.cache);
  return (
    <div className="srow storage-bar">
      <div className="bar" role="img" aria-label={limit ? `${formatSize(space.cache)} of ${formatSize(limit)}` : `${formatSize(space.cache)} of show media, ${formatSize(space.free)} free`}>
        {limit ? <i className={`media ${space.cache >= limit * 0.95 ? "full" : ""}`} style={{ width: pct(space.cache, limit) }} />
          : <><i className="media" style={{ width: pct(space.cache, space.total) }} /><i className="other" style={{ width: pct(other, space.total) }} /></>}
      </div>
      <div className="legend">
        <span><span className="key media" />{limit ? `${formatSize(space.cache)} of ${formatSize(limit)} used` : `Show media · ${formatSize(space.cache)}`}</span>
        {!limit && <span><span className="key other" />Everything else · {formatSize(other)}</span>}
        <span className="free">{formatSize(space.free)} free on this Mac</span>
      </div>
    </div>
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

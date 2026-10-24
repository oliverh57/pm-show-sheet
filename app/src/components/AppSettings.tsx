// App settings (⌘,): appearance, account and updates. These belong to this Mac, not to a show; show
// settings are under the show's name in the sidebar.
import logo from "../assets/logo.png";
import { backend } from "../backend";
import { useStore } from "../store";
import { setThemePref, useTheme, type ThemePref } from "../theme";
import { useUpdates } from "../updates";
import { Avatar, Icon, type IconName } from "./icons";
import { VersionLine } from "./UpdateBar";

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function AppSettings({ onBack }: { onBack?: () => void }) {
  const user = useStore((s) => s.user);
  const show = useStore((s) => s.show);
  const pref = useTheme((s) => s.pref);
  const current = useUpdates((s) => s.current);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          {onBack && <button className="ghost sm back-link" onClick={onBack}><Icon name="chevL" size="sm" /> All shows</button>}
          <h1>Settings</h1>
          <div className="sub">For this Mac{show ? " · Show settings are under the show's name" : ""}</div>
        </div>
      </div>
      <div className="panel">
        <div className="label">Appearance</div>
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
      {user && (
        <div className="panel">
          <div className="label">Account</div>
          <div className="setting-row">
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <Avatar name={user.name} picture={user.picture} />
              <div style={{ minWidth: 0 }}><div style={{ fontWeight: 500 }}>{user.name}</div><div className="muted small">{user.email}</div></div>
            </div>
            {show
              ? <span className="muted small">Close the show to sign out</span>
              : <button onClick={async () => { await backend.signOut(); useStore.getState().setUser(null); useStore.getState().setView("songs"); }}><Icon name="logout" size="sm" /> Sign out</button>}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="label">Updates</div>
        {current ? <VersionLine /> : <p className="muted small" style={{ margin: 0 }}>Updates are checked in the desktop app.</p>}
      </div>
    </div>
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

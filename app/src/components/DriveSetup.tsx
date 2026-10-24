// Shown at launch when Google Drive for desktop isn't on this Mac (or isn't signed in to the user's
// account): shows live in Drive and the app edits them through Drive's folder in Finder.
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend, type DriveStatus } from "../backend";
import { useStore } from "../store";
import { GoogleDriveMark, Icon } from "./icons";

const DRIVE_DOWNLOAD = "https://www.google.com/drive/download/";
const CHECK_EVERY_MS = 3000;

/** Drive is signed in to `email` (or it's the old /Volumes/GoogleDrive mount, which doesn't say). */
export function driveReady(status: DriveStatus, email: string): boolean {
  return status.accounts.some((a) => a === "" || a.toLowerCase() === email.toLowerCase());
}

/** Checks Drive once per signed-in account. `null` while checking; `skip` lets the user carry on without it. */
export function useDriveCheck(email: string | undefined): [boolean | null, () => void] {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!email) return;
    setReady(null);
    backend.driveStatus().then((s) => setReady(driveReady(s, email)), () => setReady(true));
  }, [email]);
  return [ready, () => setReady(true)];
}

export function DriveSetup({ onDone }: { onDone: () => void }) {
  const user = useStore((s) => s.user)!;
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = status !== null && driveReady(status, user.email);

  // Keep looking while the user installs and signs in, then carry on by itself.
  useEffect(() => {
    if (ready) {
      const t = window.setTimeout(onDone, 1200);
      return () => window.clearTimeout(t);
    }
    const check = () => backend.driveStatus().then(setStatus).catch(() => {});
    check();
    const t = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(t);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const installed = Boolean(status?.installed || status?.accounts.length);
  const otherAccounts = status?.accounts.filter(Boolean) ?? [];

  async function openDrive() {
    setError(null);
    try {
      await backend.openDriveApp();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="signin">
      <div className="signin-card drive-setup">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <h1><GoogleDriveMark /> Set up Google Drive</h1>
        <p className="sub">
          Show Sheet keeps every show in Google Drive. <b>Google Drive for desktop</b> puts your Drive in Finder, so the app can open and
          edit show files in Drive directly, and your changes sync to the rest of the team.
        </p>
        <ol className="setup-steps">
          <Step n={1} done={installed} title="Download Google Drive for desktop">
            <span>It's free, from Google.</span>
            {!installed && <div><button className="sm primary" onClick={() => backend.openWeb(DRIVE_DOWNLOAD)}><Icon name="download" /> Download</button></div>}
          </Step>
          <Step n={2} done={installed} title="Install it">
            <span>Open <b>GoogleDrive.dmg</b> from your Downloads, double-click the installer and follow the steps.</span>
          </Step>
          <Step n={3} done={ready} title={`Sign in as ${user.email}`}>
            {otherAccounts.length > 0 && !ready
              ? <span>Drive is signed in as {otherAccounts.join(", ")}. Add {user.email} too: click the Drive icon in the menu bar, then the gear › Preferences › Add another account.</span>
              : <span>Google Drive asks you to sign in when it first opens. Use your Pixelmappers account.</span>}
            {installed && !ready && <div><button className="sm" onClick={openDrive}>Open Google Drive</button></div>}
          </Step>
        </ol>
        {error && <p className="error">{error}</p>}
        <div className="signin-wait">
          {ready ? <><Icon name="check" /> Google Drive is ready</> : <><div className="spinner" />Waiting for Google Drive…</>}
        </div>
        <div className="setup-foot">
          <button className="link" onClick={onDone}>Skip for now</button>
          <span className="muted small">Without it you can only open shows read only.</span>
        </div>
      </div>
    </div>
  );
}

export function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={done ? "done" : ""}>
      <span className="step-n">{done ? <Icon name="check" /> : n}</span>
      <div><strong>{title}</strong>{!done && children}</div>
    </li>
  );
}

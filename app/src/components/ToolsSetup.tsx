// Shown at launch when ffmpeg or ffprobe is missing: they read media for file details, LTC, clips and
// saved copies. With Homebrew here the app installs them itself; without it, a Terminal script
// installs Homebrew (which needs the Mac password) and then ffmpeg.
import { useEffect, useState } from "react";
import logo from "../assets/logo.png";
import { backend, type ToolsStatus } from "../backend";
import { Icon } from "./icons";

const CHECK_EVERY_MS = 3000;

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={done ? "done" : ""}>
      <span className="step-n">{done ? <Icon name="check" /> : n}</span>
      <div><strong>{title}</strong>{!done && children}</div>
    </li>
  );
}

function toolsReady(s: ToolsStatus): boolean {
  return s.ffmpeg && s.ffprobe;
}

/** Checks once after sign-in. `null` while checking; `skip` lets the user carry on without them. */
export function useToolsCheck(signedIn: boolean): [boolean | null, () => void] {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    backend.toolsStatus().then((s) => setReady(toolsReady(s)), () => setReady(true));
  }, [signedIn]);
  return [ready, () => setReady(true)];
}

export function ToolsSetup({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  // Decided by the first check, so the steps don't change under the user once Homebrew arrives.
  const [route, setRoute] = useState<"brew" | "terminal" | null>(null);
  const [installing, setInstalling] = useState(false);
  const [opened, setOpened] = useState(false);
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = status !== null && toolsReady(status);

  useEffect(() => {
    if (ready) {
      const t = window.setTimeout(onDone, 1200);
      return () => window.clearTimeout(t);
    }
    const check = () => backend.toolsStatus().then((s) => {
      setStatus(s);
      setRoute((r) => r ?? (s.brew ? "brew" : "terminal"));
    }).catch(() => {});
    check();
    const t = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(t);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  async function install() {
    setError(null);
    setInstalling(true);
    try {
      await backend.installTools(setLine);
      setStatus(await backend.toolsStatus());
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  async function openTerminal() {
    setError(null);
    try {
      await backend.installToolsInTerminal();
      setOpened(true);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="signin">
      <div className="signin-card drive-setup">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <h1><Icon name="film" /> Install ffmpeg</h1>
        <p className="sub">
          Show Sheet uses <b>ffmpeg</b>, a free media tool, to read your files: file details, timecode from show records, song clips and saved
          copies. It's installed with Homebrew.
        </p>
        {route === "brew" && (
          <ol className="setup-steps">
            <Step n={1} done={ready} title="Install ffmpeg">
              <span>Homebrew is already on this Mac, so this needs no password. It takes a few minutes.</span>
              {!installing && <div><button className="sm primary" onClick={install}><Icon name="download" /> Install ffmpeg</button></div>}
            </Step>
          </ol>
        )}
        {route === "terminal" && (
          <ol className="setup-steps">
            <Step n={1} done={Boolean(status?.brew) || ready} title="Open the installer in Terminal">
              <span>It installs Homebrew, then ffmpeg.{opened && " Closed the window? Open it again."}</span>
              <div><button className="sm primary" onClick={openTerminal}><Icon name="external" /> Open Terminal</button></div>
            </Step>
            <Step n={2} done={Boolean(status?.brew)} title="Enter your Mac password">
              <span>Homebrew asks for the password you use to log in to this Mac (nothing shows as you type it), then for Return. Your Mac account needs to be an administrator.</span>
            </Step>
            <Step n={3} done={ready} title="Wait for it to finish">
              <span>About 5 to 10 minutes. This page carries on by itself once ffmpeg is installed.</span>
            </Step>
          </ol>
        )}
        {error && <p className="error">{error}</p>}
        {(ready || installing || opened) && (
          <div className="signin-wait">
            {ready ? <><Icon name="check" /> ffmpeg is installed</> : <><div className="spinner" />{installing ? <span className="install-line">{line || "Starting Homebrew…"}</span> : "Waiting for ffmpeg…"}</>}
          </div>
        )}
        <div className="setup-foot">
          <button className="link" onClick={onDone}>Skip for now</button>
          <span className="muted small">Media details, timecode and clips won't work without it.</span>
        </div>
      </div>
    </div>
  );
}

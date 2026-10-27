// Shown at launch when ffmpeg or ffprobe is missing: they read media for file details, LTC, clips and
// saved copies. One click downloads them into the app's own folder (see src-tauri/src/tools.rs), with a
// progress bar; no Homebrew, Terminal or password.
import { useEffect, useRef, useState } from "react";
import logo from "../assets/logo.png";
import { backend, type ToolsProgress, type ToolsStatus } from "../backend";
import { Icon } from "./icons";

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

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

/** "About 20 seconds left", from the average speed so far (steadier than the latest chunk's). */
function timeLeft(p: ToolsProgress, startedAt: number): string | null {
  const secs = (Date.now() - startedAt) / 1000;
  if (secs < 2 || p.received === 0) return null;
  const left = (p.total - p.received) / (p.received / secs);
  if (left < 5) return "A few seconds left";
  if (left < 60) return `About ${Math.ceil(left / 5) * 5} seconds left`;
  const mins = Math.round(left / 60);
  return `About ${mins} minute${mins === 1 ? "" : "s"} left`;
}

export function ToolsSetup({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<"idle" | "installing" | "done">("idle");
  const [progress, setProgress] = useState<ToolsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);

  useEffect(() => {
    if (state !== "done") return;
    const t = window.setTimeout(onDone, 1200);
    return () => window.clearTimeout(t);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function install() {
    setError(null);
    setProgress(null);
    setState("installing");
    startedAt.current = Date.now();
    try {
      await backend.installTools(setProgress);
      setState(toolsReady(await backend.toolsStatus()) ? "done" : "idle");
    } catch (e) {
      setState("idle");
      if (String(e) !== "cancelled") setError(String(e));
    }
  }

  const fraction = progress ? (progress.phase === "install" ? 1 : progress.received / progress.total) : 0;
  const status = !progress
    ? "Connecting…"
    : progress.phase === "install"
      ? "Installing…"
      : `Downloading… ${mb(progress.received)} of ${mb(progress.total)} MB`;
  const eta = progress?.phase === "download" ? timeLeft(progress, startedAt.current) : null;

  return (
    <div className="signin">
      <div className="signin-card drive-setup">
        <img src={logo} className="logo" alt="PIXELMAPPERS" />
        <h1><Icon name="film" /> Install ffmpeg</h1>
        <p className="sub">
          Show Sheet uses <b>ffmpeg</b>, a free media tool, to read your files: file details, timecode from show records, song clips and saved
          copies.
        </p>

        {state === "idle" && (
          <div className="tools-install">
            <button className="primary" onClick={install}><Icon name="download" /> {error ? "Try again" : "Install ffmpeg"}</button>
            <span className="muted small">About 60 MB. No password needed, and it only takes a minute.</span>
          </div>
        )}
        {state === "installing" && (
          <div className="tools-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <div className="tp-line">
              <span>{status}</span>
              <span className="n">{Math.round(fraction * 100)}%</span>
            </div>
            <div className={`progress${progress?.phase === "install" ? " busy" : ""}`}><i style={{ width: `${fraction * 100}%` }} /></div>
            <div className="tp-line">
              <span className="muted small">{eta ?? " "}</span>
              {progress?.phase !== "install" && <button className="link small" onClick={() => backend.cancelInstallTools()}>Cancel</button>}
            </div>
          </div>
        )}
        {state === "done" && (
          <div className="signin-wait"><Icon name="check" /> ffmpeg is installed</div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

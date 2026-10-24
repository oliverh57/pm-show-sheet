// Shows once an update has downloaded, the version + "Check for updates" on the welcome screen, and what's new after an update.
import { useEffect, useState } from "react";
import { lastSeenVersion, markVersionSeen, WHATS_NEW } from "../whatsNew";
import { checkForUpdates, restartToUpdate, useUpdates } from "../updates";

export function UpdateBar() {
  const { status, version, notes } = useUpdates();
  if (status !== "ready") return null;
  return (
    <div className="update-bar">
      <span><strong>PM Show Sheet {version}</strong> is ready{notes ? `: ${notes.split("\n")[0]}` : ""}</span>
      <button className="primary" onClick={restartToUpdate}>Restart to update</button>
    </div>
  );
}

export function VersionLine() {
  const { current, status, version, progress, error } = useUpdates();
  if (!current) return null;
  const state: Record<string, string> = {
    idle: "",
    checking: "Checking for updates…",
    downloading: `Downloading ${version}${progress ? ` (${Math.round(progress * 100)}%)` : ""}…`,
    ready: `${version} ready, restart to update`,
    "up-to-date": "Up to date",
    error: "Couldn't check for updates",
  };
  return (
    <p className="muted small version-line" title={error ?? undefined}>
      Version {current}{state[status] ? ` · ${state[status]}` : ""}
      {status !== "checking" && status !== "downloading" && status !== "ready" && (
        <> · <button className="link" onClick={checkForUpdates}>Check for updates</button></>
      )}
    </p>
  );
}

/** "What's new" for this version, shown once the first time the app opens after an update. ?whatsnew previews it in the browser. */
export function WhatsNew() {
  const current = useUpdates((s) => s.current);
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has("whatsnew");
  const version = current ?? (preview ? Object.keys(WHATS_NEW)[0] : null);
  const [dismissed, setDismissed] = useState(false);
  const notes = version ? WHATS_NEW[version] : undefined;
  const seen = version !== null && lastSeenVersion() === version;
  useEffect(() => {
    if (version && !notes) markVersionSeen(version); // nothing to tell
  }, [version, notes]);
  if (!version || !notes || dismissed || (seen && !preview)) return null;
  const close = () => { markVersionSeen(version); setDismissed(true); };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="What's new" onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head"><div><h3>What's new in PM Show Sheet {version}</h3><p>{notes.summary}</p></div></div>
        <div className="modal-body"><ul className="whats-new">{notes.items.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div className="modal-foot"><button className="primary" autoFocus onClick={close}>Got it</button></div>
      </div>
    </div>
  );
}

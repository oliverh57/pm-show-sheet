// Shows once an update has downloaded, and the version + "Check for updates" on the welcome screen.
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

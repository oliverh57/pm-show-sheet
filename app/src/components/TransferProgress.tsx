// The progress bars in the bottom-right corner while media goes up to Google Drive or comes down from it
// (src/drive/media.ts counts them in): how many files, the one going now, how far along it is and about how long is
// left. Downloads can be cancelled. Each waits a moment before showing, so a quick upload after a save or a small image
// doesn't flash it, and says it's done for a moment before going away.
import { useEffect, useRef, useState } from "react";
import { cancelDownloads, formatTimeLeft, runBytes, useTransfers, type TransferRun } from "../drive/media";
import { formatSize } from "./AppSettings";
import { Icon } from "./icons";

const SHOW_AFTER_MS = 600;
const DONE_FOR_MS = 1800;
/** The time left goes by the bytes moved in this long, once it's been going at least `TIME_LEFT_AFTER_MS`. */
const RATE_OVER_MS = 10_000;
const TIME_LEFT_AFTER_MS = 2000;
const TIME_LEFT_EVERY_MS = 1000;

export function TransferProgress() {
  const up = useTransfers((s) => s.up);
  const down = useTransfers((s) => s.down);
  return (
    <div className="transfers">
      <RunCard run={down} dir="down" />
      <RunCard run={up} dir="up" />
    </div>
  );
}

const WORDS = {
  up: { icon: "upload", going: "Uploading", went: "Uploaded", where: "to" },
  down: { icon: "download", going: "Downloading", went: "Downloaded", where: "from" },
} as const;

function RunCard({ run, dir }: { run: TransferRun; dir: "up" | "down" }) {
  const { total, done, active } = run;
  const w = WORDS[dir];
  const busy = total > 0 || active.length > 0;
  const [shown, setShown] = useState(false);
  const [finished, setFinished] = useState<number | null>(null); // files moved, while it says it's done
  const [stopping, setStopping] = useState(false); // Cancel pressed: it goes as soon as they've stopped
  const last = useRef(0); // files in the run so far, for "Uploaded 3 files"
  if (busy) last.current = Math.max(total, done + active.length);
  const timeLeft = useTimeLeft(run);

  useEffect(() => {
    if (busy) {
      setFinished(null);
      const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    if (stopping) {
      setShown(false);
      setStopping(false);
      return;
    }
    setFinished(last.current);
    const t = setTimeout(() => { setShown(false); setFinished(null); }, DONE_FOR_MS);
    return () => clearTimeout(t);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;
  if (finished !== null) {
    return (
      <div className="upload-progress done" role="status" title={`${w.went} ${w.where} Google Drive`}>
        <div className="up-head"><Icon name="check" size="sm" /><span className="up-title">{w.went} {finished === 1 ? "1 file" : `${finished} files`}</span></div>
        <div className="progress"><i style={{ width: "100%" }} /></div>
      </div>
    );
  }

  const of = Math.max(total, done + active.length, 1);
  const current = active[0];
  const fraction = Math.min(1, (done + active.reduce((n, t) => n + (t.size ? t.sent / t.size : 0), 0)) / of);
  return (
    <div className="upload-progress" role="status" title={`${w.going} ${w.where} Google Drive`}>
      <div className="up-head">
        <Icon name={w.icon} size="sm" />
        <span className="up-title">{of === 1 ? `${w.going} ${w.where} Drive` : dir === "up" ? `${w.going} ${Math.min(done + 1, of)} of ${of} files` : `${w.going} ${of} files`}</span>
        <span className="n">{Math.round(fraction * 100)}%</span>
      </div>
      {current && (
        <div className="up-line">
          <span className="up-name" title={active.map((t) => t.name).join("\n")}>{current.name}</span>
          {active.length > 1
            ? <span className="n">+{active.length - 1} more</span>
            : current.size > 0 && <span className="n">{formatSize(current.sent)} of {formatSize(current.size)}</span>}
        </div>
      )}
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <i style={{ width: `${Math.max(3, fraction * 100)}%` }} />
      </div>
      {(timeLeft !== null || dir === "down") && (
        <div className="up-foot">
          <span>{stopping ? "Cancelling…" : timeLeft !== null && formatTimeLeft(timeLeft)}</span>
          {dir === "down" && (
            <button className="link small" disabled={stopping} title="Stop these downloads. They download again when they're next shown"
              onClick={() => { setStopping(true); cancelDownloads().catch(() => setStopping(false)); }}>Cancel</button>
          )}
        </div>
      )}
    </div>
  );
}

/** About how many seconds a run has left, at the rate it's gone lately; null until it can tell. */
function useTimeLeft(run: TransferRun): number | null {
  const { moved, left } = runBytes(run);
  const samples = useRef<[number, number][]>([]); // [when, bytes moved]
  const said = useRef(0);
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    const now = Date.now();
    const s = samples.current;
    if (s.length && moved < s[s.length - 1][1]) s.length = 0; // a new run
    s.push([now, moved]);
    while (s.length > 2 && now - s[1][0] >= RATE_OVER_MS) s.shift();
    const span = now - s[0][0];
    const rate = span > 0 ? (moved - s[0][1]) / span : 0; // bytes a millisecond
    if (left === null || span < TIME_LEFT_AFTER_MS || rate <= 0) {
      setSecs(null);
      said.current = 0;
    } else if (now - said.current >= TIME_LEFT_EVERY_MS) {
      setSecs(left / rate / 1000);
      said.current = now;
    }
  }, [moved, left]);
  return secs;
}

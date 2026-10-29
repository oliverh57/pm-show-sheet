// The progress bars in the bottom-right corner while media goes up to Google Drive or comes down from it
// (src/drive/media.ts counts them in): how many files, the one going now and how far along it is. Each waits a moment
// before showing, so a quick upload after a save or a small image doesn't flash it, and says it's done for a moment
// before going away.
import { useEffect, useRef, useState } from "react";
import { useTransfers, type TransferRun } from "../drive/media";
import { formatSize } from "./AppSettings";
import { Icon } from "./icons";

const SHOW_AFTER_MS = 600;
const DONE_FOR_MS = 1800;

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
  const last = useRef(0); // files in the run so far, for "Uploaded 3 files"
  if (busy) last.current = Math.max(total, done + active.length);

  useEffect(() => {
    if (busy) {
      setFinished(null);
      const t = setTimeout(() => setShown(true), SHOW_AFTER_MS);
      return () => clearTimeout(t);
    }
    if (!shown) return;
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
    </div>
  );
}

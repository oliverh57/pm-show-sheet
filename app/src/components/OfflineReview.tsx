// Back online with changes made offline: for each one, song by song, pick the version the show should have, Google
// Drive's (or the Sheet's) or yours. Green is what's kept, red what's lost. One that someone else also
// changed starts with neither picked. Below, what other people changed meanwhile that doesn't touch yours, to look at only.
// The same dialog comes up for a clash while online (ClashDialog): someone else changed what you did, at the same time.
import { useEffect, useMemo, useState } from "react";
import { backend } from "../backend";
import { approveOffline, discardOffline, isOffline } from "../drive/live";
import { clashes, openClashes, putBack, reviewOffline, settle, songName, valueIn, type Change, type Clash, type OfflineReview } from "../drive/offline";
import { syncNow } from "../google/sync";
import type { ColourSwatch, Show } from "../model/types";
import { useStore } from "../store";
import { Icon } from "./icons";

const message = (e: unknown) => isOffline(e) ? "Google Drive can't be reached again. Your changes are still saved on this Mac." : String(e).replace(/^Error: /, "");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
type Choice = "keep" | "throw";

/** Changes by song (in running order, then the archive), with the show's own changes last. */
function bySong(changes: Change[], ...shows: Show[]): [string | null, Change[]][] {
  const groups = new Map<string | null, Change[]>();
  for (const c of changes) groups.set(c.song, [...(groups.get(c.song) ?? []), c]);
  const rank = (id: string | null) => {
    if (id === null) return Infinity;
    for (const s of shows) {
      const i = [...s.set_order, ...s.archive].indexOf(id);
      if (i >= 0) return i;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b));
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const None = ({ text = "Empty" }: { text?: string }) => <span className="ov-none">{text}</span>;
const isSwatch = (v: unknown): v is ColourSwatch => typeof v === "object" && v !== null && typeof (v as ColourSwatch).hex === "string";

/** One version of a change's value. */
function Value({ c, v, show }: { c: Change; v: unknown; show: Show }) {
  const bundle = useStore((s) => s.bundle)!;
  if (c.kind === "added" || c.kind === "removed") return v ? <span>In the show</span> : <None text="Not in the show" />;
  if (c.kind === "archived" || c.kind === "restored") return <span>{v === "archive" ? "In the archive" : "In the running order"}</span>;
  if (c.kind === "order") return <ol className="ov-order">{(v as string[]).map((id) => <li key={id}>{show.songs[id]?.fields.name || "Untitled song"}</li>)}</ol>;
  if (isEmpty(v)) return <None />;
  if (c.image) {
    const paths = (Array.isArray(v) ? v : [v]).filter((p): p is string => typeof p === "string");
    return <span className="ov-thumbs">{paths.slice(0, 6).map((p) => <img key={p} src={backend.mediaUrl(bundle, p)} alt="" />)}{paths.length > 6 && <span>+{paths.length - 6}</span>}</span>;
  }
  if (typeof v === "string" || typeof v === "number") return <span className="ov-text">{v}</span>;
  if (typeof v === "boolean") {
    if (c.paths[0].includes("statuses")) return <span>{v ? "Ticked" : "Not ticked"}</span>;
    if (c.paths[0].includes("segues_into_next")) return <span>{v ? "Segues into the next song" : "No segue"}</span>;
    return <span>{v ? "Yes" : "No"}</span>;
  }
  if (Array.isArray(v) && v.every(isSwatch)) {
    return <span className="ov-swatches">{v.map((sw, i) => <span key={i}><i style={{ background: sw.hex }} />{sw.label || sw.hex}</span>)}</span>;
  }
  if (Array.isArray(v)) return <span>{plural(v.length, c.label === "Clips" ? "clip" : "item")}</span>;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return <span className="ov-text">“{o.text}”{typeof o.from === "string" && <span className="ov-from"> {o.from}</span>}{o.done === true && <span className="ov-from"> · Resolved</span>}</span>;
    const name = [o.label, o.name].find((x) => typeof x === "string" && x);
    return <span className="ov-text">{name ? String(name) : "Changed"}</span>;
  }
  return <span>Changed</span>;
}

/** One version of a change, as a card to pick: green once picked (it's kept), red once the other is (it's lost). */
function Side({ c, v, show, title, sub, state, onPick, disabled, empty }: {
  c: Change; v: unknown; show: Show; title: string; sub: string; state: "won" | "lost" | "open"; onPick?: () => void; disabled?: boolean; empty?: string;
}) {
  const body = isEmpty(v) && c.kind === "value" ? <None text={empty} /> : <Value c={c} v={v} show={show} />;
  const inner = <>
    <span className="ov-side-head">
      {onPick && <span className="ov-radio">{state === "won" && <Icon name="check" size="sm" />}</span>}
      <b>{title}</b><span>{sub}</span>
      {state === "won" && <em>Kept</em>}{state === "lost" && <em>Lost</em>}
    </span>
    <span className="ov-side-value">{body}</span>
  </>;
  return onPick
    ? <button className={`ov-side ${state}`} onClick={onPick} disabled={disabled} aria-pressed={state === "won"}>{inner}</button>
    : <div className="ov-side view">{inner}</div>;
}

export function OfflineReviewDialog({ onClose }: { onClose: () => void }) {
  const bundle = useStore((s) => s.bundle)!;
  const [local] = useState(() => useStore.getState().show!);
  const [review, setReview] = useState<OfflineReview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    reviewOffline(bundle, local).then((r) => {
      if (!live) return;
      setReview(r);
      const clash = clashes(r);
      // Changes nobody else touched start as yours; a clash waits for someone to pick.
      setChoices(Object.fromEntries(r.mine.filter((c) => !clash.has(c.id)).map((c) => [c.id, "keep" as Choice])));
    }, (e) => live && setError(message(e)));
    return () => { live = false; };
  }, [bundle, local]);

  const mine = review?.mine ?? [];
  const theirs = new Map(review?.theirs.map((c) => [c.id, c]));
  const clash = review ? clashes(review) : new Set<string>();
  const others = review?.theirs.filter((c) => !clash.has(c.id)) ?? [];
  const undecided = mine.filter((c) => !choices[c.id]).length;
  const thrown = new Set(mine.filter((c) => choices[c.id] === "throw").map((c) => c.id));
  const kept = mine.length - thrown.size - undecided;
  const choose = (ids: string[], choice: Choice) => setChoices((cur) => ({ ...cur, ...Object.fromEntries(ids.map((id) => [id, choice])) }));
  const where = (c: Change | undefined) => (c?.via === "sheet" ? "Google Sheet" : "Google Drive");

  async function finish() {
    if (!review || undecided) return;
    setBusy(true);
    setError(null);
    try {
      if (kept === 0) await discardOffline(bundle);
      else await approveOffline(bundle, settle(review, local, thrown));
      useStore.getState().toast(kept === 0 ? "Your offline changes are thrown away" : `Uploaded ${plural(kept, "change")} to Google Drive${thrown.size ? `, threw away ${thrown.size}` : ""}`);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wide ov" role="dialog" aria-label="Changes made offline">
        <div className="modal-head">
          <div><h3>Changes made offline</h3><p>For each change, pick the version the show should have. <span className="ov-key won">Green</span> is kept, <span className="ov-key lost">red</span> is lost.</p></div>
          <button className="icon" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          {!review && !error && <p className="ov-wait"><span className="spinner" /> Comparing with Google Drive and the Google Sheet…</p>}
          {review && !review.sheetChecked && (
            <p className="ov-alert"><Icon name="alert" size="sm" /><span>The Google Sheet couldn't be read, so edits typed there since you went offline aren't shown.</span></p>
          )}
          {clash.size > 0 && (
            <p className="ov-alert"><Icon name="alert" size="sm" />
              <span><b>Someone else changed {clash.size === 1 ? "something you changed" : `${clash.size} things you changed`}</b> while you were offline. Pick whose version to keep before you upload.</span></p>
          )}
          {review && !mine.length && <p className="ov-wait">Nothing in the show is different from Google Drive.</p>}
          {mine.length > 0 && (
            <div className="ov-files">
              {bySong(mine, local, review!.base).map(([song, changes]) => (
                <section key={song ?? "show"} className="ov-file">
                  <header className="ov-file-head"><b>{song ? songName(changes[0], local, review!.base) : "The show"}</b></header>
                  {changes.map((c) => {
                    const choice = choices[c.id];
                    const other = theirs.get(c.id);
                    const state = (side: Choice) => (!choice ? "open" : choice === side ? "won" : "lost");
                    return (
                      <div key={c.id} className={`ov-change ${other ? "clash" : ""}`}>
                        <div className="ov-label">{c.label}{other && <span className="ov-tag">Changed by someone else too</span>}</div>
                        <div className="ov-pick">
                          <Side c={c} v={valueIn(c, review!.drive)} show={review!.drive} state={state("throw")} onPick={() => choose([c.id], "throw")} disabled={busy}
                                title={other ? where(other) : "Google Drive"} sub={other ? "their edit, while you were offline" : "as it was before you went offline"} />
                          <Side c={c} v={valueIn(c, local)} show={local} state={state("keep")} onPick={() => choose([c.id], "keep")} disabled={busy}
                                title="Yours" sub="changed on this Mac, offline" empty="Empty: you cleared it" />
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="ov-theirs">
              <h4>Also changed by others while you were offline</h4>
              <p>These don't touch your changes, and they stay whatever you pick above. Nothing to do here.</p>
              <div className="ov-files">
                {bySong(others, review!.drive, review!.base).map(([song, changes]) => (
                  <section key={song ?? "show"} className="ov-file view">
                    <header className="ov-file-head"><b>{song ? songName(changes[0], review!.drive, review!.base) : "The show"}</b></header>
                    {changes.map((c) => (
                      <div key={c.id} className="ov-change">
                        <div className="ov-label">{c.label}<span className="ov-where">in {c.via === "sheet" ? "the Google Sheet" : "Google Drive"}</span></div>
                        <div className="ov-pick view">
                          <Side c={c} v={valueIn(c, review!.base)} show={review!.base} state="open" title="Before" sub="" />
                          <span className="ov-arrow"><Icon name="arrowR" size="sm" /></span>
                          <Side c={c} v={valueIn(c, review!.drive)} show={review!.drive} state="open" title="Now" sub="" />
                        </div>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </div>
        <div className="modal-foot">
          {mine.length > 0 && <span className="hint">{undecided ? `Pick a version for ${plural(undecided, "clash")} to go on` : thrown.size ? `Uploading ${kept} of ${mine.length}: ${thrown.size} of yours will be thrown away` : `Uploading all ${plural(kept, "change")}`}</span>}
          <button onClick={onClose} disabled={busy}>Not yet</button>
          {review && (kept === 0 && mine.length > 0 && !undecided
            ? <button className="primary danger-fill" onClick={finish} disabled={busy}>{busy ? "Throwing away…" : "Throw away all of mine"}</button>
            : <button className="primary" onClick={finish} disabled={busy || undecided > 0}>{busy ? "Uploading…" : mine.length ? "Upload" : "Done"}</button>)}
        </div>
      </div>
    </div>
  );
}

/**
 * Things changed here and by someone else at the same time, while online (in Drive, or typed in the Google Sheet). Yours
 * were kept, and are in Drive and the Sheet; for each, pick the version the show should have.
 */
export function ClashDialog({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const drive = useStore((s) => s.clashes);
  const me = useStore((s) => s.user?.email);
  const list = useMemo(() => openClashes(show, drive, me), [show, drive, me]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const undecided = list.filter((c) => !choices[c.change.id]).length;
  const taken = list.filter((c) => choices[c.change.id] === "throw");
  const choose = (id: string, choice: Choice) => setChoices((cur) => ({ ...cur, [id]: choice }));
  const byId = new Map(list.map((c) => [c.change.id, c]));
  const where = (c: Clash) => (c.change.via === "sheet" ? "Google Sheet" : "Google Drive");

  function finish() {
    if (undecided) return;
    const st = useStore.getState();
    const sheet = list.flatMap((c) => c.sheetKeys ?? []);
    // Settled Sheet edits: no longer a clash, and seen (so the next pull doesn't find them again, and the push puts
    // yours back in the Sheet if you kept it).
    const seen = (s: Show) => {
      const conflicts = { ...(s.conflicts ?? {}) } as Record<string, { sheet: string | boolean }>;
      const published = { ...s.google?.published };
      for (const key of sheet) {
        if (conflicts[key]) published[key] = conflicts[key].sheet;
        delete conflicts[key];
      }
      s.conflicts = conflicts;
      s.google = { ...s.google, published };
    };
    if (taken.length) {
      st.update((s) => {
        for (const c of taken) putBack(c.theirs, s, [c.change], new Set([c.change.id]));
        if (sheet.length) seen(s);
      });
    } else if (sheet.length) {
      st.updateQuiet(seen);
    }
    st.settleClashes(list.map((c) => c.change.id));
    if (sheet.length) syncNow(true);
    if (list.length) st.toast(taken.length ? `Took ${plural(taken.length, "change")} from someone else${taken.length < list.length ? `, kept ${list.length - taken.length} of yours` : ""}` : "Kept your changes");
    onClose();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide ov" role="dialog" aria-label="Changes that clashed">
        <div className="modal-head">
          <div><h3>Changes that clashed</h3><p>For each change, pick the version the show should have. <span className="ov-key won">Green</span> is kept, <span className="ov-key lost">red</span> is lost.</p></div>
          <button className="icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          {list.length > 0 && (
            <p className="ov-alert"><Icon name="alert" size="sm" />
              <span><b>Someone else changed {list.length === 1 ? "something you changed" : `${list.length} things you changed`}</b> at the same time as you. Yours are kept for now, and everyone sees them, until you pick.</span></p>
          )}
          {!list.length && <p className="ov-wait">Nothing clashes any more.</p>}
          {list.length > 0 && (
            <div className="ov-files">
              {bySong(list.map((c) => c.change), show, ...list.map((c) => c.theirs)).map(([song, changes]) => (
                <section key={song ?? "show"} className="ov-file">
                  <header className="ov-file-head"><b>{song ? songName(changes[0], show, byId.get(changes[0].id)!.theirs) : "The show"}</b></header>
                  {changes.map((c) => {
                    const clash = byId.get(c.id)!;
                    const choice = choices[c.id];
                    const state = (side: Choice) => (!choice ? "open" : choice === side ? "won" : "lost");
                    return (
                      <div key={c.id} className="ov-change clash">
                        <div className="ov-label">{c.label}<span className="ov-tag">Changed by someone else too</span></div>
                        <div className="ov-pick">
                          <Side c={c} v={valueIn(c, clash.theirs)} show={clash.theirs} state={state("throw")} onPick={() => choose(c.id, "throw")}
                                title={where(clash)} sub="their edit" />
                          <Side c={c} v={valueIn(c, show)} show={show} state={state("keep")} onPick={() => choose(c.id, "keep")}
                                title="Yours" sub="changed on this Mac" empty="Empty: you cleared it" />
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {list.length > 0 && <span className="hint">{undecided ? `Pick a version for ${plural(undecided, "clash")} to go on` : taken.length ? `Taking ${taken.length} of theirs, keeping ${list.length - taken.length} of yours` : "Keeping all of yours"}</span>}
          {list.length > 0 && <button onClick={onClose}>Decide later</button>}
          <button className="primary" onClick={finish} disabled={undecided > 0}>Done</button>
        </div>
      </div>
    </div>
  );
}

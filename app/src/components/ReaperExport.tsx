// The Running order's REAPER project button: choose the clip tracks to put in, then the progress while the clips
// download before REAPER opens.
import { useState } from "react";
import { reaperChoices, type ClipChoice } from "../model/reaper";
import { chooseReaperPath, exportToReaper, type ReaperStep } from "../reaper";
import { useStore } from "../store";
import { Icon } from "./icons";

/** A record's songs, for telling records with the same name apart: "INTRO", "SO U KNO, BMW", "INTRO + 7 more". */
const songList = (songs: string[]) => (songs.length <= 2 ? songs.join(", ") : `${songs[0]} + ${songs.length - 1} more`);

/** The records left out last time, by show, so the next export starts from the same choice. */
const leftOut = new Map<string, Set<string>>();

export function ReaperButton() {
  const show = useStore((s) => s.show)!;
  const toast = useStore((s) => s.toast);
  const [choices, setChoices] = useState<ClipChoice[] | null>(null); // choosing the tracks
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // categories showing their records
  const [step, setStep] = useState<ReaperStep | "start" | null>(null); // making it
  const [error, setError] = useState<string | null>(null);

  function open() {
    const found = reaperChoices(show);
    const out = leftOut.get(show.id) ?? new Set();
    setInclude(new Set(found.flatMap((c) => c.records.map((r) => r.id)).filter((id) => !out.has(id))));
    setChoices(found);
    setExpanded(new Set());
    setError(null);
  }

  async function make() {
    const dest = await chooseReaperPath();
    if (!dest || !choices) return;
    leftOut.set(show.id, new Set(choices.flatMap((c) => c.records.map((r) => r.id)).filter((id) => !include.has(id))));
    setError(null);
    setStep("start");
    try {
      toast(await exportToReaper(dest, include, setStep));
      close();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    }
  }

  function close() {
    setChoices(null);
    setStep(null);
    setError(null);
  }

  const toggle = (ids: string[], on: boolean) => setInclude((was) => {
    const next = new Set(was);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    return next;
  });

  const downloading = step !== null && step !== "start" && step.step === "download" ? step : null;
  const fraction = downloading ? downloading.done / downloading.total : step !== null && step !== "start" ? 1 : 0;
  const n = show.set_order.length;
  return (
    <>
      <button className="sm" title="A REAPER project of the running order: a marker at each song, its audio and the clip tracks you choose, with their LTC"
              disabled={choices !== null} onClick={open}><Icon name="wave" size="sm" /> REAPER project…</button>
      {choices && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && step === null && close()}>
          <div className="modal narrow" role="dialog" aria-label="Make a REAPER project">
            <div className="modal-head"><div>
              <h3>{error ? "Couldn't make the REAPER project" : step !== null ? "Making the REAPER project" : "Make a REAPER project"}</h3>
              <p>{error ?? (step === null
                ? `The ${n} song${n === 1 ? "" : "s"} in the running order, with a marker at each, its audio and LTC. Which clip tracks should it have?`
                : downloading ? `Downloading clips from Google Drive: ${downloading.done} of ${downloading.total}` : step !== "start" ? "Opening it in REAPER…" : "Finding the media…")}</p>
            </div></div>
            {step === null ? (
              <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {choices.length === 0 && <p className="muted" style={{ margin: 0 }}>No song in the running order has clips yet, so the project will have just the audio and markers.</p>}
                {choices.map((c) => {
                  const ids = c.records.map((r) => r.id);
                  const on = ids.filter((id) => include.has(id)).length;
                  const many = c.records.length > 1;
                  const isOpen = expanded.has(c.category);
                  return (
                    <div key={c.category}>
                      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                        {many
                          ? <button className="icon" style={{ width: 22, height: 22 }} aria-expanded={isOpen} title={isOpen ? "Hide its records" : "Show its records"}
                                    onClick={() => setExpanded((was) => { const next = new Set(was); if (isOpen) next.delete(c.category); else next.add(c.category); return next; })}>
                              <Icon name={isOpen ? "chevDown" : "chevR"} size="sm" />
                            </button>
                          : <span style={{ width: 22, flex: "none" }} />}
                        <label className="check" style={{ flex: 1, minWidth: 0 }}>
                          <input type="checkbox" checked={on === ids.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < ids.length; }}
                                 onChange={() => toggle(ids, on < ids.length)} />
                          <span className="dot" style={{ color: c.colour, width: 10, height: 10 }} />
                          <span style={{ fontWeight: 500 }}>{c.name}</span>
                          <span className="muted small">{many ? `${on === ids.length ? "" : `${on} of `}${c.records.length} records` : `${c.records[0].label} · ${songList(c.records[0].songs)}`}</span>
                        </label>
                      </div>
                      {many && isOpen && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "6px 0 2px 50px" }}>
                          {c.records.map((r) => (
                            <label key={r.id} className="check" title={r.songs.join(", ")}>
                              <input type="checkbox" checked={include.has(r.id)} onChange={(e) => toggle([r.id], e.target.checked)} />
                              <span style={{ flex: "none" }}>{r.label}</span>
                              <span className="muted small" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{songList(r.songs)}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : !error && (
              <div className="modal-body">
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}><i style={{ width: `${Math.max(3, fraction * 100)}%` }} /></div>
              </div>
            )}
            {(step === null || error) && (
              <div className="modal-foot">
                {step === null && choices.length > 0 && <span className="hint">Clips not on this Mac download from Google Drive first</span>}
                <button onClick={close}>{error ? "Close" : "Cancel"}</button>
                <button className="primary" onClick={make}>{error ? "Try again" : "Save…"}</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

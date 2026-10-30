// Export the running order as a REAPER project (see model/reaper.ts): download the clips it uses that aren't on this
// Mac yet, then write it and open it in REAPER.
import { backend } from "./backend";
import { bundleName } from "./model/ops";
import { reaperFiles, reaperProject, reaperSet } from "./model/reaper";
import { useStore } from "./store";

/** What the export is doing: downloading clips (files done, of how many), or opening REAPER. */
export type ReaperStep = { step: "download"; done: number; total: number } | { step: "open" };

const FETCH_BATCH = 4;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Ask where to save the project. Null if that's cancelled. */
export async function chooseReaperPath(): Promise<string | null> {
  const show = useStore.getState().show;
  return show ? backend.chooseSavePath(`${bundleName(show.name)}.rpp`, "Save the REAPER project") : null;
}

/**
 * Make the project at `dest`, with the clips cut from the records in `include`, and open it in REAPER once every clip
 * it uses is on this Mac. A clip that won't download stops it, so REAPER never opens with media missing. Returns what
 * to tell the user.
 */
export async function exportToReaper(dest: string, include: Set<string>, onStep: (s: ReaperStep) => void): Promise<string> {
  const { show, bundle } = useStore.getState();
  if (!show || !bundle) throw new Error("No show is open");
  const files = reaperFiles(show, bundle);
  const local = await backend.pathsLocal(files);
  const here = new Set(files.filter((_, i) => local[i]));
  const set = reaperSet(show, bundle, (p) => here.has(p), (id) => include.has(id));
  const notes: string[] = [];
  for (let i = 0; i < set.download.length; i += FETCH_BATCH) {
    onStep({ step: "download", done: i, total: set.download.length });
    notes.push(...(await backend.driveFetch(bundle, set.download.slice(i, i + FETCH_BATCH), true)));
  }
  if (notes.length) throw new Error(`${plural(notes.length, "clip")} didn't download from Google Drive: ${notes.slice(0, 2).join(" · ")}`);
  onStep({ step: "open" });
  await backend.writeProject(dest, reaperProject(set), true);
  const left = [
    set.missing.length && `${plural(set.missing.length, "audio file")} not on this Mac`,
    set.uncut && `${plural(set.uncut, "marked song")} with no clip`,
  ].filter(Boolean);
  return `Saved “${dest.split("/").pop()}”: ${plural(show.set_order.length, "song")}${left.length ? ` · left out ${left.join(", ")}` : ""}`;
}

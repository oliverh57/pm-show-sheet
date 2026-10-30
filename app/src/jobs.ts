// Background clip jobs: after songs are marked in a show record, cut a 720p clip per song (each takes its best frame
// as its still), or make no clips and line up each song's best few frames so someone picks its still (StillPicker, the
// import flow's last step). One song at a time. Progress shows on the import page and keeps going if the user moves on.
// Results are added to the show only if it's still the open one.
import { backend } from "./backend";
import { trashMedia } from "./drive/media";
import { addClip, addImages, addRecordStill, burnsTc, categoryFree, clipCategory, clipLength, clipName, clipTimeAt, GENERAL, newId, recordClipName, recordStillOf, recordTimeAt, setHero, setSongImage, type Cut } from "./model/ops";
import type { Show, SongMark, SourceRecord } from "./model/types";
import { type StillPick, useStore } from "./store";

/** How many frames each song offers to pick its still from. */
const CHOICES = 3;

/** The runs so far: a record split while another's clips are still being cut waits its turn behind them. */
let previous: Promise<void> = Promise.resolve();

export function runClipJobs(bundle: string, record: SourceRecord, marks: SongMark[], grabStills: boolean, makeClips = true): Promise<void> {
  const { show, setJobs } = useStore.getState();
  if (!show) return Promise.resolve();
  const queue = marks.map((m) => ({ mark: m, id: newId("job"), name: recordClipName(show, record, m.song_id) }));
  const kind = makeClips ? "clip" as const : "thumbnail" as const;
  const added = queue.map((q) => ({ id: q.id, label: show.songs[q.mark.song_id]?.fields.name || "Song", recordId: record.id, kind, progress: 0, status: "queued" as const }));
  // Listed after the jobs still going (several records split one after another), else in place of the finished ones.
  setJobs((jobs) => (jobs.some((j) => j.status === "queued" || j.status === "running") ? [...jobs, ...added] : added));
  const run = previous.then(() => cutClips(bundle, record, queue, grabStills, makeClips));
  previous = run.catch(() => {});
  return run;
}

async function cutClips(bundle: string, record: SourceRecord, queue: { mark: SongMark; id: string; name: string }[], grabStills: boolean, makeClips: boolean) {
  const { setJobs } = useStore.getState();
  const patch = (id: string, change: Partial<{ progress: number; status: "running" | "done" | "error"; error: string }>) =>
    setJobs((jobs) => jobs.map((j) => (j.id === id ? { ...j, ...change } : j)));
  const stillOpen = () => useStore.getState().bundle === bundle;
  const ltc = record.ltc?.channel ?? null; // clips keep the LTC, on one side, and say so in their name
  const burn = burnsTc(record);
  // The burned-in card names the song and its place in the running order ("03 GOOD LIES"). A clip with pauses cut
  // out of it says GAP CUT where it jumps, with the card or without.
  const burnIn = (songId: string, cut: boolean) => {
    const s = useStore.getState().show;
    if (!(burn || cut) || !record.ltc || !s) return null;
    const at = s.set_order.indexOf(songId);
    return { fps: record.ltc.fps ?? 25, blocks: record.ltc.blocks, song: s.songs[songId]?.fields.name ?? "", number: at >= 0 ? String(at + 1).padStart(2, "0") : null, tc: burn };
  };

  for (const { mark, id, name } of queue) {
    if (!stillOpen()) return;
    patch(id, { status: "running" });
    try {
      // A song that already has a still from this record keeps it (and its clip uses it) rather than getting another.
      const had = recordStillOf(useStore.getState().show!, record.id, mark.song_id);
      let clip: string | null = null;
      if (makeClips) {
        const path = await backend.cutClip(id, bundle, record.path, mark.in, mark.out, mark.cuts ?? [], name, ltc, burnIn(mark.song_id, Boolean(mark.cuts?.length)),
          (f) => patch(id, { progress: f * (grabStills ? 0.8 : 1) }));
        if (!stillOpen()) return;
        clip = path;
        // A clip cut before under another name (before clips kept their LTC) goes to the Trash.
        const replaced = (useStore.getState().show?.songs[mark.song_id]?.clips ?? []).filter((c) => c.record_id === record.id && c.in === mark.in && c.path !== path);
        await trashMedia(bundle, replaced.map((c) => c.path)).catch(() => {});
        useStore.getState().update((s) => {
          const kept = replaced.find((c) => c.still)?.still ?? had;
          addClip(s, mark.song_id, { path, record_id: record.id, in: mark.in, out: mark.out, source: mark.source, ...(mark.cuts?.length ? { cuts: mark.cuts } : {}),
            ...(kept ? { still: kept } : {}), ...(burn ? { burn_tc: true } : {}) });
        });
      }
      if ((grabStills || !makeClips) && !had) await queuePick(bundle, record, mark.song_id, mark, clip, !makeClips);
      patch(id, { status: "done", progress: 1 });
    } catch (e) {
      patch(id, { status: "error", error: String(e) });
    }
  }
}

/**
 * Find a song's best few frames (bright, sharp, colourful: see src-tauri/src/thumbs.rs). They're judged on the song's
 * 720p clip when there is one (quicker to read), else on the record. With `ask`, they're lined up for someone to pick
 * the song's still from, and a song with no still yet uses the top frame until someone picks; otherwise the top frame
 * is simply used.
 */
async function queuePick(bundle: string, record: SourceRecord, songId: string, mark: Cut, clip: string | null, ask: boolean, replaces?: string) {
  const found = await findFrames(bundle, record, mark, clip);
  if (useStore.getState().bundle !== bundle) return;
  const candidates = found.length ? found : [{ time: mark.in + Math.min(5, (mark.out - mark.in) / 2), path: "", score: 0 }];
  const pick: StillPick = { id: newId("pick"), songId, recordId: record.id, mark, candidates, replaces };
  if (!ask) {
    await fileStill(bundle, record, pick, candidates[0].time);
    return;
  }
  if (!replaces) {
    const still = await fileStill(bundle, record, pick, candidates[0].time).catch(() => null);
    if (useStore.getState().bundle !== bundle) return;
    if (still) Object.assign(pick, { replaces: still, current: candidates[0].time, auto: true });
  }
  useStore.getState().setStillPicks((picks) => [...picks.filter((p) => !(p.songId === songId && p.recordId === record.id)), pick]);
}

/** A song's best few frames, with times into the record. */
async function findFrames(bundle: string, record: SourceRecord, mark: Cut, clip: string | null) {
  return clip
    ? (await backend.thumbCandidates(`${bundle}/${clip}`, 0, clipLength(mark), CHOICES).catch(() => [])).map((c) => ({ ...c, time: recordTimeAt(mark, c.time) }))
    : await backend.thumbCandidates(record.path, mark.in, mark.out, CHOICES).catch(() => []);
}

/**
 * Pick a song's still from a record again, in place of `still` (clicking it on the Media page, or Change in the song's
 * Media tab). The picker opens straight away, with its scrubber; the suggested frames follow. Once it's picked, `back`
 * (else the Media page). An earlier one of these left unpicked is dropped, so the picker shows just this one.
 * When the record isn't on this Mac (deleted, or added on another), the frames come from the song's clip of it.
 * False when the song isn't marked in the record, or the record's gone and the song has no clip of it.
 */
export async function repickStill(bundle: string, record: SourceRecord, songId: string, still: string, back?: () => void): Promise<boolean> {
  const { show, setStillPicks, openPicks } = useStore.getState();
  const clips = (show?.songs[songId]?.clips ?? []).filter((c) => c.record_id === record.id);
  const clip = clips.find((c) => c.still === still) ?? clips[0];
  const [here, clipHere] = await backend.pathsExist([record.path, clip ? `${bundle}/${clip.path}` : ""]).catch(() => [true, true]);
  // Without the record, the clip's own in and out (and cuts): its frames are all there is.
  const mark = here ? record.song_marks?.find((m) => m.song_id === songId) ?? clip : clip;
  if (!mark) return false;
  const id = newId("pick");
  const oneOff = (p: StillPick) => p.replaces && !p.auto && !p.saving;
  setStillPicks((picks) => [...picks.filter((p) => !(p.songId === songId && p.recordId === record.id) && !oneOff(p)),
    { id, songId, recordId: record.id, mark: { in: mark.in, out: mark.out, ...(mark.cuts ? { cuts: mark.cuts } : {}) }, candidates: [], replaces: still, finding: true, ...(here ? {} : { clip: clip!.path }) }]);
  openPicks(id, back);
  // The clip's quicker to read, but not when it's only in Drive and the record's here: it would download first.
  const found = await findFrames(bundle, record, mark, clip && (clipHere || !here) ? clip.path : null);
  if (useStore.getState().bundle !== bundle) return true;
  setStillPicks((picks) => picks.map((p) => (p.id === id ? { ...p, candidates: found, finding: false } : p)));
  return true;
}

/** Grab a frame from the record at full size and file it in the record's category, in place of the pick's still. */
async function fileStill(bundle: string, record: SourceRecord, pick: StillPick, time: number): Promise<string | null> {
  const show = useStore.getState().show;
  if (!show) return null;
  const still = pick.clip
    ? await backend.grabFrame(bundle, `${bundle}/${pick.clip}`, Math.max(0, clipTimeAt(pick.mark, time)), clipName(show, pick.songId))
    : await backend.grabFrame(bundle, record.path, time, clipName(show, pick.songId));
  if (useStore.getState().bundle !== bundle) return null;
  useStore.getState().update((s) => {
    if (!s.songs[pick.songId]) return;
    const clip = s.songs[pick.songId].clips?.find((c) => c.record_id === record.id && Math.abs(c.in - pick.mark.in) < 0.5);
    const col = clip ? clipCategory(s, clip) : record.image_col ?? GENERAL;
    if (pick.replaces) replaceStill(s, pick.songId, pick.replaces, still, col);
    else addImages(s, pick.songId, [still], col);
    const rec = s.records?.find((r) => r.id === record.id);
    // The still it replaces (the top frame used while waiting, or one picked before) isn't the record's any more: no
    // song uses it, so it's binned with other unused stills.
    if (rec && pick.replaces) rec.stills = (rec.stills ?? []).filter((p) => p !== pick.replaces);
    addRecordStill(s, record.id, still);
    for (const c of s.songs[pick.songId].clips ?? []) if (c.record_id === record.id && Math.abs(c.in - pick.mark.in) < 0.5) c.still = still;
  });
  return still;
}

/** Use the frame someone picked. The one the song already uses just closes the pick. False if it couldn't be saved. */
export async function pickStill(bundle: string, pickId: string, time: number): Promise<boolean> {
  const { show, stillPicks, setStillPicks } = useStore.getState();
  const pick = stillPicks.find((p) => p.id === pickId);
  const record = show?.records?.find((r) => r.id === pick?.recordId);
  if (!show || !pick || !record || pick.saving) return false;
  if (pick.current === time) {
    setStillPicks((picks) => picks.filter((p) => p.id !== pickId));
    return true;
  }
  setStillPicks((picks) => picks.map((p) => (p.id === pickId ? { ...p, saving: true } : p)));
  try {
    if (!(await fileStill(bundle, record, pick, time))) return false;
    setStillPicks((picks) => picks.filter((p) => p.id !== pickId));
    return true;
  } catch (e) {
    setStillPicks((picks) => picks.map((p) => (p.id === pickId ? { ...p, saving: false } : p)));
    useStore.getState().toast(String(e).replace(/^Error: /, ""));
    return false;
  }
}

/** Take each waiting song's top-scoring frame. */
export async function pickTopStills(bundle: string) {
  for (const p of useStore.getState().stillPicks) if (!p.saving && p.candidates.length) await pickStill(bundle, p.id, p.candidates[0].time);
}

/** Swap a song's still for a new one, keeping its place in the gallery (and in its image column). */
export function replaceStill(show: Show, songId: string, old: string | null, still: string, colId = GENERAL) {
  const sg = show.songs[songId];
  const gallery = sg.gallery ?? (sg.hero ? [sg.hero] : []);
  sg.gallery = [...new Set(old && gallery.includes(old) ? gallery.map((p) => (p === old ? still : p)) : [still, ...gallery])];
  if (old) for (const [col, p] of Object.entries(sg.images ?? {})) if (p === old) sg.images![col] = still;
  if (old && sg.hero === old) setHero(show, songId, still);
  else if (categoryFree(show, sg, colId)) setSongImage(show, songId, colId, still);
  if (!sg.hero) setHero(show, songId, still);
  for (const c of sg.clips ?? []) if (old && c.still === old) c.still = still;
}

/** Choose the best frame again for every clip from a record, as each song's still. */
export async function repickStills(bundle: string, record: SourceRecord, onProgress: (done: number, total: number) => void): Promise<number> {
  const show = useStore.getState().show;
  if (!show) return 0;
  const clips = Object.entries(show.songs).flatMap(([songId, s]) => (s.clips ?? []).filter((c) => c.record_id === record.id).map((c) => ({ songId, c })));
  let done = 0;
  for (const { songId, c } of clips) {
    onProgress(done, clips.length);
    if (useStore.getState().bundle !== bundle) return done;
    await queuePick(bundle, record, songId, c, c.path, false, c.still).catch(() => {});
    done++;
  }
  onProgress(clips.length, clips.length);
  return done;
}

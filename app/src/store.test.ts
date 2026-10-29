import { describe, expect, it } from "vitest";
import sample from "./model/sample_show.json";
import type { Show, SourceRecord } from "./model/types";
import { pickLive, type StillPick, useStore } from "./store";

const songId = (sample as unknown as Show).set_order[0];
const show = (): Show => {
  const s = structuredClone(sample) as unknown as Show;
  s.records = [{ id: "rec", path: "/elsewhere/show.mov", name: "show.mov", scope: "show" } as SourceRecord];
  s.songs[songId].clips = [{ path: "media/clips/a.mp4", record_id: "rec", in: 10, out: 200, source: "manual" }];
  return s;
};
const pick = (extra: Partial<StillPick> = {}): StillPick => ({ id: "p", songId, recordId: "rec", mark: { in: 10, out: 200 }, candidates: [], ...extra });

describe("thumbnails to pick", () => {
  it("are live while their song, record and clip are in the show", () => {
    expect(pickLive(show(), pick())).toBe(true);
    expect(pickLive(show(), pick({ clip: "media/clips/a.mp4" }))).toBe(true);
  });

  it("aren't once the record, the clip or the song is gone", () => {
    const noRecord = show(); noRecord.records = [];
    const noClip = show(); noClip.songs[songId].clips = [];
    const noSong = show(); delete noSong.songs[songId];
    expect(pickLive(noRecord, pick())).toBe(false);
    expect(pickLive(noClip, pick({ clip: "media/clips/a.mp4" }))).toBe(false);
    expect(pickLive(noSong, pick())).toBe(false);
  });

  it("are dropped when someone deletes the clip on another Mac", () => {
    useStore.getState().load(show(), "/tmp/show");
    useStore.getState().setStillPicks(() => [pick({ clip: "media/clips/a.mp4" }), pick({ id: "q" })]);
    useStore.getState().update((s) => { s.songs[songId].clips = []; });
    expect(useStore.getState().stillPicks.map((p) => p.id)).toEqual(["q"]);
  });
});

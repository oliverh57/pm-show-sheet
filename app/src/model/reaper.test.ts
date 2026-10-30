import { describe, expect, it } from "vitest";
import { addAudio, addClip, addRecord, addSong, addSongWith, deptCategory, ensureCategory, GENERAL, newShow } from "./ops";
import { DEPT_COLOURS } from "../google/sheet";
import { EMPTY_SONG, reaperChoices, reaperFiles, reaperProject, reaperSet, rppColour, rppString, TRACK_COLOURS } from "./reaper";

const BUNDLE = "/shows/x";

/**
 * Three songs: two clipped from a General show record (LTC on the right; Gunk's clip starts 5 s before its TC and has
 * a 20 s pause cut out), one from an LX render (its clip 5 s after Gunk's TC; Intro's marked in it but has no clip),
 * with BPMs and show-audio TC; and an archived song with a clip.
 */
function show() {
  const s = newShow("Test");
  const a = addSongWith(s, "Intro", "01:00:00:00", "", "120");
  const b = addSongWith(s, "Gunk", "01:02:00:00", "", "120");
  const c = addSongWith(s, "Freedom", "01:05:00:00", "", "138");
  const rec = addRecord(s, { path: "/rec/nyc.mp4", scope: "show", label: "NYC T5", image_col: GENERAL, ltc: { channel: 1, fps: 25, duration: 600, blocks: [{ file_start: 0, file_end: 600, tc_start: "00:59:50:00", tc_end: "01:09:49:24" }] },
    song_marks: [{ song_id: a, in: 10, out: 100, source: "manual" }, { song_id: b, in: 125, out: 300, source: "manual", cuts: [[150, 170]] }] });
  addClip(s, a, { path: "media/clips/NYC_01 Intro_LTC-R.mp4", record_id: rec, in: 10, out: 100, source: "manual" });
  addClip(s, b, { path: "media/clips/NYC_02 Gunk_LTC-R.mp4", record_id: rec, in: 125, out: 300, cuts: [[150, 170]], source: "manual" });
  const lx = ensureCategory(s, deptCategory("LX"));
  const render = addRecord(s, { path: "/rec/depence.mp4", scope: "show", label: "DEPENCE", image_col: lx,
    ltc: { channel: null, fps: 25, duration: 100, blocks: [{ file_start: 0, file_end: 100, tc_start: "01:02:00:00", tc_end: "01:03:39:24" }] },
    song_marks: [{ song_id: a, in: 0, out: 95, source: "manual" }, { song_id: b, in: 5, out: 65, source: "manual" }] });
  addClip(s, b, { path: "media/clips/02 Gunk.mp4", record_id: render, in: 5, out: 65, source: "manual" });
  const old = addSong(s, "archive", undefined, "Old song");
  addClip(s, old, { path: "media/clips/Old song.mp4", record_id: rec, in: 300, out: 400, source: "manual" });
  addAudio(s, { path: "/audio/show.wav", scope: "show", version: "V3", info: { duration: 1000 },
    ltc: { channel: 0, fps: 25, duration: 1000, blocks: [{ file_start: 0, file_end: 1000, tc_start: "00:59:50:00", tc_end: "01:16:30:00" }] } });
  return { s, a, b, c, rec, render, lx };
}

describe("REAPER project of the set", () => {
  it("puts the songs back to back in running order, a marker and BPM at each", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    // Intro: its audio runs to the next TC (120 s), longer than its clip. Gunk: its General clip starts 5 s before its
    // TC, so that's 5 s after Intro ends; its audio runs on 180 s to Freedom's TC.
    expect(set.markers).toEqual([{ position: 0, name: "01 Intro" }, { position: 125, name: "02 Gunk" }, { position: 305, name: "03 Freedom" }]);
    expect(set.tempo).toEqual([{ position: 0, bpm: 120 }, { position: 305, bpm: 138 }]);
  });

  it("groups the audio and each category's tracks, in the show's order, with their LTC on a track of its own", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    expect(set.tracks.map((t) => [t.name, t.folder, t.ltc])).toEqual([
      ["Video", undefined, undefined], ["Audio", "parent", undefined], ["LTC", "last", true], ["General", "parent", undefined], ["General LTC", "last", true], ["LX", undefined, undefined],
    ]);
    expect(set.tracks[0]).toMatchObject({ grid: true, items: [] });
  });

  it("puts the LTC channel alone on the LTC track, lined up with the media, without the picture", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    const general = set.tracks.find((t) => t.name === "General")!.items;
    const ltc = set.tracks.find((t) => t.name === "General LTC")!.items;
    expect(ltc.map((i) => [i.position, i.offset, i.length])).toEqual(general.map((i) => [i.position, i.offset, i.length]));
    expect(ltc[0]).toMatchObject({ file: `${BUNDLE}/media/clips/NYC_01 Intro_LTC-R.mp4`, chanmode: 4, video: false, name: "Intro · NYC T5 · LTC" }); // LTC on the right
    expect(set.tracks.find((t) => t.name === "LTC")!.items[0]).toMatchObject({ file: "/audio/show.wav", chanmode: 3, offset: 10 });
  });

  it("cuts each song's part of the show audio from its TC, leaving out the LTC", () => {
    const { s } = show();
    const audio = reaperSet(s, BUNDLE, () => true).tracks.find((t) => t.name === "Audio")!.items;
    expect(audio.map((i) => [i.position, i.offset, i.length])).toEqual([[0, 10, 120], [125, 130, 180], [305, 310, 690]]);
    expect(audio[0]).toMatchObject({ file: "/audio/show.wav", chanmode: 4 }); // LTC on the left: right only
  });

  it("uses a song's own audio version before the show audio", () => {
    const { s, b } = show();
    s.songs[b].fields.audio = "V2";
    addAudio(s, { path: "/audio/gunk v2.wav", scope: "song", song_id: b, version: "V2", info: { duration: 210 } });
    addAudio(s, { path: "/audio/gunk v4.wav", scope: "song", song_id: b, version: "V4", info: { duration: 205 } });
    const audio = reaperSet(s, BUNDLE, () => true).tracks.find((t) => t.name === "Audio")!.items;
    expect(audio[1]).toMatchObject({ file: "/audio/gunk v2.wav", offset: 0, length: 210, position: 125 }); // no LTC: from the song's start
  });

  it("locks each song's clips to its TC by their LTC, across categories", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    const items = (name: string) => set.tracks.find((t) => t.name === name)!.items.map((i) => [i.position, i.offset, i.length]);
    // Gunk's TC is at 125. Its General clip comes in 5 s before, and after the 20 s pause cut out of it TC carries on
    // 20 s further, so its second stretch sits 20 s on; its LX clip comes in 5 s after.
    expect(items("General")).toEqual([[0, 0, 90], [120, 0, 25], [165, 25, 130]]);
    expect(items("LX")).toEqual([[130, 0, 60]]);
  });

  it("starts media with no LTC with the song", () => {
    const { s, b } = show();
    delete s.records![1].ltc; // the LX render
    expect(reaperSet(s, BUNDLE, () => true).tracks.find((t) => t.name === "LX")!.items[0].position).toBe(125);
    s.songs[b].clips!.find((c) => c.path.includes("02 Gunk.mp4"))!.in = 4000; s.songs[b].clips!.find((c) => c.path.includes("02 Gunk.mp4"))!.out = 4060; // LTC hours away isn't the song's timecode
    s.records![1].ltc = { channel: null, fps: 25, duration: 5000, blocks: [{ file_start: 0, file_end: 5000, tc_start: "05:00:00:00", tc_end: "06:23:20:00" }] };
    expect(reaperSet(s, BUNDLE, () => true).tracks.find((t) => t.name === "LX")!.items[0].position).toBe(125);
  });

  it("plays each song's clips (never the records), without their LTC", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    const general = set.tracks.find((t) => t.name === "General")!.items;
    expect(general[0]).toMatchObject({ file: `${BUNDLE}/media/clips/NYC_01 Intro_LTC-R.mp4`, name: "Intro · NYC T5", chanmode: 3, video: true });
    expect(set.tracks.flatMap((t) => t.items).some((i) => i.file.startsWith("/rec/"))).toBe(false);
    expect(set.uncut).toBe(1); // Intro is marked in the LX render, with no clip
  });

  it("downloads the clips that aren't on this Mac, and leaves out audio that isn't", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, (p) => p !== "/audio/show.wav" && !p.includes("Gunk"));
    const lx = set.tracks.find((t) => t.name === "LX")!.items;
    expect(lx).toEqual([expect.objectContaining({ position: 100, offset: 0, length: 60, file: `${BUNDLE}/media/clips/02 Gunk.mp4` })]); // Intro is just its clip
    expect(set.download.sort()).toEqual(["media/clips/02 Gunk.mp4", "media/clips/NYC_02 Gunk_LTC-R.mp4"]);
    expect(set.tracks.some((t) => t.name === "Audio")).toBe(false);
  });

  it("leaves the archive out", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    expect(set.markers).toHaveLength(3);
    expect(set.tracks.flatMap((t) => t.items).some((i) => i.name.startsWith("Old song"))).toBe(false);
    expect(reaperFiles(s, BUNDLE).some((p) => p.includes("Old song"))).toBe(false);
  });

  it("puts a second record of a category for one song on a track inside the category's", () => {
    const { s, a } = show();
    const la = addRecord(s, { path: "/rec/la.mp4", scope: "show", label: "LA", song_marks: [{ song_id: a, in: 0, out: 50, source: "manual" }] });
    addClip(s, a, { path: "media/clips/LA_01 Intro.mp4", record_id: la, in: 0, out: 50, source: "manual" });
    const set = reaperSet(s, BUNDLE, () => true);
    const general = set.tracks.filter((t) => t.name.startsWith("General"));
    expect(general.map((t) => [t.name, t.folder])).toEqual([["General", "parent"], ["General 2", undefined], ["General LTC", undefined], ["General 2 LTC", "last"]]);
    expect(general[0].items[0].name).toBe("Intro · LA"); // the newest record on the category's own track
  });

  it("gives a song with nothing a gap of its own", () => {
    const s = newShow("Empty");
    addSongWith(s, "One");
    addSongWith(s, "Two");
    const set = reaperSet(s, BUNDLE, () => true);
    expect(set.markers.map((m) => m.position)).toEqual([0, EMPTY_SONG]);
    expect(set.tracks).toEqual([]);
  });

  it("lists every file it could use", () => {
    const { s } = show();
    expect(reaperFiles(s, BUNDLE).sort()).toEqual(["/audio/show.wav", ...["02 Gunk.mp4", "NYC_01 Intro_LTC-R.mp4", "NYC_02 Gunk_LTC-R.mp4"].map((f) => `${BUNDLE}/media/clips/${f}`)]);
  });

  it("writes the .rpp", () => {
    const { s } = show();
    const rpp = reaperProject(reaperSet(s, BUNDLE, () => true));
    expect(rpp).toMatch(/^<REAPER_PROJECT 0\.1 /);
    expect(rpp).toContain('  MARKER 2 125 "02 Gunk" 0 0 1\n');
    expect(rpp).toContain("    PT 305 138 1\n");
    expect(rpp).toContain('      <SOURCE WAVE\n        FILE "/audio/show.wav"\n      >');
    expect(rpp).toContain(`      <SOURCE VIDEO\n        FILE "${BUNDLE}/media/clips/NYC_01 Intro_LTC-R.mp4"\n      >`);
    expect(rpp.match(/<TRACK/g)).toHaveLength(6);
    expect(rpp).toContain(`      <SOURCE VIDEO\n        VIDEO_DISABLED\n        FILE "${BUNDLE}/media/clips/NYC_01 Intro_LTC-R.mp4"\n      >`);
    expect(rpp.match(/MAINSEND 0 0/g)).toHaveLength(2); // the LTC tracks stay out of the mix
    expect(rpp.match(/ISBUS 1 1/g)).toHaveLength(2);
    expect(rpp.match(/ISBUS 2 -1/g)).toHaveLength(2);
    expect(rpp.split("\n").filter((l) => l.trim().startsWith("<")).length).toBe(rpp.split("\n").filter((l) => l.trim() === ">").length);
  });

  it("colours each group's tracks: the audio green, a category its department's band, the LTC its own", () => {
    const { s } = show();
    const set = reaperSet(s, BUNDLE, () => true);
    expect(Object.fromEntries(set.tracks.map((t) => [t.name, t.colour]))).toEqual({
      Video: TRACK_COLOURS.video, Audio: TRACK_COLOURS.audio, LTC: TRACK_COLOURS.ltc,
      General: TRACK_COLOURS.general, "General LTC": TRACK_COLOURS.ltc, LX: DEPT_COLOURS.LX,
    });
    // REAPER keeps it as 0xBBGGRR, flagged as set: the lavender LTC track in a project made in REAPER is 0x1EF9DB2.
    expect(rppColour("#B29DEF")).toBe(0x1ef9db2);
    expect(reaperProject(set)).toContain(`    NAME "LX"\n    PEAKCOL ${rppColour(DEPT_COLOURS.LX)}\n`);
  });

  it("offers each category's clip records in the running order to choose from, the newest first", () => {
    const { s, a, rec, render, lx } = show();
    const la = addRecord(s, { path: "/rec/la.mp4", scope: "show", label: "LA" });
    addClip(s, a, { path: "media/clips/LA_01 Intro.mp4", record_id: la, in: 0, out: 50, source: "manual" });
    expect(reaperChoices(s)).toEqual([
      { category: GENERAL, name: "General", colour: TRACK_COLOURS.general, records: [{ id: la, label: "LA", songs: ["Intro"] }, { id: rec, label: "NYC T5", songs: ["Intro", "Gunk"] }] }, // not the archived song's clip
      { category: lx, name: "LX", colour: DEPT_COLOURS.LX, records: [{ id: render, label: "DEPENCE", songs: ["Gunk"] }] },
    ]);
  });

  it("puts in only the chosen records' clips", () => {
    const { s, rec } = show();
    const set = reaperSet(s, BUNDLE, () => true, (id) => id === rec);
    expect(set.tracks.map((t) => t.name)).toEqual(["Audio", "LTC", "General", "General LTC"]); // one video track: no grid
    expect(set.uncut).toBe(0); // Intro's mark in the LX render doesn't count once it's left out
    expect(reaperSet(s, BUNDLE, (p) => !p.includes("Gunk"), (id) => id === rec).download).toEqual(["media/clips/NYC_02 Gunk_LTC-R.mp4"]);
  });

  it("quotes names the way REAPER does", () => {
    expect(rppString("Gem Lingo")).toBe('"Gem Lingo"');
    expect(rppString('12" mix')).toBe(`'12" mix'`);
    expect(rppString(`Don't "stop"`)).toBe('`Don\'t "stop"`');
  });
});

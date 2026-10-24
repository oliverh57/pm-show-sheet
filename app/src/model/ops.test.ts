import { describe, expect, it } from "vitest";
import sample from "./sample_show.json";
import {
  addColumn, addImages, addNote, addSong, archiveSong, cellValue, deleteSong, ltcFromName, moveColumn, moveSong,
  newShow, removeColumn, removeImage, restoreSong, setHero, setHeroCrop,
} from "./ops";
import type { Show } from "./types";
import { useStore } from "../store";

const fresh = () => structuredClone(sample) as Show;
const col = (show: Show, id: string) => show.columns.find((c) => c.id === id)!;

describe("cell values", () => {
  it("shows Cont. in the TC column after a segue, keeping any TC start", () => {
    const show = fresh();
    expect(show.songs.s_summer.segues_into_next).toBe(true);
    show.songs.s_seven.fields.tc = "";
    expect(cellValue(show, col(show, "tc"), show.songs.s_seven)).toBe("Cont.");
    show.songs.s_seven.fields.tc = "10:00:00:00";
    expect(cellValue(show, col(show, "tc"), show.songs.s_seven)).toBe("10:00:00:00 (Cont.)");
    expect(cellValue(show, col(show, "tc"), show.songs.s_summer)).toBe("09:00:00:00");
  });
  it("reads ticks and swatch labels", () => {
    const show = fresh();
    expect(cellValue(show, col(show, "st_viz"), show.songs.s_lights)).toBe(true);
    expect(cellValue(show, col(show, "colour_1"), show.songs.s_lights)).toBe("L106");
    expect(cellValue(show, col(show, "colour_3"), show.songs.s_lights)).toBe("");
  });
  it("numbers songs by their place in the running order, not a typed-in #", () => {
    const show = fresh();
    const num = col(show, "num");
    show.songs[show.set_order[1]].fields.num = "29";
    expect(cellValue(show, num, show.songs[show.set_order[1]])).toBe("02");
    moveSong(show, show.set_order[1], "set_order", 0);
    expect(cellValue(show, num, show.songs[show.set_order[0]])).toBe("01");
    expect(cellValue(show, num, show.songs[show.archive[0]])).toBe("");
  });
});

describe("running order", () => {
  it("moves a song down within the set", () => {
    const show = fresh();
    moveSong(show, "s_opener", "set_order", 2);
    expect(show.set_order.slice(0, 3)).toEqual(["s_lights", "s_harbour", "s_opener"]);
  });
  it("archives to the top of the archive and restores to the end of the set", () => {
    const show = fresh();
    archiveSong(show, "s_glass");
    expect(show.set_order).not.toContain("s_glass");
    expect(show.archive[0]).toBe("s_glass");
    restoreSong(show, "s_glass");
    expect(show.set_order[show.set_order.length - 1]).toBe("s_glass");
    expect(show.archive).not.toContain("s_glass");
  });
  it("adds and deletes songs, unlinking their notes", () => {
    const show = fresh();
    const id = addSong(show, "set_order", 1, "New One");
    expect(show.set_order[1]).toBe(id);
    const noteId = addNote(show, "global", id, "hello");
    deleteSong(show, id);
    expect(show.songs[id]).toBeUndefined();
    expect(show.sessions[0].notes.find((n) => n.id === noteId)?.song_id).toBeNull();
  });
});

describe("columns", () => {
  it("adds, moves and removes columns but never the core ones", () => {
    const show = newShow("test");
    const id = addColumn(show, "Staging", "STAGING", "longtext");
    expect(show.columns[show.columns.length - 1]).toMatchObject({ id, label: "STAGING", dept: "STAGING" });
    moveColumn(show, id, -1);
    expect(show.columns[show.columns.length - 2].id).toBe(id);
    removeColumn(show, id);
    removeColumn(show, "name");
    expect(show.columns.find((c) => c.id === id)).toBeUndefined();
    expect(show.columns.find((c) => c.id === "name")).toBeDefined();
  });
});

describe("media", () => {
  it("first image becomes hero; removing the hero promotes the next", () => {
    const show = fresh();
    addImages(show, "s_glass", ["media/renders/a.jpg", "media/renders/b.jpg"]);
    expect(show.songs.s_glass.hero).toBe("media/renders/a.jpg");
    removeImage(show, "s_glass", "media/renders/a.jpg");
    expect(show.songs.s_glass.hero).toBe("media/renders/b.jpg");
  });

  it("a cropped hero goes with its photo, and picking another hero drops the crop", () => {
    const show = fresh();
    addImages(show, "s_glass", ["media/renders/a.jpg", "media/renders/b.jpg"]);
    setHeroCrop(show, "s_glass", "media/renders/a.jpg", { x: 0, y: 0.1, w: 1, h: 0.5 }, "media/crops/01 Glass.jpg");
    expect(show.songs.s_glass.hero).toBe("media/crops/01 Glass.jpg");
    setHero(show, "s_glass", "media/renders/b.jpg");
    expect(show.songs.s_glass.hero_crop).toBeUndefined();
    setHeroCrop(show, "s_glass", "media/renders/a.jpg", { x: 0, y: 0.1, w: 1, h: 0.5 }, "media/crops/01 Glass.jpg");
    removeImage(show, "s_glass", "media/renders/a.jpg");
    expect(show.songs.s_glass.hero).toBe("media/renders/b.jpg");
    expect(show.songs.s_glass.hero_crop).toBeUndefined();
  });
});

describe("store history", () => {
  it("undoes and redoes edits", () => {
    const store = useStore.getState();
    store.load(fresh(), "/tmp/x.showsheet");
    useStore.getState().update((s) => { s.songs.s_lights.fields.name = "Changed"; });
    expect(useStore.getState().show!.songs.s_lights.fields.name).toBe("Changed");
    useStore.getState().undo();
    expect(useStore.getState().show!.songs.s_lights.fields.name).toBe("Low Lights");
    useStore.getState().redo();
    expect(useStore.getState().show!.songs.s_lights.fields.name).toBe("Changed");
    expect(useStore.getState().saveState).toBe("unsaved");
  });
});

import { addAudio, groupSessions, guessSong, guessVersion, songAudio, syncAudioField } from "./ops";

describe("media helpers", () => {
  it("guesses version labels from filenames", () => {
    expect(guessVersion("/a/LTC + AUDIO - AUTUMN 2026 90' V4.1_48_24.wav")).toBe("V4.1");
    expect(guessVersion("/a/20_Song_Instr2_US_v20250609b.mov")).toBe("V20250609b");
    expect(guessVersion("/a/Low Lights 012025.wav")).toBe("012025");
    expect(guessVersion("/a/render.jpg")).toBe("");
  });
  it("suggests a song from the filename", () => {
    const show = fresh();
    expect(guessSong(show, "/x/07_Low_Lights_V3.wav")).toBe("s_lights");
    expect(guessSong(show, "/x/render_12.jpg")).toBeNull();
  });
  it("tracks song audio versions newest first and updates the field", () => {
    const show = fresh();
    addAudio(show, { path: "/a/v2.wav", scope: "song", song_id: "s_lights", version: "V2" });
    addAudio(show, { path: "/a/v3.wav", scope: "song", song_id: "s_lights", version: "V3" });
    expect(songAudio(show, "s_lights").map((a) => a.version)).toEqual(["V3", "V2"]);
    syncAudioField(show, "s_lights");
    expect(show.songs.s_lights.fields.audio).toBe("V3");
  });
  it("groups renders into sessions by time gap", () => {
    const h = 3600_000;
    const groups = groupSessions([{ modified_ms: 0 }, { modified_ms: 10 * 60_000 }, { modified_ms: 5 * h }]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });
});

describe("set lists and timecode", () => {
  it("parses a pasted set list", async () => {
    const { parseSetList } = await import("./ops");
    expect(parseSetList("1. My Own Summer (Shove It)   02:00   v3\n\n2) Rosemary 04:30:12:05 Spotify\nDiamond Eyes")).toEqual([
      { name: "My Own Summer (Shove It)", tc: "02:00:00:00", version: "V3", bpm: "" },
      { name: "Rosemary", tc: "04:30:12:05", version: "Spotify", bpm: "" },
      { name: "Diamond Eyes", tc: "", version: "", bpm: "" },
    ]);
  });
  it("follows a chosen column order, with missing columns", async () => {
    const { parseSetList } = await import("./ops");
    const rows = parseSetList("INTRO 02:00:00:00 134,\nGEM LINGO 134,\nFREEDOM 2 04:00:00:00 138,\nBMW/PIECES 22:00:00:00 134,\nOUTRO 130", ["name", "tc", "bpm"]);
    expect(rows).toEqual([
      { name: "INTRO", tc: "02:00:00:00", bpm: "134", version: "" },
      { name: "GEM LINGO", tc: "", bpm: "134", version: "" },
      { name: "FREEDOM 2", tc: "04:00:00:00", bpm: "138", version: "" },
      { name: "BMW/PIECES", tc: "22:00:00:00", bpm: "134", version: "" },
      { name: "OUTRO", tc: "", bpm: "130", version: "" },
    ]);
    expect(parseSetList("02:00 126 bpm Opener", ["tc", "bpm", "name"])[0]).toMatchObject({ name: "Opener", tc: "02:00:00:00", bpm: "126" });
    expect(parseSetList("Opener\t02:00:00:00\t126", ["name", "tc", "bpm"])[0]).toMatchObject({ name: "Opener", tc: "02:00:00:00", bpm: "126" });
  });
  it("keeps numbers that are part of a song name", async () => {
    const { parseSetList } = await import("./ops");
    expect(parseSetList("7 Words")[0].name).toBe("7 Words");
    expect(parseSetList("3. 7 Words 20:00")[0]).toMatchObject({ name: "7 Words", tc: "20:00:00:00" });
  });
  it("matches TC blocks to songs by TC start, each song once", async () => {
    const { addSongWith, matchBlocks } = await import("./ops");
    const show = newShow("T");
    const a = addSongWith(show, "A", "02:00:00:00");
    const b = addSongWith(show, "B", "01:30:00:00");
    addSongWith(show, "No TC");
    const block = (tc: string) => ({ file_start: 0, file_end: 1, tc_start: tc, tc_end: tc });
    expect(matchBlocks(show, [block("01:30:00:01"), block("02:00:00:00"), block("02:00:00:00"), block("09:00:00:00")]))
      .toEqual([b, a, null, null]);
  });
  it("turns start marks into in/out marks", async () => {
    const { marksFromStarts } = await import("./ops");
    expect(marksFromStarts([{ song_id: "b", t: 300 }, { song_id: "a", t: 10 }], 600)).toEqual([
      { song_id: "a", in: 10, out: 300, source: "manual" },
      { song_id: "b", in: 300, out: 600, source: "manual" },
    ]);
  });
  it("ends a song at a gap mark, and finds the gap again from the marks", async () => {
    const { marksFromStarts, startsFromMarks, GAP } = await import("./ops");
    const starts = [{ song_id: "a", t: 10 }, { song_id: GAP, t: 200 }, { song_id: "b", t: 300 }, { song_id: GAP, t: 550 }];
    const marks = marksFromStarts(starts, 600);
    expect(marks).toEqual([
      { song_id: "a", in: 10, out: 200, source: "manual" },
      { song_id: "b", in: 300, out: 550, source: "manual" },
    ]);
    expect(startsFromMarks(marks, 600)).toEqual(starts);
  });
  it("only makes clips and thumbnails for songs that don't have them from the record yet", async () => {
    const { marksToMake } = await import("./ops");
    const show = fresh();
    show.records = [{ id: "r1", path: "/x/NYC.mov", name: "NYC.mov", scope: "show", added_at: "", stills: ["stills/lights.jpg"] }];
    show.songs.s_lights.gallery = ["stills/lights.jpg"];
    show.songs.s_harbour.clips = [{ path: "clips/harbour.mp4", record_id: "r1", in: 100, out: 200, source: "manual" }];
    const mark = (song_id: string, at: number, end: number) => ({ song_id, in: at, out: end, source: "manual" as const });
    const marks = [mark("s_lights", 0, 100), mark("s_harbour", 100, 200), mark("s_glass", 200, 300)];
    // Thumbnails only: Low Lights already has its still from this record.
    expect(marksToMake(show, "r1", marks, false).map((m) => m.song_id)).toEqual(["s_harbour", "s_glass"]);
    // Clips: Harbour's clip is cut for the same mark; Low Lights has only a thumbnail, so it still needs its clip.
    expect(marksToMake(show, "r1", marks, true).map((m) => m.song_id)).toEqual(["s_lights", "s_glass"]);
    // A moved mark is cut again; a clip from another record doesn't count.
    expect(marksToMake(show, "r1", [mark("s_harbour", 100, 260)], true)).toHaveLength(1);
    expect(marksToMake(show, "r2", [mark("s_harbour", 100, 200)], true)).toHaveLength(1);
  });
  it("makes folder-safe bundle names", async () => {
    const { bundleName } = await import("./ops");
    expect(bundleName("DEFTONES | SNW FEST 2026")).toBe("DEFTONES - SNW FEST 2026");
    expect(bundleName("A/B: C?")).toBe("A - B - C");
    expect(bundleName("  ")).toBe("Untitled show");
  });
});

describe("note fields", () => {
  it("new shows put Lighting and Camera direction on the cards", async () => {
    const { noteFields, fieldLabel } = await import("./ops");
    expect(noteFields(newShow("T")).map(fieldLabel)).toEqual(["Lighting", "Camera direction"]);
  });
  it("adds a field to every song and hides it without losing notes", async () => {
    const { addNoteField, hideNoteField, noteFields, fieldLabel } = await import("./ops");
    const show = fresh();
    const id = addNoteField(show, "Automation");
    const col = show.columns.find((c) => c.id === id)!;
    expect(col).toMatchObject({ type: "longtext", on_card: true, label: "AUTOMATION NOTES", dept: "STAGING" });
    expect(fieldLabel(col)).toBe("Automation");
    const pyro = addNoteField(show, "Pyro");
    expect(show.columns.find((c) => c.id === pyro)!.dept).toBe("SFX");
    show.songs.s_opener.fields[id] = "Hold for MD";
    hideNoteField(show, id);
    expect(noteFields(show).some((c) => c.id === id)).toBe(false);
    expect(show.songs.s_opener.fields[id]).toBe("Hold for MD");
  });
  it("renames a field on every song, keeping its notes and NOTES suffix", async () => {
    const { renameField, fieldLabel } = await import("./ops");
    const show = newShow("T");
    const id = addSong(show, "set_order", undefined, "Opener");
    show.songs[id].fields.lx_notes = "Hold";
    renameField(show, "lx_notes", "Lighting design");
    expect(col(show, "lx_notes").label).toBe("LIGHTING DESIGN NOTES");
    expect(fieldLabel(col(show, "lx_notes"))).toBe("Lighting design");
    expect(show.songs[id].fields.lx_notes).toBe("Hold");
    renameField(show, "cam_dir", "Shots");
    expect(col(show, "cam_dir").label).toBe("SHOTS");
    renameField(show, "cam_dir", "  ");
    expect(col(show, "cam_dir").label).toBe("SHOTS");
  });
  it("migrates older shows so cards get the default note fields", async () => {
    const { migrate, noteFields } = await import("./ops");
    const show = fresh();
    for (const c of show.columns) delete c.on_card;
    expect(noteFields(migrate(show)).map((c) => c.id)).toEqual(["lx_notes", "cam_dir"]);
  });
});

describe("BPM", () => {
  it("every show has a BPM column that can't be deleted", async () => {
    const { migrate, removeColumn } = await import("./ops");
    const show = newShow("T");
    expect(show.columns.map((c) => c.id)).toContain("bpm");
    removeColumn(show, "bpm");
    expect(show.columns.map((c) => c.id)).toContain("bpm");
    const old = fresh();
    old.columns = old.columns.filter((c) => c.id !== "bpm");
    const ids = migrate(old).columns.map((c) => c.id);
    expect(ids.indexOf("bpm")).toBe(ids.indexOf("tc") + 1);
  });
  it("older shows get a clip column after the Content picture, once: deleting it sticks", async () => {
    const { deptCategory, migrate, removeColumn } = await import("./ops");
    const old = fresh();
    old.columns = old.columns.filter((c) => c.type !== "clip");
    delete old.added_columns;
    const ids = migrate(old).columns.map((c) => c.id);
    expect(ids.indexOf("clip")).toBe(ids.indexOf(deptCategory("CONTENT")) + 1);
    removeColumn(old, "clip");
    expect(migrate(old).columns.some((c) => c.type === "clip")).toBe(false);
    const made = newShow("T");
    removeColumn(made, "clip");
    expect(migrate(made).columns.some((c) => c.type === "clip")).toBe(false);
  });
  it("the clip column sits right after the picture its clips come from, in its category, and stays with it", async () => {
    const { addClip, deptCategory, GENERAL, migrate, placeColumn, retagRecord } = await import("./ops");
    const show = migrate(fresh());
    const ids = () => show.columns.map((c) => c.id);
    show.records = [{ id: "r1", path: "/x/NYC.mov", name: "NYC.mov", scope: "show", added_at: "" }]; // General's
    addClip(show, show.set_order[0], { path: "media/clips/a.mp4", record_id: "r1", in: 0, out: 10, source: "auto_tc" });
    expect(ids().indexOf("clip")).toBe(ids().indexOf(GENERAL) + 1);
    expect(col(show, "clip").dept).toBe("CORE");
    placeColumn(show, "clip", "LX", null); // dragged away: it goes back
    expect(ids().indexOf("clip")).toBe(ids().indexOf(GENERAL) + 1);
    retagRecord(show, "r1", deptCategory("CONTENT"));
    expect(ids().indexOf("clip")).toBe(ids().indexOf(deptCategory("CONTENT")) + 1);
    expect(col(show, "clip").dept).toBe("CONTENT");
  });
  it("new shows don't get Notch layer or Camera FX", () => {
    const ids = newShow("T").columns.map((c) => c.id);
    expect(ids).not.toContain("notch");
    expect(ids).not.toContain("cam_fx");
  });
});

describe("splitting a TC block", () => {
  it("works out TC inside a block, where it runs on from the block start", async () => {
    const { formatTc, tcAt, timeAtTc } = await import("./ops");
    const block = { file_start: 35, file_end: 375, tc_start: "02:00:00:00", tc_end: "02:05:40:00" };
    expect(tcAt(block, 35 + 192.48)).toBe("02:03:12:12");
    expect(timeAtTc(block, "02:03:12:12")).toBeCloseTo(227.48, 2);
    expect(timeAtTc(block, "03:00:00:00")).toBeNull();
    expect(formatTc(23 * 3600 + 59 * 60 + 59 + 24 / 25)).toBe("23:59:59:24");
  });
});

describe("statuses", () => {
  it("new shows tick LX Prog, Vid Prog and Content Made", () => {
    expect(newShow("T").columns.filter((c) => c.type === "tick").map((c) => c.label)).toEqual(["LX PROG", "VID PROG", "CONTENT MADE"]);
  });
  it("renames the old default statuses only while none are ticked", async () => {
    const { migrate, addSongWith } = await import("./ops");
    const old = () => {
      const s = newShow("T");
      s.columns = s.columns.filter((c) => c.type !== "tick").concat(
        [["st_programmed", "PROGRAMMED"], ["st_approved", "APPROVED"], ["st_video", "VIDEO"]].map(([id, label]) => ({ id, label, dept: "STATUS" as const, type: "tick" as const, width: 60 })));
      addSongWith(s, "A", "", "", "");
      return s;
    };
    const ticks = (s: ReturnType<typeof newShow>) => s.columns.filter((c) => c.type === "tick").map((c) => c.label);
    expect(ticks(migrate(old()))).toEqual(["LX PROG", "VID PROG", "CONTENT MADE"]);
    const ticked = old();
    Object.values(ticked.songs)[0].fields.st_approved = "TRUE";
    expect(ticks(migrate(ticked))).toEqual(["PROGRAMMED", "APPROVED", "VIDEO"]);
  });
});

describe("gel names", () => {
  it("labels swatches with the colour's name, and renames old code labels", async () => {
    const { migrate } = await import("./ops");
    const { GELS, searchGels } = await import("./gels");
    expect(GELS.find((g) => g.code === "L117")!.label).toBe("Steel Blue");
    expect(GELS.find((g) => g.code === "L201")!.label).toBe("CTB");
    expect(searchGels("deep red").map((g) => g.label)).toContain("Deep Red");
    expect(searchGels("mid blue").map((g) => g.label)).toContain("Medium Blue");
    expect(searchGels("dirty").map((g) => g.label)).toEqual(["Dirty White"]);
    const show = fresh();
    expect(show.songs.s_lights.colours[0].label).toBe("L106");
    expect(migrate(show).songs.s_lights.colours[0].label).toBe("Primary Red");
  });
});

describe("show records and their clips", () => {
  it("names clips after what the record is", async () => {
    const { guessRecordLabel, recordClipName, addSongWith, addRecord } = await import("./ops");
    const s = newShow("OVERMONO 2026");
    expect(guessRecordLabel(s, "/x/OVERMONO - NYC T5 - FULL SHOW & TC.mp4")).toBe("NYC T5");
    const id = addSongWith(s, "INTRO");
    const rec = addRecord(s, { path: "/x/OVERMONO - NYC T5 - FULL SHOW & TC.mp4", scope: "show", label: "NYC T5" });
    expect(recordClipName(s, s.records!.find((r) => r.id === rec)!, id)).toBe("NYC T5_SHOW RECORD_CLIPPED 01 INTRO");
  });

  it("removing a record takes its clips and stills, including older numbered stills", async () => {
    const { addSongWith, addRecord, addClip, addImages, recordMedia, removeRecord, orphanRecordIds } = await import("./ops");
    const s = newShow("T");
    const a = addSongWith(s, "GUNK");
    const rec = addRecord(s, { path: "/x/r.mp4", scope: "show" });
    addClip(s, a, { path: "media/clips/04 GUNK.mp4", record_id: rec, in: 0, out: 10, source: "auto_tc" });
    addImages(s, a, ["media/grabs/04 GUNK_2.jpg", "media/renders/keep.png"]);
    expect(recordMedia(s, rec)).toEqual({ clips: ["media/clips/04 GUNK.mp4"], stills: ["media/grabs/04 GUNK_2.jpg"] });
    s.records = [];
    expect(orphanRecordIds(s)).toEqual([rec]);
    removeRecord(s, rec);
    expect(s.songs[a].clips).toEqual([]);
    expect(s.songs[a].gallery).toEqual(["media/renders/keep.png"]);
    expect(s.songs[a].hero).toBe("media/renders/keep.png");
  });
});

describe("editing in the Sheet", () => {
  it("lets every data field and colour be edited, but not the running order's own fields", async () => {
    const { sheetEditable, applySheetValue, addSongWith } = await import("./ops");
    const s = newShow("T");
    const editable = s.columns.filter(sheetEditable).map((c) => c.id);
    expect(editable).toEqual(expect.arrayContaining(["lx_notes", "video_notes", "content_notes", "cam_dir", "colref", "colour_1"]));
    expect(editable).not.toContain("name");
    expect(editable).not.toContain("tc");
    const id = addSongWith(s, "A");
    const c1 = s.columns.find((c) => c.id === "colour_1")!;
    applySheetValue(s, id, c1, "steel blue");
    expect(s.songs[id].colours[0].label).toBe("Steel Blue");
    applySheetValue(s, id, c1, "");
    expect(s.songs[id].colours).toEqual([]);
  });
});

describe("typed custom fields", () => {
  it("adds a colour field holding swatches like the lighting colours, editable in the Sheet by name", async () => {
    const { addCustomField, applySheetValue, cellValue, sheetEditable, removeColumn } = await import("./ops");
    const show = fresh();
    const id = addCustomField(show, "Laser colour", "palette");
    const c = col(show, id);
    expect(c).toMatchObject({ type: "palette", label: "LASER COLOUR", dept: "LX" });
    expect(sheetEditable(c)).toBe(true);
    const song = show.songs.s_opener;
    song.swatches = { [id]: [{ hex: "#123456", label: "Laser green" }] };
    expect(cellValue(show, c, song)).toBe("Laser green");
    applySheetValue(show, "s_opener", c, "Laser green, ctb, #f80");
    expect(song.swatches[id][0]).toEqual({ hex: "#123456", label: "Laser green" }); // unchanged name keeps its colour
    expect(song.swatches[id][1].label).toBe("CTB");
    expect(song.swatches[id][2]).toEqual({ hex: "#FF8800", label: "#FF8800" });
    applySheetValue(show, "s_opener", c, "");
    expect(song.swatches[id]).toEqual([]);
    removeColumn(show, id);
    expect(song.swatches[id]).toBeUndefined();
  });
  it("moves an old one-hex colour field into swatches", async () => {
    const { migrate } = await import("./ops");
    const show = fresh();
    show.columns.push({ id: "laser", label: "LASER", dept: "LX", type: "hex" as never });
    show.songs.s_opener.fields.laser = "#00FF00";
    migrate(show);
    expect(col(show, "laser").type).toBe("palette");
    expect(show.songs.s_opener.fields.laser).toBeUndefined();
    expect(show.songs.s_opener.swatches?.laser).toEqual([{ hex: "#00FF00", label: "#00FF00" }]);
  });
  it("adds a list field that only takes its options", async () => {
    const { addCustomField, applySheetValue, fieldValue } = await import("./ops");
    const show = fresh();
    const id = addCustomField(show, "Automation trim", "choice", ["Out", " Trim 1", "Trim 2", "trim 2", "", "Deck"]);
    const c = col(show, id);
    expect(c).toMatchObject({ type: "choice", dept: "STAGING", options: ["Out", "Trim 1", "Trim 2", "Deck"] });
    expect(fieldValue(c, "trim 1")).toBe("Trim 1");
    expect(fieldValue(c, "Trim 3")).toBeNull();
    expect(fieldValue(c, "")).toBe("");
    applySheetValue(show, "s_opener", c, "DECK");
    applySheetValue(show, "s_opener", c, "Halfway");
    expect(show.songs.s_opener.fields[id]).toBe("Deck");
  });
  it("renames and removes options on every song", async () => {
    const { addCustomField, renameChoiceOption, removeChoiceOption, moveChoiceOption } = await import("./ops");
    const show = fresh();
    const id = addCustomField(show, "Trim", "choice", ["Out", "Trim 1", "Deck"]);
    show.songs.s_opener.fields[id] = "Trim 1";
    renameChoiceOption(show, id, "Trim 1", "Mid");
    expect(col(show, id).options).toEqual(["Out", "Mid", "Deck"]);
    expect(show.songs.s_opener.fields[id]).toBe("Mid");
    moveChoiceOption(show, id, "Deck", -1);
    expect(col(show, id).options).toEqual(["Out", "Deck", "Mid"]);
    removeChoiceOption(show, id, "Mid");
    expect(col(show, id).options).toEqual(["Out", "Deck"]);
    expect(show.songs.s_opener.fields[id]).toBeUndefined();
  });
});

describe("ltcFromName", () => {
  it("reads the LTC side from a clip's name", () => {
    expect(ltcFromName("/show/media/clips/NYC T5_SHOW RECORD_CLIPPED 01 INTRO_LTC-R.mp4")).toBe(1);
    expect(ltcFromName("media/clips/A_LTC-L.mp4")).toBe(0);
    expect(ltcFromName("A_ltc-r.MOV")).toBe(1);
    expect(ltcFromName("A_LTC-R - no LTC.mp4")).toBeNull();
    expect(ltcFromName("/x_LTC-R/clip.mp4")).toBeNull();
    expect(ltcFromName("LTC + AUDIO - V4.1.wav")).toBeNull();
  });
});

describe("tagged stills", () => {
  const withRecord = async () => {
    const { addClip } = await import("./ops");
    const show = fresh();
    const id = show.set_order[0];
    const song = show.songs[id];
    song.hero = "media/renders/r.jpg";
    song.gallery = ["media/renders/r.jpg"];
    show.records = [{ id: "r1", path: "/x/NYC.mov", name: "NYC.mov", scope: "show", added_at: "" }];
    addClip(show, id, { path: "media/clips/a.mp4", record_id: "r1", in: 0, out: 10, source: "auto_tc", still: "media/grabs/a.jpg" });
    return { show, id, song };
  };

  it("a category name names its department's column, or an image column of its own, first in its department", async () => {
    const { deptCategory, imageColumnFor, migrate } = await import("./ops");
    const show = migrate(fresh());
    expect(imageColumnFor(show, "Render")).toBe(deptCategory("CONTENT"));
    expect(imageColumnFor(show, "Choreography")).toBe(deptCategory("CHOREO"));
    expect(col(show, deptCategory("CHOREO"))).toMatchObject({ type: "image", label: "CHOREOGRAPHY", dept: "CHOREO" });
    const laser = imageColumnFor(show, "Lasers");
    expect(col(show, laser)).toMatchObject({ type: "image", label: "LASERS", dept: "LX" });
    expect(imageColumnFor(show, "lasers")).toBe(laser);
    expect(show.columns.findIndex((c) => c.dept === "LX")).toBe(show.columns.findIndex((c) => c.id === laser));
  });
  it("categories: General (the main image), the show's departments, then any added by name; only those can be renamed or deleted", async () => {
    const { categories, deleteCategory, deptCategory, ensureCategory, GENERAL, imageColumnFor, migrate, renameCategory } = await import("./ops");
    const show = migrate(fresh());
    expect(categories(show).map((c) => c.name)).toEqual(["General", "Content", "LX", "Video", "Cameras"]); // no CHOREO department, so no Choreography
    expect(col(show, GENERAL)).toMatchObject({ type: "image", label: "SONG IMAGE", dept: "CORE" });
    const lx = deptCategory("LX");
    expect(show.columns.some((c) => c.id === lx)).toBe(false); // made on first use
    expect(ensureCategory(show, lx)).toBe(lx);
    expect(col(show, lx)).toMatchObject({ type: "image", label: "LX", dept: "LX" });
    const laser = imageColumnFor(show, "Lasers");
    show.records = [{ id: "r1", path: "/x.mov", name: "x", scope: "show", added_at: "", image_col: laser }];
    renameCategory(show, laser, "Laser looks");
    expect(categories(show).map((c) => c.name)).toEqual(["General", "Content", "LX", "Video", "Cameras", "Laser looks"]);
    expect(show.records[0].image_col).toBe(laser); // still filed under it
    renameCategory(show, GENERAL, "Nope");
    renameCategory(show, lx, "Nope");
    expect(col(show, GENERAL).label).toBe("SONG IMAGE");
    expect(col(show, lx).label).toBe("LX");
    deleteCategory(show, laser);
    expect(show.columns.some((c) => c.id === laser)).toBe(false);
    expect(show.records[0].image_col).toBeUndefined();
    deleteCategory(show, lx);
    deleteCategory(show, GENERAL);
    expect(show.columns.some((c) => c.id === lx)).toBe(true);
    expect(show.columns.some((c) => c.id === GENERAL)).toBe(true);
  });
  it("older shows: RENDER becomes the Content category, and SONG IMAGE the main image (General), once", async () => {
    const { deptCategory, GENERAL, migrate, songImage } = await import("./ops");
    const show = fresh();
    const content = deptCategory("CONTENT");
    show.columns.push({ id: "song_image_x1y", label: "SONG IMAGE", dept: "CORE", type: "image" });
    const [a, b] = show.set_order;
    Object.assign(show.songs[a], { hero: "media/renders/a.jpg", gallery: ["media/renders/a.jpg", "media/grabs/a.jpg"], images: { song_image_x1y: "media/grabs/a.jpg" } });
    Object.assign(show.songs[b], { hero: "media/renders/b.jpg", gallery: ["media/renders/b.jpg"] });
    show.records = [
      { id: "r1", path: "/x/NYC.mov", name: "NYC.mov", scope: "show", added_at: "", image_col: "song_image_x1y" },
      { id: "r2", path: "/x/Old.mov", name: "Old.mov", scope: "show", added_at: "" }, // from before categories: RENDER
    ];
    migrate(show);
    expect(col(show, GENERAL)).toMatchObject({ type: "image", label: "SONG IMAGE", dept: "CORE" });
    expect(col(show, content)).toMatchObject({ type: "image", label: "CONTENT", dept: "CONTENT" });
    expect(show.columns.filter((c) => c.type === "image")).toHaveLength(2);
    const depts = show.columns.map((c) => c.dept);
    expect(depts.indexOf("CONTENT")).toBeGreaterThan(depts.lastIndexOf("CORE")); // each department's columns together
    expect(show.songs[a].hero).toBe("media/grabs/a.jpg"); // General's image is the main one
    expect(songImage(show.songs[a], content)).toBe("media/renders/a.jpg");
    expect(show.songs[a].images).toEqual({ [content]: "media/renders/a.jpg" });
    expect(show.songs[b].hero).toBe("media/renders/b.jpg"); // no General image: the render stays the main one too
    expect(songImage(show.songs[b], content)).toBe("media/renders/b.jpg");
    expect(show.records.map((r) => r.image_col)).toEqual([GENERAL, content]);
    show.songs[b].hero = "media/renders/b2.jpg";
    migrate(show);
    expect(songImage(show.songs[b], content)).toBe("media/renders/b.jpg"); // once only
  });
  it("a Content category made by name becomes the department's", async () => {
    const { deptCategory, migrate } = await import("./ops");
    const show = fresh();
    show.columns.push({ id: "content_k2p", label: "CONTENT", dept: "CORE", type: "image" });
    const id = show.set_order[0];
    show.songs[id].images = { content_k2p: "media/grabs/a.jpg" };
    show.records = [{ id: "r1", path: "/x.mov", name: "x", scope: "show", added_at: "", image_col: "content_k2p" }];
    migrate(show);
    const content = deptCategory("CONTENT");
    expect(show.columns.filter((c) => c.label === "CONTENT" && c.type === "image").map((c) => c.id)).toEqual([content]);
    expect(col(show, content).dept).toBe("CONTENT");
    expect(show.songs[id].images?.[content]).toBe("media/grabs/a.jpg");
    expect(show.records[0].image_col).toBe(content);
  });
  it("a still goes into its tag's column without taking RENDER, and leaves it when removed", async () => {
    const { imageColumnFor, songImage } = await import("./ops");
    const { show, id, song } = await withRecord();
    const laser = imageColumnFor(show, "Lasers");
    addImages(show, id, ["media/grabs/a.jpg"], laser);
    expect(song.hero).toBe("media/renders/r.jpg");
    expect(songImage(song, laser)).toBe("media/grabs/a.jpg");
    expect(cellValue(show, col(show, laser), song)).toBe("media/grabs/a.jpg");
    removeImage(show, id, "media/grabs/a.jpg");
    expect(songImage(song, laser)).toBeUndefined();
  });

  it("deleting a song's still takes it off the record and its clip, unless another song uses it", async () => {
    const { addRecordStill } = await import("./ops");
    const { show, id, song } = await withRecord();
    const other = show.set_order.find((s) => s !== id)!;
    const rec = show.records![0].id;
    addImages(show, id, ["media/grabs/a.jpg", "media/grabs/b.jpg"]);
    addImages(show, other, ["media/grabs/b.jpg"]);
    for (const p of ["media/grabs/a.jpg", "media/grabs/b.jpg"]) addRecordStill(show, rec, p);
    removeImage(show, id, "media/grabs/a.jpg");
    removeImage(show, id, "media/grabs/b.jpg");
    expect(show.records![0].stills).toEqual(["media/grabs/b.jpg"]);
    expect(song.clips![0].still).toBeUndefined();
  });

  it("an existing show forgets record stills no song uses", async () => {
    const { migrate } = await import("./ops");
    const { show } = await withRecord();
    show.records![0].stills = ["media/grabs/gone.jpg"];
    expect(migrate(show).records![0].stills).toEqual([]);
  });

  it("a still in any category becomes the hero when the song has none", async () => {
    const { imageColumnFor, songImage } = await import("./ops");
    const show = fresh();
    const id = show.set_order[0];
    const song = show.songs[id];
    delete song.hero;
    const content = imageColumnFor(show, "Content");
    addImages(show, id, ["media/grabs/a.jpg"], content);
    expect(songImage(song, content)).toBe("media/grabs/a.jpg");
    expect(song.hero).toBe("media/grabs/a.jpg");
    addImages(show, id, ["media/grabs/b.jpg"], content);
    expect(song.hero).toBe("media/grabs/a.jpg"); // an existing hero stays
    addImages(show, id, ["media/grabs/show.jpg"]); // General: takes the main image it was only borrowing from Content
    expect(song.hero).toBe("media/grabs/show.jpg");
    addImages(show, id, ["media/grabs/show2.jpg"]);
    expect(song.hero).toBe("media/grabs/show.jpg");
  });

  it("songs with images but no hero take one when the show opens, once", async () => {
    const { imageColumnFor, migrate } = await import("./ops");
    const show = fresh();
    const [a, b] = show.set_order;
    const content = imageColumnFor(show, "Content");
    for (const id of [a, b]) delete show.songs[id].hero;
    show.songs[a].gallery = ["media/grabs/a.jpg"];
    show.songs[a].images = { [content]: "media/grabs/a.jpg" };
    migrate(show);
    expect(show.songs[a].hero).toBe("media/grabs/a.jpg");
    expect(show.songs[b].hero).toBeUndefined(); // no images, no hero
    delete show.songs[a].hero; // cleared later on purpose: opening again leaves it
    migrate(show);
    expect(show.songs[a].hero).toBeUndefined();
  });

  it("re-tagging a record moves its stills out of RENDER", async () => {
    const { imageColumnFor, retagRecord, songImage } = await import("./ops");
    const { show, id, song } = await withRecord();
    addImages(show, id, ["media/grabs/a.jpg"]);
    setHero(show, id, "media/grabs/a.jpg");
    const showRecord = imageColumnFor(show, "Show record");
    retagRecord(show, "r1", showRecord);
    const to = show.records![0].image_col!;
    expect(to).toBe(showRecord);
    expect(songImage(song, to)).toBe("media/grabs/a.jpg");
    expect(song.hero).toBe("media/renders/r.jpg"); // back to the render, not the still
  });
});

describe("categories and a record's stills", () => {
  it("an image has one category: moving it takes it out of the last one; being the main image is separate", async () => {
    const { deptCategory, ensureCategory, imageCategory, migrate, setImageCategory, songImage } = await import("./ops");
    const show = migrate(fresh());
    const id = show.set_order[0];
    const song = show.songs[id];
    song.gallery = ["a.jpg", "b.jpg"];
    song.hero = "a.jpg";
    const lx = ensureCategory(show, deptCategory("LX"));
    setImageCategory(show, id, "a.jpg", lx);
    expect(imageCategory(show, song, "a.jpg")).toBe(lx);
    expect(song.hero).toBe("a.jpg"); // still the main image too
    setImageCategory(show, id, "b.jpg", lx);
    expect(songImage(song, lx)).toBe("b.jpg");
    expect(imageCategory(show, song, "a.jpg")).toBe(""); // bumped to the gallery
    setImageCategory(show, id, "b.jpg", "");
    expect(imageCategory(show, song, "b.jpg")).toBe("");
  });
  it("a record's stills (with or without clips) can be deleted together; its clips stay", async () => {
    const { addClip, addRecordStill, recordMedia, removeRecordStills } = await import("./ops");
    const show = fresh();
    const [a, b] = show.set_order;
    show.records = [{ id: "r1", path: "/x/C.mov", name: "C.mov", scope: "show", added_at: "", image_col: "hero" }];
    addClip(show, a, { path: "media/clips/a.mp4", record_id: "r1", in: 0, out: 10, source: "auto_tc", still: "media/grabs/a.jpg" });
    addImages(show, a, ["media/grabs/a.jpg"]);
    addImages(show, b, ["media/grabs/b.jpg"]); // stills only: no clip
    addRecordStill(show, "r1", "media/grabs/a.jpg");
    addRecordStill(show, "r1", "media/grabs/b.jpg");
    expect(recordMedia(show, "r1").stills.sort()).toEqual(["media/grabs/a.jpg", "media/grabs/b.jpg"]);
    expect(removeRecordStills(show, "r1").length).toBe(2);
    expect(show.songs[a].gallery).not.toContain("media/grabs/a.jpg");
    expect(show.songs[b].gallery ?? []).not.toContain("media/grabs/b.jpg");
    expect(show.songs[a].clips).toHaveLength(1);
    expect(show.songs[a].clips![0].still).toBeUndefined();
  });
});

describe("categories in Fields", () => {
  it("a show's fields are grouped by category, in the order the categories first come", async () => {
    const { deptList, migrate } = await import("./ops");
    const show = fresh();
    show.columns.push({ id: "late_core", label: "LATE", dept: "CORE", type: "text" });
    migrate(show);
    expect(show.columns.findIndex((c) => c.id === "late_core")).toBe(show.columns.filter((c) => c.dept === "CORE").length - 1);
    const depts = show.columns.map((c) => c.dept);
    expect(deptList(show)).toEqual(depts.filter((d, i) => depts.indexOf(d) === i));
    expect(new Set(depts).size).toBe(depts.filter((d, i) => d !== depts[i - 1]).length); // one run each
  });
  it("adding a category: empty until it has fields, with a colour; fields go in after its others; empty ones can be deleted", async () => {
    const { addDept, addField, deptColour, deptList, migrate, moveDeptTo, placeColumn, removeDept, setDeptColour } = await import("./ops");
    const show = migrate(fresh());
    expect(addDept(show, "Lasers")).toBe("LASERS");
    expect(deptList(show).slice(-1)).toEqual(["LASERS"]);
    expect(deptColour(show, "LASERS")).toMatch(/^#/);
    expect(addDept(show, "choreography")).toBe("CHOREO");
    expect(deptColour(show, "CHOREO")).toBeUndefined();
    const a = addField(show, "Laser notes", "LASERS", "longtext");
    const lx = show.columns.find((c) => c.dept === "LX")!.id;
    placeColumn(show, lx, "LASERS", null);
    expect(show.columns.filter((c) => c.dept === "LASERS").map((c) => c.id)).toEqual([a, lx]);
    placeColumn(show, lx, "LASERS", a);
    expect(show.columns.filter((c) => c.dept === "LASERS").map((c) => c.id)).toEqual([lx, a]);
    expect(deptList(show)).toContain("LX"); // kept, now empty
    removeDept(show, "LASERS");
    expect(deptList(show)).toContain("LASERS"); // still has fields
    removeDept(show, "LX");
    expect(deptList(show)).not.toContain("LX");
    const before = deptList(show).filter((d) => show.columns.some((c) => c.dept === d));
    moveDeptTo(show, "LASERS", before[1]);
    const after = deptList(show).filter((d) => show.columns.some((c) => c.dept === d));
    expect(after.slice(0, 2)).toEqual(["CORE", "LASERS"]);
    moveDeptTo(show, "LASERS", "CORE"); // nothing goes before CORE
    moveDeptTo(show, "CORE", null);
    expect(deptList(show).slice(0, 2)).toEqual(["CORE", "LASERS"]);
    moveDeptTo(show, "LASERS", null);
    expect(deptList(show).filter((d) => show.columns.some((c) => c.dept === d)).slice(-1)).toEqual(["LASERS"]);
    // Any category's colour can be changed; a built-in one can go back to its own.
    setDeptColour(show, "STATUS", "#123456");
    expect(deptColour(show, "STATUS")).toBe("#123456");
    setDeptColour(show, "STATUS", null);
    expect(deptColour(show, "STATUS")).toBeUndefined();
  });
  it("a category's media field is made when media is filed in it, and knows what's in it", async () => {
    const { addCategory, addField, categories, ensureCategory, isCategoryMedia, mediaIn, migrate, setImageCategory } = await import("./ops");
    const show = migrate(fresh());
    const id = addCategory(show, "Lasers");
    expect(categories(show).find((c) => c.id === id)).toMatchObject({ name: "Lasers", column: "LASERS" });
    expect(show.columns.some((c) => c.id === id)).toBe(false);
    const songId = Object.keys(show.songs)[0];
    show.songs[songId].gallery = ["media/grabs/a.jpg"];
    setImageCategory(show, songId, "media/grabs/a.jpg", ensureCategory(show, id));
    expect(col(show, id)).toMatchObject({ type: "image", dept: "LASERS", label: "LASERS" });
    expect(isCategoryMedia(show, col(show, id))).toBe(true);
    expect(mediaIn(show, id)).toEqual({ songs: 1, records: 0 });
    expect(addCategory(show, "lasers")).toBe(id);
    // A Media field added in Fields is the category's own if it has none, else one of its own.
    expect(addField(show, "", "VIDEO", "image")).toBe("img_video");
    const extra = addField(show, "Mood", "VIDEO", "image");
    expect(extra).not.toBe("img_video");
    expect(isCategoryMedia(show, col(show, extra))).toBe(false);
  });
});

describe("renaming a category", () => {
  it("keeps its id (fields, media, colour) and renames its band and its media field; a taken name is ignored", async () => {
    const { addCategory, addDept, categories, deptCategory, deptLabel, deptList, deptName, ensureCategory, migrate, renameDept } = await import("./ops");
    const show = migrate(fresh());
    const content = ensureCategory(show, deptCategory("CONTENT"));
    renameDept(show, "CONTENT", "Visuals");
    expect(deptLabel(show, "CONTENT")).toBe("VISUALS");
    expect(deptName("CONTENT", show)).toBe("Visuals");
    expect(col(show, content)).toMatchObject({ dept: "CONTENT", label: "VISUALS" });
    expect(categories(show).find((c) => c.id === content)!.name).toBe("Visuals");
    expect(addDept(show, "visuals")).toBe("CONTENT");
    expect(addCategory(show, "Visuals")).toBe(content);
    renameDept(show, "LX", "visuals");
    expect(deptLabel(show, "LX")).toBe("LX");
    renameDept(show, "CONTENT", "content"); // back to its own name
    expect(show.departments!.find((d) => d.id === "CONTENT")!.label).toBeUndefined();
    expect(col(show, content).label).toBe("CONTENT");
    expect(deptList(show)).toContain("CONTENT");
  });
});

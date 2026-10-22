import { describe, expect, it } from "vitest";
import sample from "./sample_show.json";
import {
  addColumn, addImages, addNote, addSong, archiveSong, cellValue, deleteSong, moveColumn, moveSong,
  newShow, removeColumn, removeImage, restoreSong,
} from "./ops";
import type { Show } from "./types";
import { useStore } from "../store";

const fresh = () => structuredClone(sample) as Show;
const col = (show: Show, id: string) => show.columns.find((c) => c.id === id)!;

describe("cell values", () => {
  it("shows Cont. in the TC column after a segue", () => {
    const show = fresh();
    expect(show.songs.s_summer.segues_into_next).toBe(true);
    expect(cellValue(show, col(show, "tc"), show.songs.s_seven)).toBe("Cont.");
    expect(cellValue(show, col(show, "tc"), show.songs.s_summer)).toBe("09:00:00:00");
  });
  it("reads ticks and swatch labels", () => {
    const show = fresh();
    expect(cellValue(show, col(show, "st_viz"), show.songs.s_lights)).toBe(true);
    expect(cellValue(show, col(show, "colour_1"), show.songs.s_lights)).toBe("L106");
    expect(cellValue(show, col(show, "colour_3"), show.songs.s_lights)).toBe("");
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

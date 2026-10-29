import { beforeEach, describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { migrate } from "../model/ops";
import type { Show } from "../model/types";
import { addEdits, editorName, editsBetween, editsFromDrive, highlightCss, movedSongs, sheetEditor, sheetPull } from "./edits";
import { FakeDrive } from "./fakeDrive";
import { syncShow, updateManifest } from "./show";

const fresh = () => migrate(structuredClone(sample) as Show);
const SAM = { displayName: "Sam Jones", emailAddress: "sam@example.com" };
const ALEX = { displayName: "Alex Lee", emailAddress: "alex@example.com" };

describe("editsBetween", () => {
  it("finds each song and field someone changed, and ignores bookkeeping", () => {
    const before = fresh();
    const after = structuredClone(before);
    after.songs.s_opener.fields.tc = "01:02:03:04";
    after.songs.s_opener.fields.lx_notes = "Strobes";
    after.songs.s_lights.colours = [{ hex: "#ff0000", label: "Red" }];
    after.songs.s_harbour.statuses.st_lx = !after.songs.s_harbour.statuses.st_lx;
    after.venue = "O2";
    after.google = { ...after.google, deck_hash: "changed" };
    const e = editsBetween(before, after, "sam@example.com")!;
    expect(e.songs.s_opener.keys).toEqual(["tc", "lx_notes"]);
    expect(e.songs.s_opener.labels).toContain("Lighting");
    expect(e.songs.s_lights.keys).toEqual(["colours"]);
    expect(e.songs.s_harbour.keys).toEqual(["st_lx"]);
    expect(e.songs.s_opener.by).toEqual(["sam@example.com"]);
    expect(e.show).toEqual(["Venue"]);

    const quiet = structuredClone(before);
    quiet.google = { ...quiet.google, deck_hash: "changed" };
    expect(editsBetween(before, quiet, "sam@example.com")).toBeNull();
  });

  it("marks only the song that moved, a new song, and a deleted one", () => {
    const before = fresh();
    const after = structuredClone(before);
    const [a, b, c, d] = before.set_order;
    after.set_order = [b, c, a, d, ...before.set_order.slice(4)];
    after.songs.s_new = { ...structuredClone(before.songs[d]), id: "s_new" };
    after.set_order.push("s_new");
    delete after.songs[d];
    after.set_order = after.set_order.filter((x) => x !== d);
    const e = editsBetween(before, after, "sam")!;
    expect(Object.keys(e.songs).sort()).toEqual([a, "s_new"].sort());
    expect(e.songs[a].keys).toEqual(["moved"]);
    expect(e.songs.s_new.keys).toContain("added");
    expect(e.show).toEqual([expect.stringMatching(/^Deleted /)]);
  });

  it("finds the fewest songs that moved", () => {
    expect(movedSongs(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toEqual([]);
    expect(movedSongs(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual(["d"]);
    expect(movedSongs(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual(["a"]);
  });

  it("adds up edits from several saves, latest editor last", () => {
    const sam = { name: "Sam", email: "sam" };
    const alex = { name: "Alex", email: "alex" };
    let all = addEdits(null, [sam], { songs: { x: { keys: ["tc"], labels: ["TC"], by: ["sam"] } }, show: [] });
    all = addEdits(all, [alex], { songs: { x: { keys: ["bpm"], labels: ["BPM"], by: ["alex"] } }, show: ["Venue"] });
    expect(all.by.map((e) => e.name)).toEqual(["Sam", "Alex"]);
    expect(all.songs.x).toEqual({ keys: ["tc", "bpm"], labels: ["TC", "BPM"], by: ["sam", "alex"] });
    expect(all.show).toEqual(["Venue"]);
  });

  it("puts edits another Mac pulled from the Sheet down to whoever typed them, and the rest to who saved", () => {
    const sent = fresh();
    const merged = structuredClone(sent);
    merged.songs.s_opener.fields.lx_notes = "Typed in the Sheet";
    merged.songs.s_lights.fields.bpm = "128";
    const typist = sheetEditor({ name: "Pat Client", email: "pat@client.com" });
    const fromSheet = editsBetween(sent, merged, "x")!;
    delete fromSheet.songs.s_lights; // only the note was typed in the Sheet
    merged.google = { ...merged.google, sheet_pull: sheetPull(fromSheet, typist) };
    const e = editsFromDrive(sent, merged, [{ name: "Sam Jones", email: "sam@example.com" }])!;
    expect(e.songs.s_opener.by).toEqual(["sheet:pat@client.com"]);
    expect(e.songs.s_lights.by).toEqual(["sam@example.com"]);
    expect(e.by.map(editorName)).toEqual(["Sam Jones", "Pat Client"]);

    // Sam only passed the Sheet edit on: Sam isn't named.
    const onlySheet = structuredClone(merged);
    onlySheet.songs.s_lights.fields.bpm = sent.songs.s_lights.fields.bpm;
    expect(editsFromDrive(sent, onlySheet, [{ name: "Sam Jones", email: "sam@example.com" }])!.by.map(editorName)).toEqual(["Pat Client"]);

    // The same pull, already seen here: not the Sheet's.
    const later = structuredClone(merged);
    later.songs.s_opener.fields.tc = "01:00:30:00";
    expect(editsFromDrive(merged, later, [{ name: "Sam Jones", email: "sam@example.com" }])!.songs.s_opener.by).toEqual(["sam@example.com"]);
  });

  it("calls the signed-in user You when they typed in the Sheet", () => {
    expect(editorName(sheetEditor({ name: "Me Myself", email: "Me@Example.com" }, "me@example.com"))).toBe("You");
    expect(editorName(sheetEditor(null))).toBe("Someone");
  });

  it("highlights the song and its fields, in cards, the Sheet view and the song panel", () => {
    const show = fresh();
    const css = highlightCss(show, { by: [{ name: "Sam Jones", email: "sam" }], songs: { s_opener: { keys: ["tc", "colours"], labels: [], by: ["sam"] } }, show: [] });
    expect(css).toContain('.scard[data-song-id="s_opener"]');
    expect(css).toContain('content: "Sam Jones"');
    expect(css).toContain('[data-song-id="s_opener"] [data-col~="tc"]');
    expect(css).toContain('.grid td[data-cell="s_opener|tc"]');
    expect(css).toContain('.grid td[data-cell="s_opener|colour_1"]');
  });
});

describe("who edited", () => {
  let drive: FakeDrive;
  let folder: string;
  let project: string;
  const bundle = (id: string) => `/cache/${id}`;

  beforeEach(async () => {
    drive = new FakeDrive();
    drive.install();
    folder = drive.folder("TEST.showsheet");
    project = drive.put(fresh(), { name: "project.json", parent: folder }, SAM);
    await updateManifest(bundle(folder), () => {});
  });

  it("names nobody on the first download, then everyone who saved since", async () => {
    const first = await syncShow(bundle(folder));
    expect(first.editors).toEqual([]);
    const theirs = drive.content(project);
    theirs.venue = "O2";
    drive.put(theirs, { id: project }, SAM);
    theirs.date = "2026-11-01";
    drive.put(theirs, { id: project }, ALEX);
    const r = await syncShow(bundle(folder), first.show);
    expect(r.editors.map((e) => e.name)).toEqual(["Sam Jones", "Alex Lee"]);
    const again = await syncShow(bundle(folder), r.show);
    expect(again.editors).toEqual([]);
  });

  it("names whoever saved between this Mac's check and its upload", async () => {
    const { show } = await syncShow(bundle(folder));
    drive.beforeUpload = () => {
      drive.beforeUpload = null;
      const theirs = drive.content(project);
      theirs.venue = "O2";
      drive.put(theirs, { id: project }, ALEX);
    };
    const mine = structuredClone(show!);
    mine.date = "2026-11-01";
    const r = await syncShow(bundle(folder), mine);
    expect(r.show!.venue).toBe("O2");
    expect(r.editors.map((e) => e.name)).toEqual(["Alex Lee"]);
  });
});

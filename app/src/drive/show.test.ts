import { beforeEach, describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { migrate } from "../model/ops";
import type { ReviewComment, Show } from "../model/types";
import { FakeDrive } from "./fakeDrive";
import { clashes, diffShows, mergeClashes, openClashes, putBack, reviewOffline, settle, sheetClashes, throwAway } from "./offline";
import { holdEdits, releaseEdits, syncShow, updateManifest } from "./show";

let drive: FakeDrive;
let folder: string;
let project: string;
const bundle = (id: string) => `/cache/${id}`;
const fresh = () => migrate(structuredClone(sample) as Show);

beforeEach(async () => {
  drive = new FakeDrive();
  drive.install();
  folder = drive.folder("TEST.showsheet");
  project = drive.put(fresh(), { name: "project.json", parent: folder });
  await updateManifest(bundle(folder), () => {});
});

describe("syncShow", () => {
  it("copies the show from Drive the first time", async () => {
    const r = await syncShow(bundle(folder));
    expect(r.show?.name).toBe(fresh().name);
    expect(r.uploaded).toBe(false);
    expect(drive.disk.has(`${bundle(folder)}/project.json`)).toBe(true);
    expect(drive.disk.has(`${bundle(folder)}/base.json`)).toBe(true);
  });

  it("uploads an edit, and does nothing when nothing changed", async () => {
    const { show } = await syncShow(bundle(folder));
    const edited = structuredClone(show!);
    edited.venue = "O2";
    const r = await syncShow(bundle(folder), edited);
    expect(r.uploaded).toBe(true);
    expect(drive.content(project).venue).toBe("O2");
    const again = await syncShow(bundle(folder), edited);
    expect(again.uploaded).toBe(false);
    expect(drive.uploads).toBe(1);
  });

  it("merges someone else's save with edits made here", async () => {
    const { show } = await syncShow(bundle(folder));
    const [a, b] = show!.set_order;
    const theirs = drive.content(project);
    theirs.songs[b].fields.name = "THEIRS";
    drive.put(theirs, { id: project });
    const mine = structuredClone(show!);
    mine.songs[a].fields.name = "MINE";
    const r = await syncShow(bundle(folder), mine);
    expect(r.show!.songs[a].fields.name).toBe("MINE");
    expect(r.show!.songs[b].fields.name).toBe("THEIRS");
    expect(drive.content(project).songs[a].fields.name).toBe("MINE");
    expect(drive.content(project).songs[b].fields.name).toBe("THEIRS");
  });

  it("takes someone else's save when nothing changed here", async () => {
    const { show } = await syncShow(bundle(folder));
    const theirs = drive.content(project);
    theirs.venue = "MSG";
    drive.put(theirs, { id: project });
    const r = await syncShow(bundle(folder), show);
    expect(r.show!.venue).toBe("MSG");
    expect(r.uploaded).toBe(false);
  });

  it("merges back a save that landed between the check and the upload", async () => {
    const { show } = await syncShow(bundle(folder));
    const [a, b] = show!.set_order;
    drive.beforeUpload = () => {
      drive.beforeUpload = null;
      const theirs = drive.content(project);
      theirs.songs[b].fields.name = "SLIPPED IN";
      drive.put(theirs, { id: project });
    };
    const mine = structuredClone(show!);
    mine.songs[a].fields.name = "MINE";
    const r = await syncShow(bundle(folder), mine);
    expect(drive.uploads).toBe(2);
    expect(r.show!.songs[b].fields.name).toBe("SLIPPED IN");
    expect(drive.content(project).songs[a].fields.name).toBe("MINE");
    expect(drive.content(project).songs[b].fields.name).toBe("SLIPPED IN");
  });

  it("gives up re-merging after a few tries", async () => {
    const { show } = await syncShow(bundle(folder));
    let n = 0;
    drive.beforeUpload = () => {
      const theirs = drive.content(project);
      theirs.songs[show!.set_order[n++]].fields.name = "BUSY"; // a new edit each time, so there's always more to merge
      drive.put(theirs, { id: project });
    };
    const mine = structuredClone(show!);
    mine.date = "2026-12-31";
    await syncShow(bundle(folder), mine);
    expect(drive.uploads).toBe(4);
  });

  it("never uploads a show it can't edit", async () => {
    drive.files.get(project)!.canEdit = false;
    const { show, canEdit } = await syncShow(bundle(folder));
    expect(canEdit).toBe(false);
    const edited = { ...show!, venue: "NOPE" };
    expect((await syncShow(bundle(folder), edited)).uploaded).toBe(false);
    expect(drive.uploads).toBe(0);
  });
});

describe("working offline", () => {
  it("holds edits made offline: nothing syncs until they're released", async () => {
    const { show } = await syncShow(bundle(folder));
    await holdEdits(bundle(folder));
    const theirs = drive.content(project);
    theirs.date = "THEIRS";
    drive.put(theirs, { id: project });
    const mine = { ...structuredClone(show!), venue: "MINE" };
    const r = await syncShow(bundle(folder), mine);
    expect(r.held).toBe(true);
    expect(r.show!.date).not.toBe("THEIRS");
    expect(drive.uploads).toBe(0);
    await releaseEdits(bundle(folder));
    const after = await syncShow(bundle(folder), mine);
    expect(after.uploaded).toBe(true);
    expect(drive.content(project)).toMatchObject({ venue: "MINE", date: "THEIRS" });
  });

  it("reviews held edits against Drive", async () => {
    const { show } = await syncShow(bundle(folder));
    await holdEdits(bundle(folder));
    const [a, b] = show!.set_order;
    const theirs = drive.content(project);
    theirs.venue = "THEIRS";
    theirs.songs[b].fields.name = "THEIRS";
    drive.put(theirs, { id: project });
    const mine = structuredClone(show!);
    mine.venue = "MINE";
    mine.songs[a].fields.tc = "09:59:59:00";
    const r = await reviewOffline(bundle(folder), mine);
    expect(r.mine.map((c) => [c.song, c.label, c.after])).toEqual([[a, "TC START", "09:59:59:00"], [null, "Venue", "MINE"]]);
    expect(r.theirs.map((c) => [c.song, c.after])).toEqual([[b, "THEIRS"], [null, "THEIRS"]]);
    expect(r.drive.venue).toBe("THEIRS");
    expect(drive.uploads).toBe(0);
  });

  it("shows edits typed in the Google Sheet that no app has pulled, as a clash with the same edit made offline", async () => {
    const { show } = await syncShow(bundle(folder));
    await holdEdits(bundle(folder));
    const [a] = show!.set_order;
    const col = show!.columns.find((c) => /NOTES/.test(c.label))!;
    const mine = structuredClone(show!);
    mine.songs[a].fields[col.id] = "MINE";
    const r = await reviewOffline(bundle(folder), mine, async () => [{ songId: a, colId: col.id, value: "SHEET" }]);
    expect(r.sheetChecked).toBe(true);
    expect(r.drive.songs[a].fields[col.id]).toBe("SHEET");
    expect(r.theirs).toEqual([expect.objectContaining({ song: a, after: "SHEET", via: "sheet" })]);
    expect([...clashes(r)]).toEqual([r.mine[0].id]);
    // Kept: the Sheet's edit is marked as seen, so the next pull doesn't bring it back over yours.
    const kept = settle(r, mine, new Set());
    expect(kept.songs[a].fields[col.id]).toBe("MINE");
    expect(kept.google?.published?.[`show|${a}|${col.id}`]).toBe("SHEET");
    // Thrown away: back as it was, so the next pull takes the Sheet's edit.
    const thrown = settle(r, mine, new Set([r.mine[0].id]));
    expect(thrown.songs[a].fields[col.id]).toBe(show!.songs[a].fields[col.id]);
    expect(thrown.google?.published?.[`show|${a}|${col.id}`]).toBe(show!.google?.published?.[`show|${a}|${col.id}`]);
  });

  it("says so when the Sheet can't be read", async () => {
    const { show } = await syncShow(bundle(folder));
    const r = await reviewOffline(bundle(folder), show!, async () => { throw new Error("reach Google"); });
    expect(r.sheetChecked).toBe(false);
  });

  it("uploads only the changes kept: one thrown away leaves Drive's version", async () => {
    const { show } = await syncShow(bundle(folder));
    await holdEdits(bundle(folder));
    const [a] = show!.set_order;
    const theirs = drive.content(project);
    theirs.venue = "THEIRS";
    drive.put(theirs, { id: project });
    const mine = structuredClone(show!);
    mine.venue = "MINE";
    mine.songs[a].fields.tc = "09:59:59:00";
    const r = await reviewOffline(bundle(folder), mine);
    const keep = throwAway(r.base, mine, r.mine, new Set(r.mine.filter((c) => c.label === "Venue").map((c) => c.id)));
    await releaseEdits(bundle(folder));
    await syncShow(bundle(folder), keep);
    expect(drive.content(project).venue).toBe("THEIRS");
    expect(drive.content(project).songs[a].fields.tc).toBe("09:59:59:00");
  });
});

describe("diffShows and throwAway", () => {
  it("finds each change, song by song, and puts back the ones thrown away", () => {
    const base = fresh();
    const local = structuredClone(base);
    const [a, b, c] = base.set_order;
    local.songs[a].fields.name = "NEW NAME";
    local.songs[a].hero = "media/grabs/x.jpg";
    delete local.songs[b];
    local.set_order = local.set_order.filter((id) => id !== b);
    local.set_order = [c, ...local.set_order.filter((id) => id !== c)];
    local.songs.zz = { ...structuredClone(base.songs[a]), id: "zz" };
    local.set_order.push("zz");
    local.reviews = [...(base.reviews ?? []), { id: "r1", song_id: a, t: 0, text: "Too dark", from: "Me", at: "2026-10-29T10:00:00Z", done: false, replies: [], source: "app" } as ReviewComment];
    const changes = diffShows(base, local);
    expect(changes.map((x) => [x.song, x.kind, x.label])).toEqual([
      [a, "value", "NAME"], [a, "value", "Main image"], ["zz", "added", "Song added"], [b, "removed", "Song removed"],
      [null, "order", "Running order"], [a, "value", "Comment"],
    ].map(([s, k, l]) => [s, k, l === "NAME" ? expect.any(String) : l]));
    expect(diffShows(base, structuredClone(base))).toEqual([]);

    // Throw them all away: back to base.
    expect(throwAway(base, local, changes, new Set(changes.map((x) => x.id)))).toEqual(base);
    // Throw some away: the rest stay.
    const some = throwAway(base, local, changes, new Set(changes.filter((x) => x.kind === "removed" || x.label === "Comment").map((x) => x.id)));
    expect(some.songs[b]).toEqual(base.songs[b]);
    expect(some.set_order.indexOf(b)).toBeGreaterThan(-1);
    expect(some.songs[a].fields.name).toBe("NEW NAME");
    expect(some.reviews ?? []).toEqual(base.reviews ?? []);
    expect(some.songs.zz).toBeDefined();
  });
});

describe("clashes while online", () => {
  it("finds each thing both sides changed in a sync, and takes theirs if picked", async () => {
    const { show } = await syncShow(bundle(folder));
    const [a, b] = show!.set_order;
    const theirs = drive.content(project);
    theirs.songs[a].fields.name = "THEIRS";
    theirs.songs[b].fields.name = "ONLY THEIRS";
    drive.put(theirs, { id: project });
    const mine = structuredClone(show!);
    mine.songs[a].fields.name = "MINE";
    mine.venue = "ONLY MINE";
    const r = await syncShow(bundle(folder), mine);
    const found = r.merges.flatMap((m) => mergeClashes(m.base, m.mine, m.theirs, m.conflicts));
    expect(found.map((c) => c.change.id)).toEqual([`songs/${a}/fields/name`]);
    expect(openClashes(r.show!, found)).toHaveLength(1);

    const took = structuredClone(r.show!);
    putBack(found[0].theirs, took, [found[0].change], new Set([found[0].change.id]));
    expect(took.songs[a].fields.name).toBe("THEIRS");
    expect(took.songs[b].fields.name).toBe("ONLY THEIRS");
    expect(took.venue).toBe("ONLY MINE");
    expect(openClashes(took, found)).toEqual([]); // the same now: nothing left to pick
  });

  it("makes a song they removed and I changed one clash", () => {
    const base = fresh();
    const [a] = base.set_order;
    const mine = structuredClone(base);
    mine.songs[a].fields.name = "MINE";
    mine.songs[a].hero = "media/grabs/x.jpg";
    const theirs = structuredClone(base);
    delete theirs.songs[a];
    theirs.set_order = theirs.set_order.filter((id) => id !== a);
    const found = mergeClashes(base, mine, theirs, [{ path: ["songs", a], local: mine.songs[a], remote: undefined }]);
    expect(found.map((c) => c.change.id)).toEqual([`songs/${a}`]);
    putBack(theirs, mine, [found[0].change], new Set([found[0].change.id]));
    expect(mine.songs[a]).toBeUndefined();
    expect(mine.set_order).not.toContain(a);
  });

  it("reads the Sheet's clashes from the show", () => {
    const show = fresh();
    const [a] = show.set_order;
    const col = show.columns.find((c) => c.type === "text" && c.id !== "name") ?? show.columns.find((c) => c.id === "name")!;
    show.songs[a].fields[col.id] = "APP";
    show.conflicts = { [`show|${a}|${col.id}`]: { sheet: "SHEET", app: "APP", published: "" } };
    const [clash] = sheetClashes(show);
    expect(clash.change.via).toBe("sheet");
    expect(clash.sheetKeys).toEqual([`show|${a}|${col.id}`]);
    expect(clash.theirs.songs[a].fields[col.id]).toBe("SHEET");
    expect(sheetClashes({ ...show, conflicts: {} })).toEqual([]);
  });
});

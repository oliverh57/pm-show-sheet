import { beforeEach, describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { migrate } from "../model/ops";
import type { Show } from "../model/types";
import { FakeDrive } from "./fakeDrive";
import { syncShow, updateManifest } from "./show";

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

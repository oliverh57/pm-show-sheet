import { describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { addReview, migrate, setReviewDone } from "../model/ops";
import type { Show } from "../model/types";
import { merge3, mergeList } from "./merge";

const fresh = () => migrate(structuredClone(sample) as Show);
/** base, and two copies of it to edit. */
function three(): [Show, Show, Show] {
  const base = fresh();
  return [base, structuredClone(base), structuredClone(base)];
}

describe("merge3", () => {
  it("keeps both people's edits to different songs and fields", () => {
    const [base, local, remote] = three();
    const [a, b] = base.set_order;
    local.songs[a].fields.name = "MINE";
    remote.songs[b].fields.name = "THEIRS";
    remote.songs[a].statuses.LX = true;
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.songs[a].fields.name).toBe("MINE");
    expect(merged.songs[b].fields.name).toBe("THEIRS");
    expect(merged.songs[a].statuses.LX).toBe(true);
    expect(conflicts).toEqual([]);
  });

  it("keeps this Mac's value when both change the same field, and says where", () => {
    const [base, local, remote] = three();
    const a = base.set_order[0];
    local.songs[a].fields.name = "MINE";
    remote.songs[a].fields.name = "THEIRS";
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.songs[a].fields.name).toBe("MINE");
    expect(conflicts).toEqual([{ path: ["songs", a, "fields", "name"], local: "MINE", remote: "THEIRS" }]);
  });

  it("a comment resolved on both Macs (each bringing in the same tick from the Sheet) isn't a clash", () => {
    const [base, local, remote] = three();
    const id = addReview(base, { song_id: base.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    [local, remote].forEach((s) => (s.reviews = structuredClone(base.reviews)));
    setReviewDone(local, id, true);
    setReviewDone(remote, id, true);
    local.reviews![0].resolved_at = "2026-10-29T21:01:21.938Z";
    remote.reviews![0].resolved_at = "2026-10-29T21:01:40.002Z";
    const { merged, conflicts } = merge3(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.reviews![0]).toMatchObject({ done: true, resolved_at: "2026-10-29T21:01:40.002Z" });
  });

  it("is a no-op when only one side changed", () => {
    const [base, local, remote] = three();
    remote.venue = "O2";
    expect(merge3(base, local, remote).merged).toEqual(remote);
    expect(merge3(base, remote, local).merged).toEqual(remote);
  });

  it("merges the running order: a reorder here, a song added there", () => {
    const [base, local, remote] = three();
    const [a, b, c] = base.set_order;
    local.set_order = [b, a, c, ...base.set_order.slice(3)];
    remote.set_order = [a, b, "NEW", c, ...base.set_order.slice(3)];
    remote.songs.NEW = { ...structuredClone(base.songs[a]), id: "NEW" };
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.set_order.slice(0, 4)).toEqual([b, "NEW", a, c]); // after b, as they placed it
    expect(merged.songs.NEW).toBeDefined();
    expect(conflicts).toEqual([]);
  });

  it("takes their reorder and keeps a song added here", () => {
    const [base, local, remote] = three();
    const [a, b, c] = base.set_order;
    remote.set_order = [c, b, a, ...base.set_order.slice(3)];
    local.set_order = [a, "MINE", b, c, ...base.set_order.slice(3)];
    expect(merge3(base, local, remote).merged.set_order.slice(0, 4)).toEqual([c, b, a, "MINE"]);
  });

  it("archives a song here while they edit another", () => {
    const [base, local, remote] = three();
    const [a, b] = base.set_order;
    local.set_order = base.set_order.filter((x) => x !== a);
    local.archive = [...base.archive, a];
    remote.songs[b].fields.name = "EDITED";
    const { merged } = merge3(base, local, remote);
    expect(merged.set_order).not.toContain(a);
    expect(merged.archive).toContain(a);
    expect(merged.songs[b].fields.name).toBe("EDITED");
  });

  it("deleted here but edited there: this Mac's delete wins, and it's reported", () => {
    const [base, local, remote] = three();
    const a = base.set_order[0];
    delete local.songs[a];
    local.set_order = base.set_order.slice(1);
    remote.songs[a].fields.name = "EDITED";
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.songs[a]).toBeUndefined();
    expect(merged.set_order).not.toContain(a);
    expect(conflicts.map((c) => c.path)).toEqual([["songs", a]]);
  });

  it("merges columns added on both sides, and edits to an existing one", () => {
    const [base, local, remote] = three();
    local.columns.push({ id: "c_mine", label: "MINE", dept: "LX", type: "text" });
    remote.columns.push({ id: "c_theirs", label: "THEIRS", dept: "LX", type: "text" });
    remote.columns[0].width = 333;
    const { merged, conflicts } = merge3(base, local, remote);
    const ids = merged.columns.map((c) => c.id);
    expect(ids).toContain("c_mine");
    expect(ids).toContain("c_theirs");
    expect(ids.length).toBe(base.columns.length + 2);
    expect(merged.columns[0].width).toBe(333);
    expect(conflicts).toEqual([]);
  });

  it("merges notes and review replies item by item", () => {
    const [base, local, remote] = three();
    base.sessions = [{ id: "s1", label: "DAY 1", notes: [] }];
    local.sessions = [{ id: "s1", label: "DAY 1", notes: [{ id: "n1", song_id: null, text: "mine", tc: "", from: "A", assignee: "", done: false }] }];
    remote.sessions = [{ id: "s1", label: "DAY ONE", notes: [{ id: "n2", song_id: null, text: "theirs", tc: "", from: "B", assignee: "", done: false }] }];
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.sessions[0].label).toBe("DAY ONE");
    expect(merged.sessions[0].notes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(conflicts).toEqual([]);
  });

  it("keeps a comment edited here while they resolve it and reply there", async () => {
    const { addReview, editReview, replyToReview, setReviewDone } = await import("../model/ops");
    const base = fresh();
    const id = addReview(base, { song_id: base.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    const [local, remote] = [structuredClone(base), structuredClone(base)];
    editReview(local, id, "Too dark in the chorus");
    setReviewDone(remote, id, true);
    replyToReview(remote, id, { from: "Ria", text: "Brighter in V2" });
    const { merged, conflicts } = merge3(base, local, remote);
    const c = merged.reviews!.find((x) => x.id === id)!;
    expect(c).toMatchObject({ text: "Too dark in the chorus", edited_at: local.reviews![0].edited_at, done: true });
    expect(c.replies.map((r) => r.text)).toEqual(["Brighter in V2"]);
    expect(conflicts).toEqual([]);
    expect(merge3(base, remote, local).merged.reviews![0]).toMatchObject({ text: "Too dark in the chorus", edited_at: local.reviews![0].edited_at });
  });

  it("both edit the same comment: this Mac's text and its edited time win together, and it's reported", async () => {
    const { addReview } = await import("../model/ops");
    const base = fresh();
    const id = addReview(base, { song_id: base.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    const [local, remote] = [structuredClone(base), structuredClone(base)];
    Object.assign(local.reviews![0], { text: "MINE", edited_at: "2026-10-29T10:00:00.000Z" });
    Object.assign(remote.reviews![0], { text: "THEIRS", edited_at: "2026-10-29T11:00:00.000Z" });
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.reviews![0]).toMatchObject({ text: "MINE", edited_at: "2026-10-29T10:00:00.000Z" });
    expect(conflicts.map((c) => c.path)).toEqual([["reviews", id, "text"], ["reviews", id, "edited_at"]]);
  });

  it("keeps a department set here while they edit the text there, and one taken out", async () => {
    const { addReview, editReview, setReviewDept } = await import("../model/ops");
    const base = fresh();
    const id = addReview(base, { song_id: base.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    const out = addReview(base, { song_id: base.set_order[0], t: 0, text: "Haze", from: "Ria", dept: "SFX" });
    const [local, remote] = [structuredClone(base), structuredClone(base)];
    setReviewDept(local, id, "LX");
    setReviewDept(local, out, "");
    editReview(remote, id, "Too dark in the chorus");
    for (const [a, b] of [[local, remote], [remote, local]]) {
      const { merged, conflicts } = merge3(base, a, b);
      expect(merged.reviews!.find((x) => x.id === id)).toMatchObject({ dept: "LX", text: "Too dark in the chorus" });
      expect(merged.reviews!.find((x) => x.id === out)!.dept).toBeUndefined();
      expect(conflicts).toEqual([]);
    }
  });

  it("both put a comment in a department: this Mac's wins, and it's reported", async () => {
    const { addReview, setReviewDept } = await import("../model/ops");
    const base = fresh();
    const id = addReview(base, { song_id: base.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    const [local, remote] = [structuredClone(base), structuredClone(base)];
    setReviewDept(local, id, "LX");
    setReviewDept(remote, id, "VIDEO");
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.reviews![0].dept).toBe("LX");
    expect(conflicts.map((c) => c.path)).toEqual([["reviews", id, "dept"]]);
  });

  it("merges clips by path", () => {
    const [base, local, remote] = three();
    const a = base.set_order[0];
    const clip = (path: string) => ({ path, record_id: "r", in: 0, out: 1, source: "manual" as const });
    local.songs[a].clips = [clip("media/clips/1.mp4")];
    remote.songs[a].clips = [clip("media/clips/2.mp4")];
    expect(merge3(base, local, remote).merged.songs[a].clips!.map((c) => c.path)).toEqual(["media/clips/1.mp4", "media/clips/2.mp4"]);
  });

  it("keeps both Macs' Google ids", () => {
    const [base, local, remote] = three();
    base.google = { spreadsheet_id: "S", images: { "a.jpg": "1" } };
    local.google = { spreadsheet_id: "S", images: { "a.jpg": "1", "b.jpg": "2" } };
    remote.google = { spreadsheet_id: "S", presentation_id: "D", images: { "a.jpg": "1", "c.jpg": "3" } };
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.google).toEqual({ spreadsheet_id: "S", presentation_id: "D", images: { "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" } });
    expect(conflicts).toEqual([]);
  });

  it("treats lists without ids (colours) as one value", () => {
    const [base, local, remote] = three();
    const a = base.set_order[0];
    local.songs[a].colours = [{ hex: "#ff0000" }];
    remote.songs[a].colours = [{ hex: "#0000ff" }];
    const { merged, conflicts } = merge3(base, local, remote);
    expect(merged.songs[a].colours).toEqual([{ hex: "#ff0000" }]);
    expect(conflicts.length).toBe(1);
  });
});

describe("mergeList", () => {
  it("applies deletes from both sides", () => {
    expect(mergeList(["a", "b", "c", "d"], ["a", "c", "d"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });
  it("puts an insert after its neighbour", () => {
    expect(mergeList(["a", "b"], ["a", "x", "b"], ["b", "a"])).toEqual(["b", "a", "x"]);
    expect(mergeList(["a", "b"], ["x", "a", "b"], ["a", "b", "y"])).toEqual(["x", "a", "b", "y"]);
  });
  it("adds an item both sides added once", () => {
    expect(mergeList(["a"], ["a", "x"], ["a", "x"])).toEqual(["a", "x"]);
  });
});

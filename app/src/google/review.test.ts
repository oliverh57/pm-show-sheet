import { describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { addReview, commentDepts, editReview, migrate, placeTc, recordTc, replyToReview, resolvedToTidy, reviewsOn, setReviewDept, setReviewDone, songByLabel, tidyResolved, unplacedReviews, wroteReview } from "../model/ops";
import type { Show, SourceRecord } from "../model/types";
import { applyReviewEdits, contentRequests, sheetAuthor, diffReviewTab, formatRuleRequests, HEADER_ROWS, keptCells, mergeUpdateRequests, reviewRows, reviewTab, showTab, snapshot } from "./sheet";

/** The sample show with a whole-show record: LTC from 04:00:00:00 at 10s in, the opener marked from 10s to 200s. */
function fresh(): Show {
  const show = migrate(structuredClone(sample) as Show);
  const rec: SourceRecord = {
    id: "rec1", path: "/records/NYC T5.mp4", name: "NYC T5.mp4", label: "NYC T5", scope: "show", added_at: "2026-10-01T00:00:00Z",
    ltc: { channel: 1, fps: 25, duration: 600, blocks: [{ file_start: 10, file_end: 400, tc_start: "04:00:00:00", tc_end: "04:06:30:00" }] },
    song_marks: [{ song_id: show.set_order[0], in: 10, out: 200, source: "auto_tc" }, { song_id: show.set_order[1], in: 200, out: 400, source: "auto_tc" }],
  };
  show.records = [rec];
  show.songs[show.set_order[0]].clips = [{ path: "media/clips/opener.mp4", record_id: "rec1", in: 10, out: 200, source: "auto_tc" }];
  return show;
}

/** What the REVIEW tab reads back after a push. */
function values(show: Show): unknown[][] {
  const g = reviewTab(show, {});
  return [...g.headerRows, ...g.dataRows].map((r) => r.map((c) => (c.formula || c.links ? "" : c.value ?? "")));
}
const col = (show: Show, id: string) => reviewTab(show, {}).colIds.indexOf(id);
const FIRST = HEADER_ROWS + 1; // the first comment's row: under its song's heading

describe("review comments", () => {
  it("takes the show TC from the record's LTC, and a clip shows the comments inside its window", () => {
    const show = fresh();
    const opener = show.set_order[0];
    const id = addReview(show, { song_id: opener, record_id: "rec1", t: 93.4, t_out: 101, text: "Strobe early", from: "Sam" });
    addReview(show, { song_id: show.set_order[1], record_id: "rec1", t: 250, text: "Later", from: "Sam" });
    const c = show.reviews!.find((x) => x.id === id)!;
    expect(c).toMatchObject({ tc: "04:01:23:10", tc_out: "04:01:31:00", done: false, replies: [], source: "app" });
    expect(reviewsOn(show, "rec1", 10, 200).map((x) => x.text)).toEqual(["Strobe early"]);
    expect(reviewsOn(show, "rec1").length).toBe(2);
    expect(recordTc(show.records![0], 5)).toBeNull(); // before the LTC starts
  });
  it("finds songs and places TCs typed in the Sheet", () => {
    const show = fresh();
    const [a, b] = show.set_order;
    const name = show.songs[a].fields.name!;
    expect(songByLabel(show, name.toLowerCase())).toBe(a);
    expect(songByLabel(show, `01 ${name}`)).toBe(a);
    expect(songByLabel(show, "02")).toBe(b);
    expect(placeTc(show, a, "04:01:00:00")).toEqual({ record_id: "rec1", t: 70 });
    expect(placeTc(show, a, "04:05:00:00")).toBeNull(); // that's the second song's part of the record
    expect(placeTc(show, b, "04:05:00:00")).toEqual({ record_id: "rec1", t: 310 });
  });
});

describe("tidying resolved comments", () => {
  const DAY = 86400000;
  it("deletes comments resolved longer ago than the show keeps them (3 days unless set), and never open ones", () => {
    const show = fresh();
    const [a] = show.set_order;
    const old = addReview(show, { song_id: a, t: 0, text: "Old", from: "Sam" });
    const recent = addReview(show, { song_id: a, t: 0, text: "Recent", from: "Sam" });
    const open = addReview(show, { song_id: a, t: 0, text: "Open", from: "Sam" });
    setReviewDone(show, old, true);
    setReviewDone(show, recent, true);
    const now = Date.now();
    show.reviews!.find((c) => c.id === old)!.resolved_at = new Date(now - 4 * DAY).toISOString();
    show.reviews!.find((c) => c.id === recent)!.resolved_at = new Date(now - 2 * DAY).toISOString();
    expect(resolvedToTidy(show, now)).toEqual({ expired: [old], unstamped: false });
    show.keep_resolved_days = 1;
    expect(resolvedToTidy(show, now).expired).toEqual([old, recent]);
    show.keep_resolved_days = null;
    expect(resolvedToTidy(show, now).expired).toEqual([]);
    delete show.keep_resolved_days;
    expect(tidyResolved(show, now)).toBe(1);
    expect(show.reviews!.map((c) => c.id)).toEqual([recent, open]);
  });
  it("stamps a resolved comment with no time, keeping it the full time from then; reopening clears it", () => {
    const show = fresh();
    const id = addReview(show, { song_id: show.set_order[0], t: 0, text: "Legacy", from: "Sam" });
    Object.assign(show.reviews![0], { done: true });
    const now = Date.now();
    expect(resolvedToTidy(show, now)).toEqual({ expired: [], unstamped: true });
    tidyResolved(show, now);
    expect(show.reviews![0].resolved_at).toBe(new Date(now).toISOString());
    expect(resolvedToTidy(show, now + 4 * DAY).expired).toEqual([id]);
    setReviewDone(show, id, false);
    expect(show.reviews![0].resolved_at).toBeUndefined();
  });
});

describe("REVIEW tab", () => {
  it("groups open comments under a heading per song, in running order with their replies, and resolved ones at the bottom", () => {
    const show = fresh();
    const [a, b] = show.set_order;
    const late = addReview(show, { song_id: b, record_id: "rec1", t: 250, text: "Second song", from: "Ria" });
    const early = addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "First song", from: "Sam" });
    const fixed = addReview(show, { song_id: a, record_id: "rec1", t: 20, text: "Fixed", from: "Sam" });
    setReviewDone(show, fixed, true);
    const re = replyToReview(show, early, { from: "Oliver", text: "On it" });
    const g = reviewTab(show, {});
    expect(g.rowIds).toEqual([`song|${a}`, early, `${early}/${re}`, `song|${b}`, late, "resolved", fixed]);
    const heading = g.dataRows[0];
    expect(heading[1].value).toBe(`01 ${show.songs[a].fields.name}`.toUpperCase());
    expect(heading[col(show, "tc")].value).toBe("1 open");
    expect(g.dataRows[5][1].value).toBe("RESOLVED");
    expect(g.plainRows).toEqual([0, 3, 5]);
    expect(g.rowHeights).toEqual([30, 48, 36, 30, 48, 30, 48]);
    expect(g.editableCols.map((i) => g.colIds[i])).toEqual(["song", "tc", "dept", "comment", "from", "reply", "done"]);
    expect(g.dataRows[1][col(show, "clip")].links?.[0].text).toBe("▶ NYC T5 @ 0:40");
  });
  it("counts open comments in the banner with a formula, and keeps ticks and dropdowns off the headings", () => {
    const show = fresh();
    addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 50, text: "One", from: "Sam" });
    addReview(show, { song_id: show.set_order[1], record_id: "rec1", t: 250, text: "Two", from: "Sam" });
    const g = reviewTab(show, {});
    const counter = g.headerRows[1].find((c) => c.formula?.includes("OPEN COMMENTS"))!;
    expect(counter.formula).toBe(`=SUMPRODUCT((LEN(F5:F)>0)*(J5:J<>TRUE)*(C5:C<>"↳ reply"))&" OPEN COMMENTS"`);
    const ticks = contentRequests(g, 9).flatMap((r) => {
      const v = (r as { setDataValidation?: { range: { startRowIndex: number; endRowIndex?: number }; rule?: { condition: { type: string } } } }).setDataValidation;
      return v?.rule?.condition.type === "BOOLEAN" ? [[v.range.startRowIndex, v.range.endRowIndex]] : [];
    });
    expect(ticks).toEqual([[FIRST, FIRST + 1], [FIRST + 2, FIRST + 3]]);
  });
  it("gives SONG a dropdown of every song, off the reply rows and on down the empty rows for new comments", () => {
    const show = fresh();
    const [a] = show.set_order;
    const id = addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "One", from: "Sam" });
    replyToReview(show, id, { from: "Ria", text: "Two" });
    addReview(show, { song_id: a, record_id: "rec1", t: 60, text: "Three", from: "Sam" });
    const g = reviewTab(show, {});
    const songCol = col(show, "song");
    const options = g.choiceCols.find(([ci]) => ci === songCol)![1];
    expect(options[0]).toBe(`01 ${show.songs[a].fields.name}`);
    expect(options).toHaveLength(show.set_order.length + show.archive.length);
    type V = { setDataValidation?: { range: { startRowIndex: number; endRowIndex?: number; startColumnIndex: number }; rule?: { condition: { type: string; values?: { userEnteredValue: string }[] } } } };
    const dropdowns = contentRequests(g, 9).flatMap((r) => {
      const v = (r as V).setDataValidation;
      return v?.rule?.condition.type === "ONE_OF_LIST" && v.range.startColumnIndex === songCol ? [[v.range.startRowIndex, v.range.endRowIndex]] : [];
    });
    // heading, comment, reply, comment: the dropdown skips the heading and the reply, and the last run has no end
    expect(dropdowns).toEqual([[FIRST, FIRST + 1], [FIRST + 2, undefined]]);
  });
  it("greys out resolved rows with its own rule, leaving rules people added", () => {
    const show = fresh();
    addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 50, text: "One", from: "Sam" });
    const g = reviewTab(show, {});
    const theirs = { booleanRule: { condition: { values: [{ userEnteredValue: "=$E5=\"LX\"" }] } } };
    const first = formatRuleRequests(g, 9, [theirs]);
    expect(first).toHaveLength(1);
    const added = (first[0] as { addConditionalFormatRule: { rule: { booleanRule: { condition: { values: { userEnteredValue: string }[] } } } } }).addConditionalFormatRule.rule;
    const ours = { booleanRule: added.booleanRule };
    expect(formatRuleRequests(g, 9, [ours, theirs])[0]).toEqual({ deleteConditionalFormatRule: { sheetId: 9, index: 0 } });
    expect(formatRuleRequests(showTab(show, {}), 9, [theirs]).filter((r) => "deleteConditionalFormatRule" in r)).toEqual([]); // only its colour fills are added
  });
  it("merges the header again only when its layout changed", () => {
    const show = fresh();
    const g = reviewTab(show, {});
    const as = (m: number[]) => ({ startRowIndex: m[0], endRowIndex: m[1], startColumnIndex: m[2], endColumnIndex: m[3] });
    expect(mergeUpdateRequests(g, 9, g.merges.map(as))).toEqual([]);
    const n = g.colIds.length;
    const before = [[1, 2, 1, 3], [1, 2, 3, n], [2, 3, 1, 3], [2, 3, 3, n]].map(as);
    expect(mergeUpdateRequests(g, 9, before)).toHaveLength(1 + g.merges.length);
  });
  it("never merges across the frozen columns' edge (Sheets refuses the whole push)", () => {
    const show = fresh();
    addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 50, text: "One", from: "Sam" });
    for (const g of [reviewTab(show, {}), showTab(show, {}), showTab(show, {}, {}, true)]) {
      for (const [, , c0, c1] of g.merges) expect(c0 < g.frozenCols && c1 > g.frozenCols, `${g.title} ${c0}-${c1}`).toBe(false);
    }
  });
  it("brings back ticks, edits, replies and new rows from the Sheet", () => {
    const show = fresh();
    const [a] = show.set_order;
    const id = addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "Strobe early", from: "Sam" });
    const published = snapshot(show);
    const v = values(show);
    const row = v[FIRST];
    row[col(show, "done")] = true;
    row[col(show, "comment")] = "Strobe a beat early";
    row[col(show, "reply")] = "Ria: fixed in V3";
    v.push(["", "", show.songs[a].fields.name, "04:01:00:00", "LX", "Haze too thick here", "Sam", "", "", "", ""]);
    const edits = diffReviewTab(show, published, v);
    expect(edits.map((e) => e.kind)).toEqual(["set", "set", "reply", "new"]);
    applyReviewEdits(show, edits, new Map([[v.length - 1, "rev_new"]]));
    const c = show.reviews!.find((x) => x.id === id)!;
    expect(c).toMatchObject({ done: true, text: "Strobe a beat early" });
    expect(c.edited_at).toBeDefined(); // shown as edited in the app
    expect(c.replies[0]).toMatchObject({ from: "Ria", text: "fixed in V3" });
    expect(show.reviews!.find((x) => x.id === "rev_new")).toMatchObject({ song_id: a, record_id: "rec1", t: 70, tc: "04:01:00:00", dept: "LX", from: "Sam", source: "sheet" });
  });
  it("reads only the first copy of a row (a second is left when two Macs push at once)", () => {
    const show = fresh();
    const [a, b] = show.set_order;
    addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "Strobe early", from: "Sam" });
    addReview(show, { song_id: b, record_id: "rec1", t: 250, text: "Haze", from: "Ria" });
    const published = snapshot(show);
    const v = values(show);
    v.push([...v[FIRST]]);
    v[v.length - 1][col(show, "comment")] = "Haze";
    expect(diffReviewTab(show, published, v)).toEqual([]);
  });
  it("edits a comment's text and marks it edited, only when the text changes", () => {
    const show = fresh();
    const id = addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 50, text: "Strobe early", from: "Sam" });
    const c = show.reviews![0];
    editReview(show, id, "Strobe early");
    expect(c.edited_at).toBeUndefined();
    editReview(show, id, "Strobe a beat early");
    expect(c.text).toBe("Strobe a beat early");
    expect(Date.parse(c.edited_at!)).toBeGreaterThanOrEqual(Date.parse(c.at));
    editReview(show, "nope", "x"); // a comment deleted meanwhile: nothing happens
  });
  it("puts a posted comment in a department, changes it, or takes it out", () => {
    const show = fresh();
    const id = addReview(show, { song_id: show.set_order[0], t: 0, text: "Too dark", from: "Sam" });
    const c = show.reviews![0];
    setReviewDept(show, id, "LX");
    expect(c.dept).toBe("LX");
    setReviewDept(show, id, "VIDEO");
    expect(c.dept).toBe("VIDEO");
    setReviewDept(show, id, "");
    expect("dept" in c).toBe(false);
    expect(c.edited_at).toBeUndefined(); // the text wasn't changed
    expect(commentDepts(show)).toContain("LX");
    expect(commentDepts(show)).not.toContain("CORE"); // the Sheet's own columns aren't departments to comment for
  });
  it("lets only the person who wrote a comment edit it", () => {
    const show = fresh();
    const [a] = show.set_order;
    const sam = { name: "Sam", email: "sam@pm.com" };
    addReview(show, { song_id: a, t: 0, text: "Mine", from: "Sam", email: "Sam@PM.com" });
    addReview(show, { song_id: a, t: 0, text: "Ria's", from: "Ria", email: "ria@pm.com" });
    addReview(show, { song_id: a, t: 0, text: "Same name, other email", from: "Sam", email: "sam@other.com" });
    addReview(show, { song_id: a, t: 0, text: "Signed out", from: "Me" });
    addReview(show, { song_id: a, t: 0, text: "In the Sheet", from: "Sam", source: "sheet" });
    const [mine, rias, other, signedOut, sheet] = show.reviews!;
    expect(wroteReview(mine, sam)).toBe(true);
    expect(wroteReview(rias, sam)).toBe(false);
    expect(wroteReview(other, sam)).toBe(false);
    expect(wroteReview(mine, null)).toBe(false);
    expect(wroteReview(signedOut, null)).toBe(true);
    expect(wroteReview(signedOut, sam)).toBe(false);
    expect(wroteReview(sheet, sam)).toBe(false); // edited in the Sheet
  });
  it("lets the app win when both sides changed, and resolves a thread from a reply row's tick", () => {
    const show = fresh();
    const [a] = show.set_order;
    const id = addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "One", from: "Sam" });
    replyToReview(show, id, { from: "Oliver", text: "Two" });
    const published = snapshot(show);
    const v = values(show);
    v[FIRST][col(show, "comment")] = "Sheet text";
    v[FIRST + 1][col(show, "done")] = true;
    show.reviews![0].text = "App text";
    const edits = diffReviewTab(show, published, v);
    expect(edits).toEqual([{ kind: "set", id: `${id}/${show.reviews![0].replies[0].id}`, col: "done", value: true }]);
    applyReviewEdits(show, edits, new Map());
    expect(show.reviews![0]).toMatchObject({ text: "App text", done: true });
  });
  it("keeps a Sheet comment whose TC isn't in any record, unplaced, and re-places it when the TC is fixed", () => {
    const show = fresh();
    const [a] = show.set_order;
    const published = snapshot(show);
    const v = values(show);
    v.push(["", "", `01 ${show.songs[a].fields.name}`, "05:00:00:00", "", "Wrong TC", "", "", "", "", ""]);
    applyReviewEdits(show, diffReviewTab(show, published, v), new Map([[v.length - 1, "rev_x"]]));
    expect(unplacedReviews(show, a).map((c) => [c.id, c.tc, c.from])).toEqual([["rev_x", "05:00:00:00", "Google Sheet"]]);
    const pushed = snapshot(show);
    const w = values(show);
    w[FIRST][col(show, "tc")] = "04:00:30:00 → 04:00:40:00";
    applyReviewEdits(show, diffReviewTab(show, pushed, w), new Map());
    expect(show.reviews![0]).toMatchObject({ record_id: "rec1", t: 40, t_out: 50, tc: "04:00:30:00", tc_out: "04:00:40:00" });
    setReviewDone(show, "rev_x", true);
    expect(reviewRows(show)[0].values.done).toBe(true);
  });
  it("lists a comment on the song itself (no frame or image) under its song, with no TC or frame", () => {
    const show = fresh();
    const [a] = show.set_order;
    const id = addReview(show, { song_id: a, t: 0, text: "Whole song feels too dark", from: "Ria", dept: "LX" });
    expect(unplacedReviews(show, a).map((c) => c.id)).toEqual([id]);
    const g = reviewTab(show, {});
    expect(g.rowIds).toEqual([`song|${a}`, id]);
    const row = g.dataRows[1];
    expect([row[col(show, "tc")].value, row[col(show, "frame")].value, row[col(show, "comment")].value]).toEqual(["", "", "Whole song feels too dark"]);
  });
  it("works out who typed an unnamed Sheet comment from who edited the Sheet since it was last read", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 10, min)).toISOString();
    const since = Date.parse(at(10));
    const rev = (min: number, name: string, email: string, me = false) => ({ modifiedTime: at(min), lastModifyingUser: { displayName: name, emailAddress: email, me } });
    const me = (min: number) => rev(min, "Oliver", "oliver@pm.com", true);
    const ria = (min: number) => rev(min, "Ria", "ria@pm.com");
    const sam = (min: number) => rev(min, "Sam", "sam@pm.com");
    expect(sheetAuthor([sam(5), me(11), ria(12)], since, [])).toEqual({ name: "Ria", email: "ria@pm.com" }); // Sam's edit was before the last read
    expect(sheetAuthor([me(11), me(12)], since, [])).toEqual({ name: "Oliver", email: "oliver@pm.com" }); // only you: it's yours
    expect(sheetAuthor([ria(11), sam(12)], since, ["sam@pm.com"])).toEqual({ name: "Ria", email: "ria@pm.com" }); // Sam syncs from the app
    expect(sheetAuthor([ria(11), sam(12)], since, ["SAM@pm.com"])).toEqual({ name: "Ria", email: "ria@pm.com" });
    expect(sheetAuthor([ria(11), sam(12)], since, [])).toBeNull(); // can't tell
    expect(sheetAuthor([], since, [])).toBeNull();
  });
  it("puts an unnamed Sheet comment and reply down to the author, keeping a name that's typed", () => {
    const show = fresh();
    const [a] = show.set_order;
    const id = addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "One", from: "Sam" });
    const published = snapshot(show);
    const v = values(show);
    v[FIRST][col(show, "reply")] = "Agreed";
    v.push(["", "", `01 ${show.songs[a].fields.name}`, "", "", "Unnamed", "", "", "", "", ""]);
    v.push(["", "", `01 ${show.songs[a].fields.name}`, "", "", "Named", "Sam", "", "", "", ""]);
    applyReviewEdits(show, diffReviewTab(show, published, v), new Map([[v.length - 2, "rev_u"], [v.length - 1, "rev_n"]]), { name: "Ria", email: "ria@pm.com" });
    expect(show.reviews!.find((c) => c.id === "rev_u")).toMatchObject({ from: "Ria", email: "ria@pm.com" });
    expect(show.reviews!.find((c) => c.id === "rev_n")).toMatchObject({ from: "Sam" });
    expect(show.reviews!.find((c) => c.id === "rev_n")!.email).toBeUndefined();
    expect(show.reviews!.find((c) => c.id === id)!.replies[0]).toMatchObject({ from: "Ria", email: "ria@pm.com", text: "Agreed" });
  });
  it("gives a new row with a blank SONG the song whose heading it's under", () => {
    const show = fresh();
    const [a, b] = show.set_order;
    addReview(show, { song_id: a, record_id: "rec1", t: 50, text: "One", from: "Sam" });
    addReview(show, { song_id: b, record_id: "rec1", t: 250, text: "Two", from: "Sam" });
    const published = snapshot(show);
    const v = values(show);
    v.splice(FIRST + 1, 0, ["", "", "", "", "", "Under the first", "Ria", "", "", "", ""]);
    applyReviewEdits(show, diffReviewTab(show, published, v), new Map([[FIRST + 1, "rev_h"]]));
    expect(show.reviews!.find((c) => c.id === "rev_h")).toMatchObject({ song_id: a, from: "Ria" });
  });
});

describe("pushing the REVIEW tab", () => {
  it("leaves a reply or comment edit typed during the sync, and writes what the app changed", () => {
    const show = fresh();
    const id = addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 50, text: "Brighter", from: "Sam" });
    const other = addReview(show, { song_id: show.set_order[0], record_id: "rec1", t: 60, text: "Slower", from: "Sam" });
    const published = snapshot(show);
    show.reviews!.find((c) => c.id === other)!.text = "Much slower";
    const g = reviewTab(show, {});
    const keep = keptCells(g, "review", snapshot(show), published, new Set(g.rowIds));
    const row = (rid: string) => g.rowIds.indexOf(rid);
    expect(keep(row(id), col(show, "reply"))).toBe(true);
    expect(keep(row(id), col(show, "comment"))).toBe(true);
    expect(keep(row(other), col(show, "comment"))).toBe(false);
    expect(keep(row(`song|${show.set_order[0]}`), col(show, "reply"))).toBe(false); // a heading isn't a comment
  });
});

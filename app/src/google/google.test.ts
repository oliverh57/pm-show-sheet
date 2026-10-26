import { describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import { addCustomField, imageColumnFor, migrate, sheetEditable } from "../model/ops";
import type { Show } from "../model/types";
import { contentRequests, diffShowTab, formatRuleRequests, HEADER_ROWS, keptCells, protectionUpdateRequests, reconcileRows, showTab, snapshot, spareColumnRequests, structureRequests } from "./sheet";
import { deckRequests } from "./slides";

const fresh = () => migrate(structuredClone(sample) as Show);

/** What the Sheet would read back after a push: header rows, then data rows, as plain values. */
function sheetValues(show: Show): unknown[][] {
  const g = showTab(show, {});
  return [...g.headerRows, ...g.dataRows].map((r) => r.map((c) => (c.formula ? "" : c.value ?? "")));
}

describe("SHOW SHEET tab", () => {
  it("fills colour fields with their colour and gives list fields a dropdown of their options", () => {
    const show = fresh();
    const laser = addCustomField(show, "Laser colour", "palette");
    const trim = addCustomField(show, "Trim", "choice", ["Out", "Deck"]);
    show.songs.s_opener.swatches = { [laser]: [{ hex: "#00FF00", label: "Green" }, { hex: "#0000FF", label: "Blue" }] };
    const g = showTab(show, {});
    const row = g.dataRows[g.rowIds.indexOf("s_opener")];
    expect(row[g.colIds.indexOf(laser)]).toMatchObject({ value: "Green, Blue", bg: "#00FF00" });
    expect(g.editableCols).toEqual(expect.arrayContaining([g.colIds.indexOf(laser), g.colIds.indexOf(trim)]));
    const rule = contentRequests(g, 1).map((r) => (r as { setDataValidation?: { rule?: { condition: { type: string; values: unknown[] } } } }).setDataValidation?.rule)
      .find((r) => r?.condition.type === "ONE_OF_LIST");
    expect(rule?.condition.values).toEqual([{ userEnteredValue: "Out" }, { userEnteredValue: "Deck" }]);
  });
  it("clears every old validation rule before setting the current ones, so moved columns don't keep them", () => {
    const g = showTab(fresh(), {});
    const vals = contentRequests(g, 1).flatMap((r) => ("setDataValidation" in r ? [r.setDataValidation as { range: Record<string, number>; rule?: unknown }] : []));
    expect(vals[0]).toEqual({ range: { sheetId: 1, startRowIndex: HEADER_ROWS } });
    expect(vals.slice(1).length).toBe(g.tickCols.length + g.choiceCols.length + g.colourPickCols!.length);
  });
  it("has an id column, rows in running order, and Cont. after a segue", () => {
    const show = fresh();
    const g = showTab(show, {});
    expect(g.colIds[0]).toBe("__id");
    expect(g.rowIds).toEqual(show.set_order);
    expect([...g.headerRows, ...g.dataRows].every((r) => r.length === g.colIds.length)).toBe(true);
    expect(g.dataRows[g.rowIds.indexOf("s_seven")][g.colIds.indexOf("tc")].value).toBe("09:00:00:00 (Cont.)");
    for (const [, , c0, c1] of g.merges) expect(c1 <= g.frozenCols || c0 >= g.frozenCols).toBe(true);
  });
  it("puts archived songs on their own ARCHIVED SONGS tab, with the same columns", () => {
    const show = fresh();
    const set = showTab(show, {});
    const arch = showTab(show, {}, {}, true);
    expect(show.archive.length).toBeGreaterThan(0);
    expect(arch.rowIds).toEqual(show.archive);
    expect(set.rowIds.some((id) => show.archive.includes(id))).toBe(false);
    expect(arch.colIds).toEqual(set.colIds);
    expect(arch.title).toBe("ARCHIVED SONGS");
    expect((structureRequests(arch, 1002)[0] as { addSheet: { properties: { title: string } } }).addSheet.properties.title).toBe("ARCHIVED SONGS");
    // An archived song's ✎ edits come back like any other.
    const col = show.columns.find((c) => sheetEditable(c) && c.type === "longtext")!.id;
    const id = show.archive[0];
    const v = [...arch.headerRows, ...arch.dataRows].map((r) => r.map((c) => (c.formula ? "" : c.value ?? "")));
    v[HEADER_ROWS + arch.rowIds.indexOf(id)][arch.colIds.indexOf(col)] = "From the archive tab";
    expect(diffShowTab(show, snapshot(show), v).edits).toEqual([{ songId: id, colId: col, value: "From the archive tab" }]);
  });
  it("moves a song between the tabs when it's archived, removing the old archive rows from SHOW SHEET", () => {
    const show = fresh();
    const before = [...show.set_order, "__archive", ...show.archive]; // a tab from when the archive sat under a divider
    expect(reconcileRows(before, showTab(show, {}).rowIds)).toEqual(
      [...show.archive, "__archive"].map((_, i, xs) => ["delete", show.set_order.length + xs.length - 1 - i]));
  });
  it("leaves only the ✎ columns unprotected, with one sheet protection, warning the owner off the rest", () => {
    const show = fresh();
    const g = showTab(show, {});
    type Add = { addProtectedRange: { protectedRange: { warningOnly: boolean; range: { startColumnIndex?: number; endColumnIndex?: number }; unprotectedRanges?: { startColumnIndex: number }[] } } };
    const protects = (protectionUpdateRequests(g, 1001, [], ["me@x.com"]) as Add[]).map((r) => r.addProtectedRange.protectedRange);
    // A tab takes only one sheet protection (no column bounds); the warnings are column ranges.
    const sheetWide = protects.filter((p) => p.range.startColumnIndex === undefined);
    expect(sheetWide).toHaveLength(1);
    expect(sheetWide[0].warningOnly).toBe(false);
    expect(sheetWide[0].unprotectedRanges!.map((r) => g.colIds[r.startColumnIndex])).toEqual(show.columns.filter(sheetEditable).map((c) => c.id));
    const warned = protects.filter((p) => p.warningOnly).flatMap((p) => g.colIds.slice(p.range.startColumnIndex, p.range.endColumnIndex));
    expect(warned).toEqual(["__id", ...show.columns.filter((c) => !sheetEditable(c)).map((c) => c.id)]);
    expect(structureRequests(g, 1001).some((r) => "addProtectedRange" in r)).toBe(false);
  });
  it("lets collaborators edit the status ticks and BPM, but not the running order's own fields", () => {
    const show = fresh();
    const editable = show.columns.filter(sheetEditable).map((c) => c.id);
    expect(editable).toEqual(expect.arrayContaining(["bpm", ...show.columns.filter((c) => c.type === "tick").map((c) => c.id)]));
    for (const id of ["num", "name", "tc", "audio", "hero"]) expect(editable).not.toContain(id);
  });
  it("locks an existing tab again only when its ✎ columns changed", () => {
    const g = showTab(fresh(), {});
    const fresh_ = protectionUpdateRequests(g, 1001, [], ["me@x.com"]) as { addProtectedRange: { protectedRange: Record<string, unknown> } }[];
    // What the Sheets API lists after those requests ran.
    const current = fresh_.map((r, i) => ({ protectedRangeId: i + 1, ...r.addProtectedRange.protectedRange })) as never[];
    expect(protectionUpdateRequests(g, 1001, current, ["me@x.com"])).toEqual([]);
    // A tab from before BPM and the ticks were ✎, with no warnings: replaced.
    const old = [{ protectedRangeId: 7, unprotectedRanges: g.editableCols.slice(1).map((c) => ({ startColumnIndex: c })) }];
    const reqs = protectionUpdateRequests(g, 1001, old, ["me@x.com"]);
    expect(reqs[0]).toEqual({ deleteProtectedRange: { protectedRangeId: 7 } });
    expect(reqs.slice(1)).toEqual(fresh_);
    expect(protectionUpdateRequests(g, 1001, current, ["me@x.com"], true)).toHaveLength(current.length * 2);
    // Someone new uses the show in the app: they're added to the lock's editors. Google listing extra editors is fine.
    expect(protectionUpdateRequests(g, 1001, current, ["me@x.com", "Collab@other.com"])).not.toEqual([]);
    const withOwner = current.map((p: { editors?: { users: string[] } }) => (p.editors ? { ...p, editors: { users: ["owner@x.com", ...p.editors.users] } } : p)) as never[];
    expect(protectionUpdateRequests(g, 1001, withOwner, ["ME@x.com"])).toEqual([]);
  });
});

describe("row reconcile", () => {
  it.each([
    [["a", "b", "c"], ["a", "b", "c"], []],
    [["a", "b", "c"], ["c", "a", "b"], [["move", 2, 0]]],
    [["a", "c"], ["a", "b", "c"], [["insert", 1]]],
    [["a", "x", "b"], ["a", "b"], [["move", 2, 1], ["delete", 2]]],
    [["a", "", "b"], ["a", "b"], [["move", 2, 1]]],
  ])("%j → %j", (cur, want, ops) => {
    expect(reconcileRows(cur, want)).toEqual(ops);
  });
});

describe("colour cells", () => {
  it("offer every library colour and the show's own names as a dropdown, other names allowed", () => {
    const show = fresh();
    show.songs.s_opener.colours = [{ hex: "#123456", label: "Laser green" }, { hex: "#FFC4DC", label: "Baby Pink" }];
    const g = showTab(show, {});
    const names = g.colours!.map((c) => c.label);
    expect(names).toContain("Steel Blue");
    expect(names.filter((n) => n === "Baby Pink")).toHaveLength(1);
    expect(g.colours!.find((c) => c.label === "Laser green")).toEqual({ label: "Laser green", hex: "#123456" });
    const c1 = g.colIds.indexOf("colour_1");
    const rule = contentRequests(g, 1).flatMap((r) => ("setDataValidation" in r ? [r.setDataValidation as { range: { startColumnIndex?: number }; rule?: { strict: boolean; condition: { values: unknown[] } } }] : []))
      .find((v) => v.range.startColumnIndex === c1)!.rule!;
    expect(rule.strict).toBe(false);
    expect(rule.condition.values).toHaveLength(names.length);
  });
  it("give colour fields the dropdown too, filled from a list's first colour, with a spare column so the last isn't cut off", () => {
    const show = fresh();
    const laser = addCustomField(show, "Laser colour", "palette");
    const g = showTab(show, {});
    const ci = g.colIds.indexOf(laser);
    expect(g.colourPickCols).toContain(ci);
    expect(contentRequests(g, 1).some((r) => "setDataValidation" in r && (r.setDataValidation as { range: { startColumnIndex?: number }; rule?: unknown }).range.startColumnIndex === ci
      && (r.setDataValidation as { rule?: unknown }).rule)).toBe(true);
    const formula = (formatRuleRequests(g, 1, []).find((r) => "addConditionalFormatRule" in r) as { addConditionalFormatRule: { rule: { booleanRule: { condition: { values: { userEnteredValue: string }[] } } } } })
      .addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue;
    expect(formula).toMatch(/LEFT\((\w+),FIND\(",",\1&","\)-1\)/);
    const add = structureRequests(g, 1)[0] as { addSheet: { properties: { gridProperties: { columnCount: number } } } };
    expect(add.addSheet.properties.gridProperties.columnCount).toBe(g.colIds.length + 1);
    expect(spareColumnRequests(g, 1, g.colIds.length)).toEqual([{ appendDimension: { sheetId: 1, dimension: "COLUMNS", length: 1 } }]);
    expect(spareColumnRequests(g, 1, g.colIds.length + 1)).toEqual([]);
    // Kept blank and white (an added column takes the format of the one before it).
    expect(contentRequests(g, 1)).toContainEqual({ repeatCell: { range: { sheetId: 1, startRowIndex: 0, startColumnIndex: g.colIds.length, endColumnIndex: g.colIds.length + 1 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } }, fields: "userEnteredValue,userEnteredFormat" } });
    expect(contentRequests(g, 1)).toContainEqual({ updateDimensionProperties: { range: { sheetId: 1, dimension: "COLUMNS", startIndex: g.colIds.length, endIndex: g.colIds.length + 1 },
      properties: { pixelSize: 30 }, fields: "pixelSize" } });
  });
  it("fill when they name a colour, with rules made again only when the colours or columns change", () => {
    const show = fresh();
    const g = showTab(show, {});
    const made = formatRuleRequests(g, 1, []).flatMap((r) => ("addConditionalFormatRule" in r ? [r.addConditionalFormatRule as { rule: { booleanRule: { condition: { values: { userEnteredValue: string }[] } } } }] : []));
    expect(made).toHaveLength(g.colours!.length);
    const asListed = [...made].reverse().map((a) => ({ booleanRule: { condition: { values: a.rule.booleanRule.condition.values } } }));
    expect(asListed[0].booleanRule.condition.values[0].userEnteredValue).toContain(`"${g.colours![0].label.toLowerCase()}"`);
    expect(formatRuleRequests(g, 1, asListed)).toEqual([]); // unchanged: nothing sent
    show.songs.s_opener.colours = [{ hex: "#123456", label: "Laser green" }];
    const again = formatRuleRequests(showTab(show, {}), 1, asListed);
    expect(again.filter((r) => "deleteConditionalFormatRule" in r)).toHaveLength(asListed.length);
    expect(again.filter((r) => "addConditionalFormatRule" in r)).toHaveLength(asListed.length + 1);
  });
});

describe("pulling Sheet edits", () => {
  const editable = (show: Show) => show.columns.find((c) => sheetEditable(c) && c.type === "longtext")!.id;
  it("takes a ✎ edit the app didn't also make", () => {
    const show = fresh();
    const col = editable(show);
    const published = snapshot(show);
    const v = sheetValues(show);
    v[HEADER_ROWS + showTab(show, {}).rowIds.indexOf("s_glass")][showTab(show, {}).colIds.indexOf(col)] = "Cameras back in for the final chorus";
    expect(diffShowTab(show, published, v)).toEqual({ edits: [{ songId: "s_glass", colId: col, value: "Cameras back in for the final chorus" }], conflicts: [] });
  });
  it("ignores edits to protected columns, and flags a clash when both sides changed", () => {
    const show = fresh();
    const col = editable(show);
    const published = snapshot(show);
    const g = showTab(show, {});
    const v = sheetValues(show);
    v[HEADER_ROWS + g.rowIds.indexOf("s_glass")][g.colIds.indexOf("name")] = "hacked";
    v[HEADER_ROWS + g.rowIds.indexOf("s_lights")][g.colIds.indexOf(col)] = "sheet version";
    show.songs.s_lights.fields[col] = "app version";
    const res = diffShowTab(show, published, v);
    expect(res.edits).toEqual([]);
    expect(res.conflicts).toEqual([{ songId: "s_lights", colId: col, sheet: "sheet version", app: "app version", published: published[`show|s_lights|${col}`] }]);
  });
  it("finds nothing to do when the Sheet matches what was pushed", () => {
    const show = fresh();
    expect(diffShowTab(show, snapshot(show), sheetValues(show))).toEqual({ edits: [], conflicts: [] });
  });
});

/** Write a push's cell values into `v`, the Sheet as plain values (formats and other requests ignored). */
function applyValues(v: unknown[][], reqs: object[]) {
  type Up = { start: { rowIndex: number; columnIndex: number }; rows: { values: { userEnteredValue?: Record<string, unknown> }[] }[]; fields: string };
  for (const r of reqs) {
    const up = (r as { updateCells?: Up }).updateCells;
    if (!up?.fields.includes("userEnteredValue")) continue;
    up.rows.forEach((row, i) => row.values.forEach((cell, j) => {
      const val = cell.userEnteredValue;
      (v[up.start.rowIndex + i] ??= [])[up.start.columnIndex + j] = val?.stringValue ?? val?.boolValue ?? "";
    }));
  }
}

describe("pushing over Sheet edits", () => {
  const editable = (show: Show) => show.columns.find((c) => sheetEditable(c) && c.type === "longtext")!.id;
  it("leaves a ✎ cell the app didn't change, so an edit typed there during the sync is pulled next time", () => {
    const show = fresh();
    const col = editable(show);
    const published = snapshot(show);
    const sheet = sheetValues(show);
    const g0 = showTab(show, {});
    const at = (rid: string) => sheet[HEADER_ROWS + g0.rowIds.indexOf(rid)];
    const ci = g0.colIds.indexOf(col);
    show.songs.s_lights.fields[col] = "app version";
    show.songs.s_glass.fields.name = "Glass (edit)";
    // The pull has read the Sheet; then someone types in it before the push writes.
    at("s_glass")[ci] = "typed during the sync";
    const g = showTab(show, {});
    applyValues(sheet, contentRequests(g, 1, keptCells(g, "show", snapshot(show), published, new Set(g.rowIds))));
    expect(at("s_lights")[ci]).toBe("app version");
    expect(at("s_glass")[ci]).toBe("typed during the sync");
    expect(at("s_glass")[g.colIds.indexOf("name")]).toBe("Glass (edit)");
    expect(diffShowTab(show, snapshot(show), sheet).edits).toEqual([{ songId: "s_glass", colId: col, value: "typed during the sync" }]);
  });
  it("writes every cell of a row it's adding, and every cell when nothing's been pushed", () => {
    const show = fresh();
    const col = editable(show);
    const g = showTab(show, {});
    const ci = g.colIds.indexOf(col);
    const keep = keptCells(g, "show", snapshot(show), snapshot(show), new Set(g.rowIds.filter((r) => r !== "s_glass")));
    expect(keep(g.rowIds.indexOf("s_glass"), ci)).toBe(false);
    expect(keep(g.rowIds.indexOf("s_lights"), ci)).toBe(true);
    expect(keep(g.rowIds.indexOf("s_lights"), g.colIds.indexOf("name"))).toBe(false);
    expect(keptCells(g, "show", snapshot(show), {}, new Set(g.rowIds))(g.rowIds.indexOf("s_lights"), ci)).toBe(false);
    expect(contentRequests(g, 1, () => false).filter((r) => "updateCells" in r)).toHaveLength(2); // header and data, as before
  });
});

describe("SHOW DECK", () => {
  it("makes valid, unique object ids and keeps existing slides on a redraw", () => {
    const show = fresh();
    const reqs = deckRequests(show, 1, {}, { p: ["p_el"] }, "01 JAN 2027") as Record<string, { objectId?: string }>[];
    const ids = reqs.flatMap((r) => Object.values(r).map((b) => (b as { objectId?: string }).objectId).filter(Boolean)) as string[];
    const created = reqs.filter((r) => r.createSlide || r.createShape || r.createImage).map((r) => (r.createSlide ?? r.createShape ?? r.createImage)!.objectId!);
    expect(new Set(created).size).toBe(created.length);
    for (const id of created) expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_\-:]{4,49}$/);
    expect(ids.length).toBeGreaterThan(created.length);
    expect(reqs).toContainEqual({ deleteObject: { objectId: "p" } });
    const existing = Object.fromEntries(reqs.filter((r) => r.createSlide).map((r) => [r.createSlide!.objectId!, ["old_1"]]));
    const again = deckRequests(show, 2, {}, existing, "01 JAN 2027") as Record<string, unknown>[];
    expect(again.some((r) => "createSlide" in r)).toBe(false);
    expect(again.filter((r) => "deleteObject" in r).length).toBe(Object.keys(existing).length);
  });

  it("draws only the swatches a song has, and any column can be switched on or off", () => {
    const show = fresh();
    const id = show.set_order[0];
    const song = show.songs[id];
    song.colours = [{ hex: "#FF0000", label: "Red" }, { hex: "#0000FF", label: "Blue" }];
    song.fields.colref = "Warm wash";
    const tick = show.columns.find((c) => c.type === "tick")!;
    song.statuses[tick.id] = true;
    const slide = () => {
      const reqs = deckRequests(show, 1, {}, {}, "01 JAN 2027") as Record<string, Record<string, unknown>>[];
      const mine = reqs.filter((r) => JSON.stringify(r).includes(`pm1_${id}_`));
      return { rects: mine.filter((r) => (r.createShape as { shapeType?: string })?.shapeType === "RECTANGLE").length,
        text: mine.map((r) => (r.insertText as { text?: string })?.text).filter(Boolean).join("|") };
    };
    expect(slide().rects).toBe(2);
    expect(slide().text).toContain("SONG COLOUR");
    expect(slide().text).toContain("Red");
    expect(slide().text).toContain("Warm wash");
    expect(slide().text).not.toContain(tick.label);
    for (const c of show.columns) {
      if (c.type === "tick") c.on_slide = true;
      if (c.id === "colour_2" || c.id === "colref") c.on_slide = false;
    }
    expect(slide().rects).toBe(1);
    expect(slide().text).not.toContain("Warm wash");
    expect(slide().text).toContain(`✓ ${tick.label}`);
  });
  it("draws a colour field as chips under its label, not as text", () => {
    const show = fresh();
    const id = show.set_order[0];
    const song = show.songs[id];
    song.colours = [];
    const laser = addCustomField(show, "Laser colour", "palette");
    song.swatches = { [laser]: [{ hex: "#00FF00", label: "Green" }, { hex: "#0000FF", label: "Blue" }] };
    const mine = (deckRequests(show, 1, {}, {}, "01 JAN 2027") as Record<string, Record<string, unknown>>[])
      .filter((r) => JSON.stringify(r).includes(`pm1_${id}_`));
    const fills = mine.map((r) => (r.updateShapeProperties as { shapeProperties?: { shapeBackgroundFill?: { solidFill?: { color?: { rgbColor?: unknown } } } } })
      ?.shapeProperties?.shapeBackgroundFill?.solidFill?.color?.rgbColor).filter(Boolean);
    const texts = mine.map((r) => (r.insertText as { text?: string })?.text).filter(Boolean);
    expect(fills).toHaveLength(2);
    expect(texts).toEqual(expect.arrayContaining(["LASER COLOUR", "Green", "Blue"]));
    expect(texts.join("|")).not.toContain("Green, Blue");
  });
  it("links each clip to where it plays, in the Sheet and on the slide", () => {
    const show = fresh();
    const id = show.set_order[0];
    show.records = [{ id: "r1", path: "/x/NYC T5.mov", name: "NYC T5.mov", label: "NYC T5", scope: "show", added_at: "" }];
    show.songs[id].clips = [
      { path: "media/clips/a.mp4", record_id: "r1", in: 0, out: 10, source: "auto_tc" },
      { path: "media/clips/b.mp4", record_id: "gone", in: 0, out: 10, source: "manual" },
    ];
    const urls = { "media/clips/a.mp4": "https://drive.google.com/file/d/A/view" };
    const g = showTab(show, {}, urls);
    const cell = g.dataRows[g.rowIds.indexOf(id)][g.colIds.indexOf("clip")];
    expect(cell.links).toEqual([{ text: "▶ NYC T5", url: urls["media/clips/a.mp4"] }, { text: "▶ b", url: undefined }]);
    const reqs = deckRequests(show, 1, {}, {}, "01 JAN 2027", urls) as Record<string, Record<string, unknown>>[];
    const linked = reqs.map((r) => (r.updateTextStyle as { style?: { link?: { url: string } } })?.style?.link?.url).filter(Boolean);
    expect(linked).toEqual([urls["media/clips/a.mp4"]]); // b isn't on Drive yet: no link
  });  it("puts each image column's image in the Sheet and stacks them on the slide", () => {
    const show = fresh();
    const id = show.set_order[0];
    const laser = imageColumnFor(show, "Lasers");
    show.songs[id].hero = "r.jpg";
    show.songs[id].images = { [laser]: "l.jpg" };
    const urls = { "r.jpg": "https://img/r", "l.jpg": "https://img/l" };
    const g = showTab(show, urls);
    const row = g.dataRows[g.rowIds.indexOf(id)];
    expect(row[g.colIds.indexOf(laser)].formula).toBe('=IMAGE("https://img/l")');
    const reqs = deckRequests(show, 1, urls, {}, "01 JAN 2027") as Record<string, Record<string, unknown>>[];
    const mine = reqs.filter((r) => JSON.stringify(r).includes(`pm1_${id}_`));
    const imgs = mine.map((r) => r.createImage as { url: string; elementProperties: { size: { height: { magnitude: number } } } }).filter(Boolean);
    expect(imgs.map((i) => i.url)).toEqual(["https://img/r", "https://img/l"]);
    expect(imgs[0].elementProperties.size.height.magnitude).toBeLessThan(180);
    expect(mine.map((r) => (r.insertText as { text?: string })?.text)).toContain("LASERS");
  });
});

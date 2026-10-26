import { beforeEach, describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import type { Show } from "../model/types";
import { backend } from "../backend";
import { useStore } from "../store";
import { isOutside, LINK, listPeople, share, shareLink, unshare } from "./sharing";

const inherited = [{ inherited: true }];
// The show's files on Drive: its folder, the Sheet, the deck, and the two media folders.
const PERMS: Record<string, object[]> = {
  FOLDER: [
    { id: "p-me", type: "user", role: "organizer", emailAddress: "me@pm.com", displayName: "Me", permissionDetails: inherited },
    { id: "p-team", type: "user", role: "writer", emailAddress: "team@pm.com", displayName: "Team", permissionDetails: inherited },
    { id: "p-collab", type: "user", role: "writer", emailAddress: "collab@pm.com", displayName: "Collab", permissionDetails: [{ inherited: false }] },
  ],
  SHEET: [
    { id: "s-team", type: "user", role: "writer", emailAddress: "team@pm.com", permissionDetails: inherited },
    { id: "s-ed", type: "user", role: "writer", emailAddress: "ed@other.com", displayName: "Ed", permissionDetails: [{ inherited: false }] },
  ],
  DECK: [{ id: "d-ed", type: "user", role: "commenter", emailAddress: "ed@other.com", permissionDetails: [{ inherited: false }] }],
  IMAGES: [{ id: "i-ed", type: "user", role: "reader", emailAddress: "ed@other.com", permissionDetails: [{ inherited: false }] }],
  CLIPS: [],
};

let calls: [string, string, unknown][] = [];

beforeEach(() => {
  calls = [];
  const show = structuredClone(sample) as Show;
  show.google = { folder_id: "FOLDER", spreadsheet_id: "SHEET", presentation_id: "DECK", media_folder_id: "IMAGES" };
  useStore.setState({ show, bundle: "/b/Show.showsheet", user: { name: "Me", email: "me@pm.com", picture: null } });
  backend.readJson = (async () => ({ folderId: "FOLDER", files: {}, folders: { "media/clips": "CLIPS" } })) as typeof backend.readJson;
  backend.googleApi = (async (method: string, url: string, body?: unknown) => {
    calls.push([method, url, body]);
    const file = url.match(/files\/([A-Z]+)\/permissions/)?.[1];
    return method === "GET" && file ? { permissions: PERMS[file] } : {};
  }) as typeof backend.googleApi;
});

describe("sharing a show", () => {
  it("lists who has what: app collaborators, Sheet people (with their media), and the shared drive's members", async () => {
    const people = await listPeople();
    const by = (email: string) => people.find((p) => p.email === email)!;
    expect(by("collab@pm.com")).toMatchObject({ access: "app", inherited: false, grants: [{ file: "FOLDER", permission: "p-collab" }] });
    expect(by("ed@other.com").access).toBe("edit");
    expect(by("ed@other.com").grants.map((g) => g.permission)).toEqual(["s-ed", "d-ed", "i-ed"]);
    expect(by("team@pm.com")).toMatchObject({ access: null, inherited: true, grants: [] });
    expect(by("me@pm.com").inherited).toBe(true);
  });
  it("shares the Sheet and deck with the media they show, emailing once", async () => {
    await share("new@other.com", "edit", true, "Hi");
    const posts = calls.filter(([m]) => m === "POST").map(([, url, body]) => [url.match(/files\/(\w+)/)![1], (body as { role: string }).role, url.includes("sendNotificationEmail=true")]);
    expect(posts).toEqual([["SHEET", "writer", true], ["DECK", "commenter", false], ["IMAGES", "reader", false], ["CLIPS", "reader", false]]);
    expect(calls.find(([m]) => m === "POST")![1]).toContain("emailMessage=Hi");
    expect(useStore.getState().show!.google!.app_editors ?? []).toEqual([]);
  });
  it("shares the whole show for the app, and opens the Sheet's lock to them; removing them takes it all back", async () => {
    await share("collab@pm.com", "app", false, "");
    expect(calls.filter(([m]) => m === "POST").map(([, url, body]) => [url.match(/files\/(\w+)/)![1], (body as { role: string }).role])).toEqual([["FOLDER", "writer"]]);
    expect(useStore.getState().show!.google!.app_editors).toEqual(["collab@pm.com"]);
    const collab = (await listPeople()).find((p) => p.email === "collab@pm.com")!;
    calls = [];
    await unshare(collab);
    expect(calls).toEqual([["DELETE", expect.stringContaining("files/FOLDER/permissions/p-collab"), undefined]]);
    expect(useStore.getState().show!.google!.app_editors).toEqual([]);
  });
  it("changing someone's access replaces what they had", async () => {
    const ed = (await listPeople()).find((p) => p.email === "ed@other.com")!;
    calls = [];
    await share(ed.email, "view", false, "", ed);
    expect(calls.filter(([m]) => m === "DELETE").map(([, url]) => url.match(/permissions\/([\w-]+)/)![1])).toEqual(["s-ed", "d-ed", "i-ed"]);
    expect(calls.filter(([m]) => m === "POST").map(([, , body]) => (body as { role: string }).role)).toEqual(["reader", "reader", "reader", "reader"]);
  });
  it("makes a link anyone can edit the Sheet with, without touching the show's folder or who uses it in the app", async () => {
    const url = await shareLink("edit");
    expect(url).toBe("https://docs.google.com/spreadsheets/d/SHEET/edit");
    const posts = calls.filter(([m]) => m === "POST").map(([, url, body]) => [url.match(/files\/(\w+)/)![1], body, url.includes("sendNotificationEmail=true")]);
    expect(posts).toEqual([
      ["SHEET", { type: "anyone", allowFileDiscovery: false, role: "writer" }, false],
      ["DECK", { type: "anyone", allowFileDiscovery: false, role: "commenter" }, false],
      ["IMAGES", { type: "anyone", allowFileDiscovery: false, role: "reader" }, false],
      ["CLIPS", { type: "anyone", allowFileDiscovery: false, role: "reader" }, false],
    ]);
    expect(useStore.getState().show!.google!.app_editors ?? []).toEqual([]);
    await expect(share(LINK, "app", false, "")).rejects.toThrow(/whole show/);
  });
  it("knows who's outside the organisation", () => {
    expect(isOutside("ed@other.com")).toBe(true);
    expect(isOutside("Team@PM.com")).toBe(false);
    useStore.setState({ user: { name: "Tom", email: "tom@googlemail.com", picture: null } });
    expect(isOutside("tom@gmail.com")).toBe(false); // the same account
  });
});

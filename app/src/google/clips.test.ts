import { beforeEach, describe, expect, it } from "vitest";
import sample from "../model/sample_show.json";
import type { Show } from "../model/types";
import { backend } from "../backend";
import { useStore } from "../store";
import { clashed, resolveClips } from "./sync";

// The show's media/clips folder on Drive, newest first (as asked for).
const ON_DRIVE = [
  { id: "A2", name: "a.mp4" },
  { id: "A1", name: "a.mp4" }, // an older upload with the same name
  { id: "B", name: "b.mp4" },
];

beforeEach(() => {
  const show = structuredClone(sample) as Show;
  const [first, second] = Object.keys(show.songs);
  for (const s of Object.values(show.songs)) s.clips = [];
  show.songs[first].clips = [{ path: "media/clips/a.mp4", record_id: "r1", in: 0, out: 10, source: "auto_tc" }];
  show.songs[second].clips = [
    { path: "media/clips/b.mp4", record_id: "r1", in: 10, out: 20, source: "auto_tc" },
    { path: "media/clips/c.mp4", record_id: "r1", in: 20, out: 30, source: "auto_tc" },
  ];
  // a.mp4 was stored with the id of the file it was copied from; d.mp4 is no song's any more.
  show.google = { clips: { "media/clips/a.mp4": "STALE", "media/clips/d.mp4": "D" } };
  useStore.setState({ show, bundle: "/b/Show.showsheet" });
  // The show's manifest on this Mac (src/drive/show.ts): where its clips folder is.
  backend.readJson = (async () => ({ folderId: "FOLDER", files: {}, folders: { "media/clips": "CLIPS" } })) as typeof backend.readJson;
  backend.googleApi = (async (_method: string, url: string) =>
    (url.includes(encodeURIComponent("'CLIPS' in parents")) ? { files: ON_DRIVE } : {})) as typeof backend.googleApi;
});

describe("finding clips on Drive", () => {
  it("takes each clip's id from the clips folder on Drive, not the copied file's", async () => {
    await resolveClips();
    expect(useStore.getState().show!.google!.clips).toEqual({ "media/clips/a.mp4": "A2", "media/clips/b.mp4": "B" });
  });
});

describe("clashed", () => {
  it("tells another Mac's push getting in the way from other errors", () => {
    expect(clashed(new Error("Google 400: Invalid requests[45].deleteConditionalFormatRule: No conditional format on sheet: 1003 at index: 1"))).toBe(true);
    expect(clashed(new Error("Google 400: Invalid requests[0].deleteObject: The object (pm158_cover_1) could not be found."))).toBe(true);
    expect(clashed(new Error("Google 400: Invalid requests[3].createSlide: The object ID (s_cover) should be unique among all pages and page elements."))).toBe(true);
    expect(clashed(new Error("Google 403: The caller does not have permission"))).toBe(false);
    expect(clashed(new Error("Google 404: Requested entity was not found."))).toBe(false);
  });
});

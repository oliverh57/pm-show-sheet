import { describe, expect, it } from "vitest";
import { backend } from "../backend";
import { formatTimeLeft, runBytes, trackUpload, useTransfers, watchDownloads, willUpload } from "./media";

describe("transfer progress", () => {
  it("counts files in, reports bytes, and clears once all are done (or failed)", async () => {
    willUpload(2);
    let report: (sent: number, size: number) => void = () => {};
    let finish: () => void = () => {};
    const first = trackUpload("clip.mov", (onProgress) => { report = onProgress; return new Promise<void>((r) => { finish = r; }); });
    report(4e6, 10e6);
    expect(useTransfers.getState().up).toMatchObject({ total: 2, done: 0, active: [{ name: "clip.mov", sent: 4e6, size: 10e6 }] });
    finish();
    await first;
    expect(useTransfers.getState().up).toMatchObject({ total: 2, done: 1, active: [] });
    await expect(trackUpload("still.jpg", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(useTransfers.getState().up).toMatchObject({ total: 0, done: 0, active: [] });
  });

  it("follows downloads from their start to their end", () => {
    let emit: Parameters<typeof backend.onDownloadProgress>[0] = () => {};
    backend.onDownloadProgress = (cb) => { emit = cb; return () => {}; };
    const stop = watchDownloads();
    emit({ id: "/cache/x/media/clips/a.mov", received: 0, total: 0, done: false });
    emit({ id: "/cache/x/media/renders/b.jpg", received: 0, total: 0, done: false });
    emit({ id: "/cache/x/media/clips/a.mov", received: 5e6, total: 20e6, done: false });
    expect(useTransfers.getState().down).toMatchObject({ total: 2, done: 0, active: [{ name: "a.mov", sent: 5e6, size: 20e6 }, { name: "b.jpg" }] });
    emit({ id: "/cache/x/media/renders/b.jpg", received: 0, total: 0, done: true });
    emit({ id: "/cache/x/media/renders/b.jpg", received: 0, total: 0, done: true }); // an end with no start counts nothing
    expect(useTransfers.getState().down).toMatchObject({ total: 2, done: 1 });
    emit({ id: "/cache/x/media/clips/a.mov", received: 0, total: 0, done: true });
    expect(useTransfers.getState().down).toEqual({ total: 0, done: 0, moved: 0, active: [] });
    stop();
  });

  it("works out the bytes left, with files of unknown size as the average", () => {
    const run = { total: 4, done: 1, moved: 100, active: [{ id: "a", name: "a", sent: 50, size: 300 }, { id: "b", name: "b", sent: 0, size: 0 }] };
    // a has 250 left; b and the one not started count the average of 300 and 100.
    expect(runBytes(run)).toEqual({ moved: 150, left: 250 + 2 * 200 });
    expect(runBytes({ total: 2, done: 0, moved: 0, active: [{ id: "a", name: "a", sent: 0, size: 0 }] }).left).toBeNull();
  });

  it("says the time left in rounded words", () => {
    expect(formatTimeLeft(4)).toBe("A few seconds left");
    expect(formatTimeLeft(23)).toBe("About 30 seconds left");
    expect(formatTimeLeft(55)).toBe("About 1 minute left");
    expect(formatTimeLeft(130)).toBe("About 2 minutes left");
    expect(formatTimeLeft(3900)).toBe("About 1 hour 5 min left");
  });
});

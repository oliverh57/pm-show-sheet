import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDrive } from "./fakeDrive";
import { holdLease, LEASE_MS, leaseIn, leaseValue, mayHold, releaseLease, THIS_MAC } from "./lease";

const NOW = 1_800_000_000_000;
const other = (until: number, writes = true) => ({ sync_lease: `${until}|othermac|${writes ? 1 : 0}|sam@x.com|Sam Jones` });

describe("the sync lease", () => {
  it("reads and writes who holds it", () => {
    expect(leaseIn({ sync_lease: leaseValue("me@x.com", "Me | Myself", true, NOW) }))
      .toEqual({ until: NOW + LEASE_MS, mac: THIS_MAC, writes: true, email: "me@x.com", name: "Me | Myself" });
    expect(leaseIn({ pmss: "1" })).toBeNull();
  });

  it("is taken when it's free, lapsed or this Mac's, or held by a Mac that can't write the Sheet", () => {
    expect(mayHold(null, true, NOW)).toBe(true);
    expect(mayHold(leaseIn(other(NOW - 1)), true, NOW)).toBe(true);
    expect(mayHold(leaseIn(other(NOW + 1000)), true, NOW)).toBe(false);
    expect(mayHold(leaseIn({ sync_lease: leaseValue("me@x.com", "Me", true, NOW - 1000) }), true, NOW)).toBe(true);
    expect(mayHold(leaseIn(other(NOW + 1000, false)), true, NOW)).toBe(true);
    expect(mayHold(leaseIn(other(NOW + 1000, false)), false, NOW)).toBe(false);
  });

  describe("on Drive", () => {
    let drive: FakeDrive;
    beforeEach(() => {
      vi.useFakeTimers();
      drive = new FakeDrive();
      drive.install();
    });
    afterEach(() => vi.useRealTimers());

    const settle = async <T,>(p: Promise<T>) => { await vi.advanceTimersByTimeAsync(5000); return p; };

    it("takes a free lease, renews it, and lets it go", async () => {
      const folder = drive.folder("TEST.showsheet");
      expect((await settle(holdLease(folder, "me@x.com", "Me", true)))?.mac).toBe(THIS_MAC);
      expect((await holdLease(folder, "me@x.com", "Me", true))?.mac).toBe(THIS_MAC); // a renewal doesn't wait
      await releaseLease(folder);
      expect(drive.files.get(folder)!.properties.sync_lease).toBeUndefined();
    });

    it("leaves another Mac's lease alone", async () => {
      const folder = drive.folder("TEST.showsheet", "root", other(Date.now() + LEASE_MS));
      expect((await holdLease(folder, "me@x.com", "Me", true))?.name).toBe("Sam Jones");
      await releaseLease(folder);
      expect(drive.files.get(folder)!.properties.sync_lease).toContain("othermac");
    });

    it("goes with whichever Mac's write stuck, when two take it at once", async () => {
      const folder = drive.folder("TEST.showsheet");
      const holding = holdLease(folder, "me@x.com", "Me", true);
      await vi.advanceTimersByTimeAsync(10);
      drive.files.get(folder)!.properties.sync_lease = other(Date.now() + LEASE_MS).sync_lease; // the other Mac's write lands after this one's
      expect((await settle(holding))?.name).toBe("Sam Jones");
    });
  });
});

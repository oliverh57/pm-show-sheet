import { describe, expect, it } from "vitest";
import { showsBlocked } from "./updates";

describe("showsBlocked", () => {
  it("keeps shows shut while a newer version is looked for, downloading or ready", () => {
    expect(showsBlocked({ status: "checking", version: null })).toMatch(/Checking/);
    expect(showsBlocked({ status: "downloading", version: "0.6.1" })).toMatch(/0\.6\.1 is downloading/);
    expect(showsBlocked({ status: "ready", version: "0.6.1" })).toMatch(/0\.6\.1 is ready/);
  });

  it("lets shows open when up to date, never checked (development) or the check failed (offline)", () => {
    for (const status of ["idle", "up-to-date", "error"] as const) expect(showsBlocked({ status, version: null })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { editedAgo, othersIn, presenceKey, presenceValue } from "./presence";

const NOW = 1_800_000_000_000;

describe("presence", () => {
  it("carries when someone last edited, and reads older apps' presence without it", () => {
    const props = {
      [presenceKey("sam@x.com")]: presenceValue("sam@x.com", "Sam Jones", NOW - 5 * 60_000, NOW),
      [presenceKey("ash@x.com")]: `${NOW}|ash@x.com|Ash`,
      [presenceKey("me@x.com")]: presenceValue("me@x.com", "Me", null, NOW),
    };
    expect(othersIn(props, "me@x.com", NOW)).toEqual([
      { at: NOW, email: "ash@x.com", name: "Ash" },
      { at: NOW, email: "sam@x.com", name: "Sam Jones", editedAt: NOW - 5 * 60_000 },
    ]);
    expect(Number(presenceValue("sam@x.com", "Sam", NOW - 1000, NOW).split("|")[0])).toBeCloseTo(NOW, -1); // as older apps read it
  });

  it("says how long ago", () => {
    expect(editedAgo(NOW - 20_000, NOW)).toBe("Edited just now");
    expect(editedAgo(NOW - 60_000, NOW)).toBe("Edited 1 min ago");
    expect(editedAgo(NOW - 50 * 60_000, NOW)).toBe("Edited 50 mins ago");
    expect(editedAgo(NOW - 75 * 60_000, NOW)).toBe("Edited an hour ago");
    expect(editedAgo(NOW - 3 * 3600_000, NOW)).toBe("Edited 3 hours ago");
  });
});

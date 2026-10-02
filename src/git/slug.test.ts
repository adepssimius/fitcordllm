import { describe, expect, it } from "vitest";
import { branchName, localDate, slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugify("Move Saturday's long run")).toBe("move-saturday-s-long-run");
  });

  it("drops emoji and punctuation without leaving stray dashes", () => {
    expect(slugify("🏃 what's on today?!")).toBe("what-s-on-today");
  });

  it("caps the length and does not end on a dash", () => {
    const s = slugify("can you reshape week fourteen so the back-to-back lands on the weekend");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(slugify("???")).toBe("");
  });
});

describe("localDate", () => {
  it("uses the configured zone, not UTC", () => {
    // 02:30 UTC on the 3rd is still the evening of the 2nd in New York.
    const at = new Date("2026-10-03T02:30:00Z");
    expect(localDate(at, "America/New_York")).toBe("2026-10-02");
    expect(localDate(at, "UTC")).toBe("2026-10-03");
  });
});

describe("branchName", () => {
  const at = new Date("2026-10-02T12:00:00Z");
  const base = { prefix: "fitcord", at, timeZone: "UTC" };

  it("is prefix/date-slug-id", () => {
    expect(branchName({ ...base, title: "Morning brief", sessionId: "3f9a1c2e-0000-4000-8000-000000000000" })).toBe(
      "fitcord/2026-10-02-morning-brief-3f9a1c",
    );
  });

  it("stays unique for two threads opened with the same words on the same day", () => {
    const a = branchName({ ...base, title: "brief", sessionId: "aaaaaaaa-0000-4000-8000-000000000000" });
    const b = branchName({ ...base, title: "brief", sessionId: "bbbbbbbb-0000-4000-8000-000000000000" });
    expect(a).not.toBe(b);
  });

  it("still produces a valid name from a title with nothing usable in it", () => {
    expect(branchName({ ...base, title: "?!", sessionId: "3f9a1c2e-0000-4000-8000-000000000000" })).toBe(
      "fitcord/2026-10-02-3f9a1c",
    );
  });
});

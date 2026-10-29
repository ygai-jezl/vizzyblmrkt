import { describe, expect, it } from "vitest";
import type { NoteUse } from "@/lib/types/brandNote";
import { noteRest, restDate, usesOf } from "./rest";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const use = (ref: string, days: number, written = true): NoteUse => ({ ref, title: `Article ${ref}`, at: daysAgo(days), written });

describe("whether a note rests", () => {
  it("is ready when no article has used it", () => {
    expect(noteRest({ usedBy: [] }, null, NOW)).toEqual({ written: 0, last: null, reason: null, until: null, by: null });
  });

  it("rests for the rest period after an article is written with it, and is ready again after", () => {
    const n = { usedBy: ["w/a"], uses: [use("w/a", 6)] };
    const r = noteRest(n, { restDays: 30 }, NOW);
    expect(r).toMatchObject({ written: 1, reason: "recent", by: { ref: "w/a" } });
    expect(r.until).toBe(new Date(Date.parse(daysAgo(6)) + 30 * 86_400_000).toISOString());
    expect(noteRest({ usedBy: ["w/a"], uses: [use("w/a", 30)] }, { restDays: 30 }, NOW).reason).toBeNull();
    expect(noteRest({ usedBy: ["w/a"], uses: [use("w/a", 29)] }, { restDays: 30 }, NOW).reason).toBe("recent");
  });

  it("never rests against the article that used it", () => {
    const n = { usedBy: ["w/a"], uses: [use("w/a", 1)] };
    expect(noteRest(n, null, NOW, "w/a")).toMatchObject({ written: 0, reason: null });
    expect(noteRest(n, null, NOW, "w/b").reason).toBe("recent");
  });

  it("is used up after enough articles, counting the undated ones from before dates were kept", () => {
    const n = { usedBy: ["w/a", "w/b", "w/c"], uses: [use("w/c", 90)] };
    expect(noteRest(n, { maxUses: 3 }, NOW)).toMatchObject({ written: 3, reason: "used_up", until: null, by: { ref: "w/c" } });
    expect(noteRest(n, { maxUses: 3 }, NOW, "w/a")).toMatchObject({ written: 2, reason: null });
    expect(noteRest(n, { maxUses: 4 }, NOW).reason).toBeNull();
    // An undated use counts toward the limit, never toward the rest period.
    expect(noteRest({ usedBy: ["w/a"] }, null, NOW).reason).toBeNull();
  });

  it("rests while another article's draft holds it, until the hold lapses", () => {
    const n = { usedBy: [], uses: [use("w/d", 3, false)] };
    expect(noteRest(n, null, NOW)).toMatchObject({ written: 0, reason: "held", by: { ref: "w/d", written: false } });
    expect(noteRest(n, null, NOW, "w/d").reason).toBeNull();
    expect(noteRest({ usedBy: [], uses: [use("w/d", 31, false)] }, null, NOW).reason).toBeNull();
  });

  it("with no rest period, only the limit holds a note back", () => {
    expect(noteRest({ usedBy: ["w/a"], uses: [use("w/a", 0), use("w/d", 0, false)] }, { restDays: 0 }, NOW).reason).toBeNull();
    expect(noteRest({ usedBy: ["w/a"], uses: [use("w/a", 0)] }, { restDays: 0, maxUses: 1 }, NOW).reason).toBe("used_up");
  });

  it("names the newest use, and reads one use per article from a messy list", () => {
    const n = { usedBy: ["w/a", "w/b"], uses: [use("w/a", 20), use("w/b", 5), use("w/a", 40)] };
    expect(usesOf(n).map((u) => u.ref)).toEqual(["w/a", "w/b"]);
    expect(noteRest(n, null, NOW)).toMatchObject({ written: 2, last: { ref: "w/b" }, reason: "recent" });
    expect(usesOf({ uses: undefined })).toEqual([]);
  });
});

describe("restDate", () => {
  it("is day and month, with the year only when it isn't the reference's, and empty for no date", () => {
    expect(restDate("2026-10-23T23:30:00.000Z", NOW.toISOString())).toBe("23 Oct");
    expect(restDate("2025-12-02T09:00:00.000Z", NOW.toISOString())).toBe("2 Dec 2025");
    expect(restDate("2026-10-23T09:00:00.000Z")).toBe("23 Oct 2026");
    expect(restDate(null)).toBe("");
  });
});

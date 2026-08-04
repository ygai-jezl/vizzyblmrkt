import { describe, it, expect } from "vitest";
import {
  xToCommon,
  linkedinToCommon,
  compositeEngagement,
  parseHashtags,
  computeMeasurement,
} from "./metrics";
import type { PostMetricSnapshot } from "@/lib/types/postPerformance";

describe("metric mappers", () => {
  it("maps X metrics: replies→comments, reposts+quotes→shares", () => {
    expect(xToCommon({ likes: 10, replies: 4, reposts: 3, quotes: 2, impressions: 1000 })).toEqual({
      impressions: 1000,
      likes: 10,
      comments: 4,
      shares: 5,
    });
  });
  it("maps LinkedIn metrics straight across", () => {
    expect(
      linkedinToCommon({
        impressions: 500,
        uniqueImpressions: 400,
        clicks: 20,
        likes: 8,
        comments: 3,
        shares: 1,
        engagement: 0.05,
      }),
    ).toMatchObject({ impressions: 500, uniqueImpressions: 400, clicks: 20, likes: 8, comments: 3, shares: 1 });
  });
});

describe("compositeEngagement", () => {
  it("weights comments/shares above likes and normalizes by impressions", () => {
    // actions = 1*10 + 3*2 + 4*1 + 1.5*0 = 20; ER = 20/1000 = 0.02
    const r = compositeEngagement({ impressions: 1000, likes: 10, comments: 2, shares: 1 });
    expect(r.actions).toBe(20);
    expect(r.ER).toBeCloseTo(0.02, 6);
    expect(r.composite).toBe(r.ER);
  });
  it("floors the impression denominator (a tiny-reach post can't post a huge rate)", () => {
    // impressions 3 → denominator floored at 50; actions = 1*5 = 5; ER = 5/50 = 0.1
    const r = compositeEngagement({ impressions: 3, likes: 5, comments: 0, shares: 0 });
    expect(r.ER).toBeCloseTo(0.1, 6);
  });
});

describe("parseHashtags", () => {
  it("extracts, lowercases, dedupes and caps at 10", () => {
    expect(parseHashtags("Loving #AI and #ai and #GrowthMarketing!")).toEqual(["ai", "growthmarketing"]);
    const many = Array.from({ length: 15 }, (_, i) => `#tag${i}`).join(" ");
    expect(parseHashtags(many).length).toBe(10);
  });
  it("handles empty / no-hashtag copy", () => {
    expect(parseHashtags("")).toEqual([]);
    expect(parseHashtags("no tags here")).toEqual([]);
  });
  it("caps each tag at 80 chars (must stay within the post_performance schema max)", () => {
    const long = "#" + "a".repeat(200);
    const [tag] = parseHashtags(long);
    expect(tag!.length).toBe(80);
  });
});

describe("computeMeasurement", () => {
  const snap = (ageHours: number, likes: number): PostMetricSnapshot => ({
    at: new Date(ageHours * 3_600_000).toISOString(),
    ageHours,
    source: "linkedin_org",
    raw: { impressions: 1000, likes, comments: 0, shares: 0 },
  });

  it("prefers the latest snapshot at/after +7d for the stable window", () => {
    const m = computeMeasurement([snap(48, 5), snap(168, 20), snap(192, 25)], "2020-01-01T00:00:00.000Z");
    expect(m).not.toBeNull();
    expect(m!.ageHoursAtMeasure).toBe(192);
    expect(m!.metrics.likes).toBe(25);
    // velocity from the first snapshot at/after +48h (the 48h one): ER = 5/1000
    expect(m!.velocity48h).toBeCloseTo(0.005, 6);
  });

  it("falls back to the latest available snapshot when none reach +7d", () => {
    const m = computeMeasurement([snap(48, 5), snap(72, 8)], "2020-01-01T00:00:00.000Z");
    expect(m!.ageHoursAtMeasure).toBe(72);
    expect(m!.metrics.likes).toBe(8);
  });

  it("returns null with no snapshots", () => {
    expect(computeMeasurement([], "2020-01-01T00:00:00.000Z")).toBeNull();
  });
});

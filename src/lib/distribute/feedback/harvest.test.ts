import { describe, it, expect, afterEach } from "vitest";
import { exemplarQualifies, highPerformerMinLikes, exemplarTags } from "./harvest";
import type { XPublicMetrics } from "@/lib/social/x/client";

const metrics = (likes: number): XPublicMetrics => ({
  likes,
  replies: 0,
  reposts: 0,
  quotes: 0,
  impressions: 0,
});

afterEach(() => {
  delete process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES;
});

describe("highPerformerMinLikes", () => {
  it("defaults to 25 and is env-overridable; ignores junk overrides", () => {
    expect(highPerformerMinLikes()).toBe(25);
    process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES = "100";
    expect(highPerformerMinLikes()).toBe(100);
    process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES = "-5";
    expect(highPerformerMinLikes()).toBe(25); // non-positive → default
    process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES = "abc";
    expect(highPerformerMinLikes()).toBe(25); // non-numeric → default
  });
});

describe("exemplarQualifies", () => {
  it("qualifies at >= the bar", () => {
    expect(exemplarQualifies(metrics(25))).toBe(true);
    expect(exemplarQualifies(metrics(24))).toBe(false);
    process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES = "10";
    expect(exemplarQualifies(metrics(10))).toBe(true);
  });
});

describe("exemplarTags", () => {
  it("bands length and includes channel + format", () => {
    expect(exemplarTags("short", "x")).toEqual(["ch:x", "len:short"]);
    expect(exemplarTags("a".repeat(500), "x", "x-thread")).toEqual(["ch:x", "len:medium", "fmt:x-thread"]);
    expect(exemplarTags("a".repeat(1000), "linkedin")).toEqual(["ch:linkedin", "len:long"]);
  });
});

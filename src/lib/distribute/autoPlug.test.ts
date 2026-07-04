import { describe, it, expect } from "vitest";
import { metricValue, thresholdCrossed } from "./autoPlug";
import type { XPublicMetrics } from "@/lib/social/x/client";
import type { AutoPlug } from "@/lib/types/scheduledPost";

const metrics: XPublicMetrics = { likes: 50, replies: 12, reposts: 7, quotes: 3, impressions: 9000 };
const rule = (over: Partial<AutoPlug>): AutoPlug => ({
  thresholdMetric: "likes",
  thresholdValue: 40,
  commentBody: "check this out",
  ...over,
});

describe("metricValue", () => {
  it("maps the auto-plug metric to the right public metric", () => {
    expect(metricValue(metrics, "likes")).toBe(50);
    expect(metricValue(metrics, "comments")).toBe(12); // comments → replies
    expect(metricValue(metrics, "reposts")).toBe(7);
  });
});

describe("thresholdCrossed", () => {
  it("crosses at >= the threshold", () => {
    expect(thresholdCrossed(metrics, rule({ thresholdMetric: "likes", thresholdValue: 50 }))).toBe(true); // 50>=50
    expect(thresholdCrossed(metrics, rule({ thresholdMetric: "likes", thresholdValue: 51 }))).toBe(false);
    expect(thresholdCrossed(metrics, rule({ thresholdMetric: "comments", thresholdValue: 10 }))).toBe(true);
    expect(thresholdCrossed(metrics, rule({ thresholdMetric: "reposts", thresholdValue: 8 }))).toBe(false);
  });
});

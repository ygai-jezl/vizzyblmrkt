import { afterEach, describe, expect, it, vi } from "vitest";
import { compositeEngagement, linkedinToCommon, xToCommon } from "./feedback/metrics";
import { backfillCandidates } from "./scheduler";
import type { ScheduledPost } from "@/lib/types/scheduledPost";

afterEach(() => vi.unstubAllEnvs());

const x = { likes: 10, replies: 2, reposts: 3, quotes: 1, impressions: 1000, bookmarks: 4 };
const li = { impressions: 500, uniqueImpressions: 400, clicks: 7, likes: 9, comments: 1, shares: 2, engagement: 0.038 };

describe("post numbers kept apart", () => {
  it("keeps reposts, quotes and bookmarks on X and LinkedIn's own rate only with the switch on", () => {
    expect(xToCommon(x)).toEqual({ impressions: 1000, likes: 10, comments: 2, shares: 4 });
    expect(linkedinToCommon(li)).not.toHaveProperty("engagement");
    vi.stubEnv("POST_METRICS_DETAIL_ENABLED", "true");
    expect(xToCommon(x)).toEqual({ impressions: 1000, likes: 10, comments: 2, shares: 4, reposts: 3, quotes: 1, bookmarks: 4 });
    expect(linkedinToCommon(li).engagement).toBe(0.038);
  });

  it("doesn't move the reward: shares are still reposts plus quotes", () => {
    const off = compositeEngagement(xToCommon(x));
    vi.stubEnv("POST_METRICS_DETAIL_ENABLED", "true");
    expect(compositeEngagement(xToCommon(x))).toEqual(off);
  });
});

describe("backfillCandidates", () => {
  const NOW = Date.parse("2026-11-18T00:00:00Z");
  const post = (over: Partial<ScheduledPost>): ScheduledPost =>
    ({
      id: over.dedupeKey ?? "p",
      dedupeKey: "p",
      jobKind: "publish",
      status: "done",
      channel: "x",
      body: "Spring is repotting season.",
      publishedRef: { platform: "x", remoteId: "123", publishedAt: "2026-06-01T00:00:00Z" },
      createdAt: "2026-06-01T00:00:00Z",
      ...over,
    }) as ScheduledPost;

  it("picks published X posts and recent company-page posts that have no stats job", () => {
    const picked = backfillCandidates(
      [
        post({ dedupeKey: "x_old" }),
        post({ dedupeKey: "x_has_job" }),
        post({ dedupeKey: "x_manual", publishedRef: { platform: "manual", remoteId: "1", publishedAt: "2026-06-01T00:00:00Z" } }),
        post({ dedupeKey: "x_pending", status: "pending" }),
        post({ dedupeKey: "li_org", channel: "linkedin", publishedRef: { platform: "linkedin", remoteId: "urn:li:share:1", publishedAt: "2026-10-01T00:00:00Z", authorUrn: "urn:li:organization:9" } }),
        post({ dedupeKey: "li_too_old", channel: "linkedin", publishedRef: { platform: "linkedin", remoteId: "urn:li:share:2", publishedAt: "2025-10-01T00:00:00Z", authorUrn: "urn:li:organization:9" } }),
        post({ dedupeKey: "li_person", channel: "linkedin", publishedRef: { platform: "linkedin", remoteId: "urn:li:share:3", publishedAt: "2026-10-01T00:00:00Z", authorUrn: "urn:li:person:7" } }),
      ],
      (id) => id === "perf:x_has_job",
      NOW,
    );
    expect(picked.map((p) => p.dedupeKey)).toEqual(["x_old", "li_org"]);
  });
});

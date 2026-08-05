import { describe, it, expect } from "vitest";
import { fetchLinkedInShareStatistics, sharesQueryParam } from "./stats";

const ORG = "urn:li:organization:2414183";

/** A fake fetch that captures the requested URL and returns a canned response. */
function fakeFetch(resp: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: async () => resp.body ?? null,
      text: async () => resp.text ?? JSON.stringify(resp.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const shareStats = (over: Record<string, number> = {}) => ({
  elements: [
    {
      totalShareStatistics: {
        impressionCount: 5287,
        uniqueImpressionsCount: 4001,
        clickCount: 78,
        likeCount: 14,
        commentCount: 24,
        shareCount: 5,
        engagement: 0.0228,
        ...over,
      },
    },
  ],
});

describe("sharesQueryParam", () => {
  it("uses shares=List(...) for a share URN, ugcPosts=List(...) for a ugcPost URN", () => {
    expect(sharesQueryParam("urn:li:share:123")).toBe("shares=List(urn%3Ali%3Ashare%3A123)");
    expect(sharesQueryParam("urn:li:ugcPost:9")).toBe("ugcPosts=List(urn%3Ali%3AugcPost%3A9)");
  });
  it("returns null for an unrecognized URN", () => {
    expect(sharesQueryParam("urn:li:person:1")).toBeNull();
    expect(sharesQueryParam("")).toBeNull();
  });
});

describe("fetchLinkedInShareStatistics", () => {
  it("rejects missing token / org / bad urn without calling out", async () => {
    expect(await fetchLinkedInShareStatistics("", { orgUrn: ORG, postUrn: "urn:li:share:1" })).toEqual({
      ok: false,
      reason: "not_connected",
    });
    expect(await fetchLinkedInShareStatistics("t", { orgUrn: "", postUrn: "urn:li:share:1" })).toEqual({
      ok: false,
      reason: "no_org",
    });
    expect(await fetchLinkedInShareStatistics("t", { orgUrn: ORG, postUrn: "urn:li:person:1" })).toEqual({
      ok: false,
      reason: "bad_post_urn",
    });
  });

  it("normalizes totalShareStatistics into the common metric shape", async () => {
    const { fn, calls } = fakeFetch({ ok: true, body: shareStats() });
    const res = await fetchLinkedInShareStatistics("tok", { orgUrn: ORG, postUrn: "urn:li:share:777" }, { fetch: fn });
    expect(res).toEqual({
      ok: true,
      metrics: {
        impressions: 5287,
        uniqueImpressions: 4001,
        clicks: 78,
        likes: 14,
        comments: 24,
        shares: 5,
        engagement: 0.0228,
      },
    });
    // Correct endpoint keying: org + the share List param, both URL-encoded.
    expect(calls[0]).toContain("q=organizationalEntity");
    expect(calls[0]).toContain(`organizationalEntity=${encodeURIComponent(ORG)}`);
    expect(calls[0]).toContain("shares=List(urn%3Ali%3Ashare%3A777)");
  });

  it("treats an absent element as an all-zero snapshot (no engagement yet), not an error", async () => {
    const { fn } = fakeFetch({ ok: true, body: { elements: [] } });
    const res = await fetchLinkedInShareStatistics("tok", { orgUrn: ORG, postUrn: "urn:li:ugcPost:1" }, { fetch: fn });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.metrics.impressions).toBe(0);
  });

  it("surfaces a bounded reason on an API error", async () => {
    const { fn } = fakeFetch({ ok: false, status: 403, text: JSON.stringify({ message: "Not enough permissions" }) });
    const res = await fetchLinkedInShareStatistics("tok", { orgUrn: ORG, postUrn: "urn:li:share:1" }, { fetch: fn });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("li_api_403:Not enough permissions");
  });

  it("reports network_error when fetch throws", async () => {
    const fn = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await fetchLinkedInShareStatistics("tok", { orgUrn: ORG, postUrn: "urn:li:share:1" }, { fetch: fn });
    expect(res).toEqual({ ok: false, reason: "network_error" });
  });

  it("defends against non-numeric fields (coerces to 0)", async () => {
    const { fn } = fakeFetch({
      ok: true,
      body: { elements: [{ totalShareStatistics: { impressionCount: "x", likeCount: null } }] },
    });
    const res = await fetchLinkedInShareStatistics("tok", { orgUrn: ORG, postUrn: "urn:li:share:1" }, { fetch: fn });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.metrics).toMatchObject({ impressions: 0, likes: 0 });
  });
});

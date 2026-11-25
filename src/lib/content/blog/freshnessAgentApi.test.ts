import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { FreshnessDueItem } from "@/lib/types/freshness";
import { agentArticlesDue, NOTE } from "./freshnessAgentApi";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1" } as TenantContext;

const item = (planId: string, state: FreshnessDueItem["state"]): FreshnessDueItem => ({
  planId,
  workspaceId: "ws1",
  title: `Article ${planId}`,
  url: `https://acme.example/blog/${planId}`,
  state,
  reasons: [{ kind: "age", detail: "21 days since its last update or check, on a 20-day clock", hard: true }],
  dueAt: "2026-11-01T00:00:00.000Z",
  clockDays: 20,
  subjectId: null,
});

function seed(db: FakeFirestore) {
  db.seed("freshness_watch", "fw_ten_A", {
    tenantId: "ten_A",
    nextAt: "2026-11-25T00:00:00.000Z",
    counts: { fresh: 4, soon: 1, due: 1 },
    byClock: { "20": 2, "30": 3, "45": 1 },
    pages: [],
    due: [item("p1", "due"), item("p2", "soon")],
    linksDay: "2026-11-24",
    linksToday: 0,
    updatedAt: "2026-11-24T06:00:00.000Z",
  });
  db.seed("freshness_watch", "fw_ten_B", { tenantId: "ten_B", counts: { fresh: 0, soon: 0, due: 9 }, byClock: {}, pages: [], due: [item("other", "due")], updatedAt: "" });
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's articles due a refresh", () => {
  it("lists the brand's own due and soon articles, with links, counts by clock and a meaning for every number", async () => {
    const db = new FakeFirestore();
    seed(db);
    const r = await agentArticlesDue(A, { db });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown> & { articles: Array<Record<string, unknown>>; meanings: Record<string, unknown> };
    expect(body).toMatchObject({ lookedAt: "2026-11-24T06:00:00.000Z", articlesDue: 1, articlesReviewSoon: 1, articlesFresh: 4, note: NOTE });
    expect(body.byClock).toEqual([
      { clockDays: 20, liveArticles: 2 },
      { clockDays: 30, liveArticles: 3 },
      { clockDays: 45, liveArticles: 1 },
    ]);
    expect(body.articles).toEqual([
      {
        title: "Article p1",
        liveAddress: "https://acme.example/blog/p1",
        state: "due a refresh",
        dueAt: "2026-11-01T00:00:00.000Z",
        clockDays: 20,
        reasons: ["21 days since its last update or check, on a 20-day clock"],
        link: "/admin/workspace/ws1/create/p1?freshness=1",
      },
      expect.objectContaining({ title: "Article p2", state: "review soon" }),
    ]);
    for (const key of numberKeys(body)) expect(MEANINGS, key).toHaveProperty(key);
    expect(Object.keys(body.meanings).sort()).toEqual(["articlesDue", "articlesFresh", "articlesReviewSoon", "clockDays", "liveArticles"]);
  });

  it("says when the watch hasn't looked yet, and reads nothing while freshness is off", async () => {
    const db = new FakeFirestore();
    const empty = (await agentArticlesDue(A, { db })).body as { lookedAt: null; articles: unknown[]; note: string };
    expect(empty).toMatchObject({ lookedAt: null, articles: [] });
    expect(empty.note).toContain("hasn't looked at this brand's live articles yet");
    seed(db);
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "false");
    expect(((await agentArticlesDue(A, { db })).body as { articles: unknown[] }).articles).toEqual([]);
  });
});

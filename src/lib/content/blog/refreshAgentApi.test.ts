import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { NO_USAGE } from "@/lib/agents/gemini";
import { BlogArticleMetaSchema, BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { agentReadReview, agentReviewArticle } from "./refreshAgentApi";
import type { ReviewDeps } from "./refreshReview";
import { sampleHub, samplePlan } from "./testing/samplePlan";

/** Vizzy's review_article: it starts and moves a review, says what it proposes, and never applies. */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1" };
const PLANS = "workspaces/ws1/content_plans";
const NOW = new Date("2026-11-25T10:00:00.000Z");
const BODY = "# Visibility\n\nSee [the guide](https://gone.example.com/guide).\n\n" + Array.from({ length: 200 }, (_, i) => `word${i % 9}`).join(" ") + ".";
const live = { url: "https://acme.example/blog/visibility", at: "2026-10-03T09:00:00.000Z", by: "check" as const, titleMatched: true };

function seed(db: FakeFirestore) {
  db.seed(PLANS, "plan_123", samplePlan({ id: "plan_123", blog: BlogBriefSchema.parse({ primaryQuestion: "Visibility?" }) }, sampleHub({ status: "approved", body: BODY, blog: { ...BlogArticleMetaSchema.parse({}), live, dates: { published: { at: "2026-10-03", source: "page" } } } })));
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Acme" });
  db.seed("freshness_watch", "fw_ten_A", { tenantId: "ten_A", pages: [{ key: "acme.example/blog/visibility", planId: "plan_123", workspaceId: "ws1" }], due: [{ planId: "plan_123", title: "Visibility" }] });
}

const deps = (db: FakeFirestore): ReviewDeps => ({
  db,
  now: () => NOW,
  usage: NO_USAGE,
  loadTenant: async () => null,
  brand: async () => ({ name: "Acme", sites: [] }),
  checkLink: async (url) => (url.includes("gone.example.com") ? "dead" : "ok"),
  fetchPage: async () => null,
  research: async (input) => ({ brief: BlogBriefSchema.parse({ ...input.plan.blog }), searched: true, found: { questions: 0, links: 0, facts: 0, sources: 0, verifiedSources: 0 } }) as never,
  openQuestions: async () => [],
  retrieve: async () => null,
  pageSearches: async () => ({ rows: [], note: null }),
  generate: async () => JSON.stringify({ changes: [] }),
});

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED", "BLOG_REFRESH_CHAT_ENABLED"]) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("review_article", () => {
  it("refuses a bad or unknown article", async () => {
    const db = new FakeFirestore();
    seed(db);
    expect(await agentReviewArticle(ctx, { articleId: "../x" }, deps(db))).toMatchObject({ status: 400 });
    expect(await agentReviewArticle(ctx, { articleId: "plan_999" }, deps(db))).toMatchObject({ status: 404 });
    expect(await agentReadReview(ctx, "plan_999", { db })).toMatchObject({ status: 404 });
  });

  it("starts a review and moves it a step each call, then says what it proposes, applying nothing", async () => {
    const db = new FakeFirestore();
    seed(db);
    const first = await agentReviewArticle(ctx, { articleId: "plan_123" }, deps(db));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ articleId: "plan_123", title: "Visibility", started: true, reviewsLeftThisMonth: 19, review: { state: "running", now: "opening its sources", startedBy: "vizzy", changesProposed: 0 } });
    expect(Object.keys((first.body as { meanings: object }).meanings).sort()).toEqual(["changesProposed", "reviewsLeftThisMonth"]);
    let last = first;
    for (let i = 0; i < 4; i++) last = await agentReviewArticle(ctx, { articleId: "plan_123" }, deps(db));
    const review = (last.body as { review: { state: string; changes: Array<{ kind: string; replaces: string; with: string; evidence: string[]; movesUpdated: boolean }> } }).review;
    expect(review.state).toBe("ready for a person to look at");
    expect(review.changes).toEqual([{ kind: "Dead link · keeps the date", replaces: "[the guide](https://gone.example.com/guide)", with: "the guide", why: "The page it links to is gone", evidence: ["gone.example.com no longer opens"], movesUpdated: false }]);
    expect((db.raw(PLANS, "plan_123") as ContentPlan).graph.nodes[0]!.body).toBe(BODY);
    expect((await agentReadReview(ctx, "plan_123", { db })).body).toMatchObject({ review: { changesProposed: 1 } });
  });

  it("says when the brand has no reviews left this month, or the feature isn't included", async () => {
    const db = new FakeFirestore();
    seed(db);
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_refresh=0");
    expect(await agentReviewArticle(ctx, { articleId: "plan_123" }, deps(db))).toEqual({ status: 429, body: { error: "monthly_limit" } });
  });
});

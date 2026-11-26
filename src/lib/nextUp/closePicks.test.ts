import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import type { AutopilotRun, CloseTo, NextUpPick } from "@/lib/types/autopilot";
import { BlogArticleMetaSchema, BlogBriefSchema } from "@/lib/types/contentPlan";
import { saveBrandMap } from "@/lib/brandMap/store";
import { ensureMoved } from "@/lib/brandMap/move";
import { listLearned } from "@/lib/autopilot/learned";
import { closePick } from "@/lib/autopilot/adminApi";
import { agentNextUp } from "@/lib/autopilot/agentApi";
import { pickStep } from "@/lib/autopilot/draftSteps";
import { startReview } from "@/lib/content/blog/refreshReview";
import { sampleHub, samplePlan } from "@/lib/content/blog/testing/samplePlan";
import type { Candidate } from "./candidates";
import { pickNextUp, type PickDeps } from "./pick";
import { NO_REPEATS } from "./repeats";

/** Close picks: carried by Next up, acted on from the card, taken by the autopilot, and read by a review. */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const SYSTEM: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-11-25T12:00:00.000Z");
const PLANS = "workspaces/ws1/content_plans";
const live = { url: "https://acme.example/blog/sov", at: "2026-10-19T09:00:00.000Z", by: "check" as const, titleMatched: true };
const closeTo: CloseTo = { planId: "plan_1", workspaceId: "ws1", title: "What is share of voice?", url: live.url, liveAt: live.at, sim: 0.9 };

const cand = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  questionId: `q_aaaaaaa${n}`,
  question: `Question ${n}?`,
  subjectId: "sub_aaaaaaaa",
  subjectName: "Share of voice",
  answered: 2,
  total: 7,
  lastArticleAt: null,
  focus: false,
  ...over,
});
const pick = (over: Partial<NextUpPick>): NextUpPick => ({ questionId: "q_aaaaaaa1", question: "Question 1?", subjectId: "sub_aaaaaaaa", subjectName: "Share of voice", because: "Why now.", chips: [], from: "gemini", ...over });

const SWITCHES = ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BRAND_MAP_SCALE_ENABLED", "BRAND_MAP_NEXT_UP_ENABLED", "NEXT_UP_REPEATS_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"];
beforeEach(() => {
  for (const s of SWITCHES) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

function seedArticle(db: FakeFirestore) {
  db.seed(PLANS, "plan_1", samplePlan({ id: "plan_1", blog: BlogBriefSchema.parse({ primaryQuestion: "What is share of voice?" }) }, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live } })));
}
async function seedNextUp(db: FakeFirestore, picks: NextUpPick[], extra: Record<string, unknown> = {}) {
  await forTenant(A, db).nextUp.create("nu_ten_A", { picks, notOnMap: [], missing: [], candidates: 5, at: NOW.toISOString(), by: "person", ...extra } as never);
}

describe("Next up with stop repeats", () => {
  async function setup(): Promise<PickDeps & { db: FakeFirestore }> {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" }, subjects: [] }) }, { db, nowMs: NOW.getTime() });
    await ensureMoved(A, { db, nowMs: NOW.getTime() });
    return {
      db,
      now: () => NOW,
      loadTenant: async () => ({ id: "ten_A" }) as never,
      candidates: async (_c, opts) => [cand(1), cand(2), cand(3), cand(4)].filter((c) => !opts?.exclude?.has(c.questionId)),
      search: async () => ({ ok: false, error: "unavailable" }) as never,
      flags: async () => null,
      notOnMap: async () => [],
      competitorNames: async () => [],
      searchPlanning: async () => null,
      refreshCandidates: async () => [],
      configured: () => true,
      reviewsOpen: async () => true,
    };
  }

  it("leaves out what is answered or being written, says when one is close, and keeps the counts", async () => {
    const d = await setup();
    const link = vi.fn(async () => 1);
    d.link = link;
    d.repeats = async () => ({
      ...NO_REPEATS,
      linked: [{ questionId: "q_aaaaaaa1", subjectId: "sub_aaaaaaaa", pageId: "p_plan_1", sim: 0.97 }],
      inProgress: ["q_aaaaaaa2"],
      close: new Map([["q_aaaaaaa3", closeTo]]),
      repeatsLive: [{ question: "What is share of voice?", pages: [{ title: "A", url: "https://acme.example/a", planId: "p1", workspaceId: "ws1" }, { title: "B", url: "https://acme.example/b", planId: "p2", workspaceId: "ws1" }], sim: 0.96 }],
      byMeaning: true,
    });
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('CLOSE to the brand\'s live article "What is share of voice?"');
      expect(prompt).toContain("better added to that article than written again");
      expect(prompt).not.toContain('"Question 1?"');
      expect(prompt).not.toContain('"Question 2?"');
      return JSON.stringify({ picks: [{ n: 1, because: "It adds to your live article on share of voice.", uses: ["1.1"] }] });
    }) as never;
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(r.ok).toBe(true);
    const doc = (r as { doc: { picks: NextUpPick[]; leftOut: number; linkedByMeaning: number; repeatsLive: unknown[]; reviewsOpen: boolean } }).doc;
    expect(link).toHaveBeenCalledWith(A, expect.arrayContaining([expect.objectContaining({ questionId: "q_aaaaaaa1" })]), expect.anything());
    expect(doc.picks[0]).toMatchObject({ questionId: "q_aaaaaaa3", closeTo: { planId: "plan_1" } });
    expect(doc.picks.map((p) => p.questionId)).not.toContain("q_aaaaaaa1");
    expect(doc).toMatchObject({ leftOut: 1, linkedByMeaning: 1, reviewsOpen: true });
    expect(doc.repeatsLive).toHaveLength(1);
  });

  it("is as before with the switch off", async () => {
    vi.stubEnv("NEXT_UP_REPEATS_ENABLED", "false");
    const d = await setup();
    const repeats = vi.fn(async () => NO_REPEATS);
    d.repeats = repeats;
    d.generate = vi.fn(async () => JSON.stringify({ picks: [] })) as never;
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(repeats).not.toHaveBeenCalled();
    expect((r as unknown as { doc: Record<string, unknown> }).doc).not.toHaveProperty("leftOut");
  });
});

describe("the card's Add to that article and Write it anyway", () => {
  const deps = (db: FakeFirestore, over: Record<string, unknown> = {}) => ({ db, canUse: async () => true, loadTenant: async () => null, ...over });

  it("Write it anyway keeps the pick without its close mark, and remembers it", async () => {
    const db = new FakeFirestore();
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", question: "Question 3?", closeTo })]);
    const r = await closePick(A, { questionId: "q_aaaaaaa3", action: "write_anyway" }, deps(db));
    expect(r.status).toBe(200);
    expect((r.body as { nextUp: { picks: NextUpPick[] } }).nextUp.picks[0]).not.toHaveProperty("closeTo");
    expect((await listLearned(A, { db })).map((e) => [e.kind, e.questionId])).toEqual([["wrote_anyway", "q_aaaaaaa3"]]);
  });

  it("Add to that article starts a review carrying the question, and sends the person to it", async () => {
    const db = new FakeFirestore();
    seedArticle(db);
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", question: "Question 3?", closeTo })]);
    const r = await closePick(A, { questionId: "q_aaaaaaa3", action: "add" }, deps(db));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ link: expect.stringContaining("plan_1"), started: true });
    expect(await forTenant(A, db).articleReviews.getById("ar_plan_1")).toMatchObject({ by: "person", why: { question: { id: "q_aaaaaaa3", text: "Question 3?" } } });
    expect((await forTenant(A, db).nextUp.getById("nu_ten_A"))?.picks).toEqual([]);
    expect((await listLearned(A, { db })).map((e) => e.kind)).toEqual(["added_to_article"]);
  });

  it("says why it can't, and refuses a pick that isn't close or bad input", async () => {
    const db = new FakeFirestore();
    seedArticle(db);
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", closeTo }), pick({ questionId: "q_aaaaaaa4" })]);
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_refresh=0");
    expect(await closePick(A, { questionId: "q_aaaaaaa3", action: "add" }, deps(db))).toMatchObject({ status: 429, body: { error: "monthly_limit" } });
    expect((await closePick(A, { questionId: "q_aaaaaaa4", action: "add" }, deps(db))).status).toBe(404);
    expect((await closePick(A, { questionId: "refresh:plan_1", action: "add" }, deps(db))).status).toBe(400);
    expect((await closePick(A, { questionId: "q_aaaaaaa3", action: "delete" }, deps(db))).status).toBe(400);
    vi.stubEnv("NEXT_UP_REPEATS_ENABLED", "false");
    expect((await closePick(A, { questionId: "q_aaaaaaa3", action: "add" }, deps(db))).status).toBe(503);
  });

  it("tells Vizzy which pick is close, with what the number means", async () => {
    const db = new FakeFirestore();
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", closeTo })], { leftOut: 2, linkedByMeaning: 1, repeatsLive: [] });
    const r = await agentNextUp(A, { db, canUse: async () => true });
    const body = r.body as { picks: Array<Record<string, unknown>>; questionsLeftOut: number; meanings: Record<string, unknown> };
    expect(body.picks[0]).toMatchObject({ closeTo: { title: "What is share of voice?", repeatSimilarity: 0.9, article: { planId: "plan_1" } } });
    expect(body.questionsLeftOut).toBe(2);
    expect(Object.keys(body.meanings)).toEqual(expect.arrayContaining(["repeatSimilarity", "questionsLeftOut", "questionsLinkedByMeaning"]));
  });
});

describe("the autopilot and a close pick", () => {
  const runOf = (mode: string) => ({ id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode, question: null }) as unknown as AutopilotRun;

  it("in Draft mode adds it to the live article as a review, never drafting it new", async () => {
    const db = new FakeFirestore();
    seedArticle(db);
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", question: "Question 3?", closeTo }), pick({ questionId: "q_aaaaaaa4", question: "Question 4?" })]);
    const r = await pickStep(SYSTEM, runOf("draft"), { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW, loadTenant: async () => null } as never);
    expect(r).toMatchObject({ step: "done", refreshOf: "plan_1", question: { questionId: "q_aaaaaaa3" } });
    expect(await forTenant(A, db).articleReviews.getById("ar_plan_1")).toMatchObject({ by: "autopilot", why: { question: { id: "q_aaaaaaa3" } } });
  });

  it("passes over it when it can't add it, and in Suggest mode, leaving it for a person", async () => {
    const db = new FakeFirestore();
    seedArticle(db);
    await seedNextUp(db, [pick({ questionId: "q_aaaaaaa3", closeTo }), pick({ questionId: "q_aaaaaaa4", question: "Question 4?" })]);
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_refresh=0");
    expect(await pickStep(SYSTEM, runOf("draft"), { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW, loadTenant: async () => null } as never)).toMatchObject({ step: "find", question: { questionId: "q_aaaaaaa4" } });
    expect((await forTenant(A, db).nextUp.getById("nu_ten_A"))?.picks.map((p) => p.questionId)).toEqual(["q_aaaaaaa3"]);
  });
});

describe("a review started for a question", () => {
  it("keeps the question as why it ran", async () => {
    const db = new FakeFirestore();
    seedArticle(db);
    const plan = (await import("@/lib/tenant/workspaceContent")).getContentPlan;
    const p = await plan(A, "ws1", "plan_1", db);
    const r = await startReview(A, { plan: p!, by: "person", question: { id: "q_aaaaaaa3", text: "Which tools track share of voice?" } }, { db, now: () => NOW });
    expect(r.ok && r.review.why.question).toEqual({ id: "q_aaaaaaa3", text: "Which tools track share of voice?" });
  });
});

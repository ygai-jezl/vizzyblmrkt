import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { AutopilotRun, NextUpPick } from "@/lib/types/autopilot";
import { pickStep } from "./draftSteps";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { sampleHub, samplePlan } from "@/lib/content/blog/testing/samplePlan";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-11-24T12:00:00.000Z");
const pick = (over: Partial<NextUpPick>): NextUpPick => ({
  questionId: "q_aaaaaaa1",
  question: "Question 1?",
  subjectId: "sub_aaaaaaaa",
  subjectName: "Share of voice",
  because: "Why now.",
  chips: [],
  from: "gemini",
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

async function seedPicks(db: FakeFirestore) {
  await forTenant(A, db).nextUp.create("nu_ten_A", {
    picks: [pick({ questionId: "refresh:plan_1", question: "Article 1", kind: "refresh", planId: "plan_1", workspaceId: "ws1" }), pick({})],
    notOnMap: [],
    missing: [],
    candidates: 5,
    at: NOW.toISOString(),
    by: "person",
  } as never);
}
const live = { url: "https://acme.example/blog/visibility", at: "2026-10-03T09:00:00.000Z", by: "check" as const, titleMatched: true };
const runOf = (mode: string) => ({ id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode, question: null }) as unknown as AutopilotRun;

describe("a run's pick", () => {
  it("in Draft mode, with reviews on, starts a review of the article due a refresh and is done", async () => {
    for (const k of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(k, "true");
    const db = new FakeFirestore();
    await seedPicks(db);
    db.seed("workspaces/ws1/content_plans", "plan_1", samplePlan({}, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live } })));
    const r = await pickStep(A, runOf("draft"), { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW, loadTenant: async () => null } as never);
    expect(r).toMatchObject({ step: "done", refreshOf: "plan_1", workspaceId: "ws1", question: { questionId: "refresh:plan_1" } });
    expect(r).not.toHaveProperty("planId");
    expect(await forTenant(A, db).articleReviews.getById("ar_plan_1")).toMatchObject({ by: "autopilot", state: "running" });
    // Suggest mode leaves it for a person, and so does a brand without the grant.
    const db2 = new FakeFirestore();
    await seedPicks(db2);
    db2.seed("workspaces/ws1/content_plans", "plan_1", samplePlan({}, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live } })));
    expect(await pickStep(A, runOf("suggest"), { deadlineMs: Date.now() + 60_000 }, { db: db2, now: () => NOW } as never)).toMatchObject({ question: { questionId: "q_aaaaaaa1" } });
    const db3 = new FakeFirestore();
    await seedPicks(db3);
    db3.seed("workspaces/ws1/content_plans", "plan_1", samplePlan({}, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live } })));
    vi.stubEnv("GRANTED_ONLY_FEATURES", "article_refresh");
    const ungranted = await pickStep(A, runOf("draft"), { deadlineMs: Date.now() + 60_000 }, { db: db3, now: () => NOW, loadTenant: async () => ({ id: "ten_A", grantedFeatures: [] }) } as never);
    expect(ungranted).toMatchObject({ step: "find", question: { questionId: "q_aaaaaaa1" } });
    // Passed over, not dropped: it waits in Next up for a person.
    expect((await forTenant(A, db3).nextUp.getById("nu_ten_A"))?.picks.map((p) => p.questionId)).toEqual(["refresh:plan_1"]);
  });

  it("passes over a refresh pick with reviews off and takes the first article to write", async () => {
    const db = new FakeFirestore();
    await forTenant(A, db).nextUp.create("nu_ten_A", {
      picks: [pick({ questionId: "refresh:plan_1", question: "Article 1", kind: "refresh", planId: "plan_1", workspaceId: "ws1" }), pick({})],
      notOnMap: [],
      missing: [],
      candidates: 5,
      at: NOW.toISOString(),
      by: "person",
    } as never);
    const run = { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", question: null } as unknown as AutopilotRun;
    const r = await pickStep(A, run, { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW } as never);
    expect(r).toMatchObject({ step: "find", question: { questionId: "q_aaaaaaa1" } });
    const left = await forTenant(A, db).nextUp.getById("nu_ten_A");
    expect(left?.picks.map((p) => p.questionId)).toEqual(["refresh:plan_1"]);
  });
});

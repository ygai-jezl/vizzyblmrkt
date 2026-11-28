import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { deleteContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { listVersions, readVersions, restoreVersion, saveVersion, VERSIONS_KEPT } from "./versions";
import { sampleHub, samplePlan } from "./testing/samplePlan";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { LoopStamp } from "@/lib/types/loopStamp";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const OTHER: TenantContext = { ...ctx, tenantId: "ten_B" };
const PLANS = "workspaces/ws1/content_plans";
let clock = Date.parse("2026-11-25T10:00:00.000Z");
const now = () => new Date((clock += 60_000));

const live = { url: "https://acme.example/blog/visibility", at: "2026-10-03T09:00:00.000Z", by: "check" as const, titleMatched: true, checkedAt: "2026-10-03T09:00:00.000Z" };
const dates = { published: { at: "2026-10-03", source: "page" as const }, updated: { at: "2026-11-01", source: "page" as const } };

function seed(db: FakeFirestore, body = "First copy.", over: Partial<ContentNode> = {}): ContentPlan {
  const plan = samplePlan({}, sampleHub({ status: "approved", body, blog: { ...BlogArticleMetaSchema.parse({ metaTitle: "First title", checkedAt: "2026-10-02T00:00:00.000Z" }), live, dates }, ...over }));
  db.seed(PLANS, plan.id, plan);
  return plan;
}
const stored = (db: FakeFirestore) => (db.raw(PLANS, "plan_1") as ContentPlan).graph.nodes[0]!;

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
  vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("an article's versions", () => {
  it("keeps nothing with the switch off, or for an article with no copy yet", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    vi.stubEnv("BLOG_REFRESH_ENABLED", "false");
    expect(await saveVersion(ctx, { plan, node: plan.graph.nodes[0], reason: "regenerate" }, { db, now })).toBeNull();
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    const empty = samplePlan({}, sampleHub({ body: "  " }));
    expect(await saveVersion(ctx, { plan: empty, node: empty.graph.nodes[0], reason: "regenerate" }, { db, now })).toBeNull();
    expect(await readVersions(ctx, "plan_1", { db })).toBeNull();
  });

  it("keeps the last ten, newest first, numbered for good, and not the same copy twice in a row", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    for (let i = 1; i <= 12; i++) {
      const node = sampleHub({ body: `Copy ${i}.`, blog: BlogArticleMetaSchema.parse({ metaTitle: `Title ${i}` }) });
      expect(await saveVersion(ctx, { plan, node, reason: "regenerate" }, { db, now })).toBe(i);
    }
    expect(await saveVersion(ctx, { plan, node: sampleHub({ body: "Copy 12.", blog: BlogArticleMetaSchema.parse({ metaTitle: "Title 12" }) }), reason: "apply" }, { db, now })).toBe(12);
    const list = await listVersions(ctx, "plan_1", { db });
    expect(list).toHaveLength(VERSIONS_KEPT);
    expect(list.map((v) => v.n)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(list[0]).toMatchObject({ reason: "regenerate", words: 2, metaTitle: "Title 12" });
    // The list never carries the copy itself.
    expect(list[0]).not.toHaveProperty("body");
  });

  it("puts a version back, keeps the copy it replaced, and sends the article back for approval", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await saveVersion(ctx, { plan, node: plan.graph.nodes[0], reason: "apply" }, { db, now });
    // The article changed since: new copy, and a real change moved Updated.
    const changed = seed(db, "Second copy.", { blog: { ...BlogArticleMetaSchema.parse({ metaTitle: "Second title" }), live, dates: { ...dates, updated: { at: "2026-11-25T10:00:00.000Z", source: "change" } } } });

    const r = await restoreVersion(ctx, { plan: changed, nodeId: "hub", n: 1 }, { db, now });
    expect(r.ok && r.kept).toBe(2);
    const node = stored(db);
    expect(node).toMatchObject({ body: "First copy.", status: "generated", blog: { metaTitle: "First title", checkedAt: "2026-10-02T00:00:00.000Z" } });
    // Its Updated comes back with it; the live mark and Published are the article's and stay.
    expect(node.blog?.dates).toEqual(dates);
    expect(node.blog?.live).toEqual(live);
    // Restore of the Restore brings the second copy back.
    const again = await restoreVersion(ctx, { plan: (db.raw(PLANS, "plan_1") as ContentPlan), nodeId: "hub", n: 2 }, { db, now });
    expect(again.ok).toBe(true);
    expect(stored(db)).toMatchObject({ body: "Second copy.", blog: { metaTitle: "Second title", dates: { updated: { source: "change" } } } });
  });

  it("counts the copy a person turned away from as undone when YouGrow made it (learning loops step 5)", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const plan = seed(db);
    await saveVersion(ctx, { plan, node: plan.graph.nodes[0], reason: "apply" }, { db, now });
    const made: LoopStamp = { made: "m1.blog_refresh.0.n", kind: "blog_refresh", scope: "blog_refresh", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: "2026-11-25T09:00:00.000Z" };
    const changed = seed(db, "Second copy.", { made });
    await restoreVersion(ctx, { plan: changed, nodeId: "hub", n: 1 }, { db, now });
    // The restored copy is the person's: restoring away from it counts nothing.
    await restoreVersion(ctx, { plan: db.raw(PLANS, "plan_1") as ContentPlan, nodeId: "hub", n: 2 }, { db, now });
    const week = sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c: Record<string, unknown> };
    expect(week.c).toEqual({ blog_refresh: { blog_refresh: { v0: { none: { undone: 1 } } } } });
  });

  it("refuses a version that isn't there, scheduled copy, and another brand's article", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await saveVersion(ctx, { plan, node: plan.graph.nodes[0], reason: "apply" }, { db, now });
    expect(await restoreVersion(ctx, { plan, nodeId: "hub", n: 9 }, { db, now })).toEqual({ ok: false, error: "no_version" });
    expect(await restoreVersion(ctx, { plan, nodeId: "nope", n: 1 }, { db, now })).toEqual({ ok: false, error: "not_found" });
    const scheduled = samplePlan({}, sampleHub({ scheduledAt: "2026-12-01T09:00:00.000Z" }));
    expect(await restoreVersion(ctx, { plan: scheduled, nodeId: "hub", n: 1 }, { db, now })).toEqual({ ok: false, error: "locked" });
    // Another brand reads nothing and restores nothing.
    expect(await listVersions(OTHER, "plan_1", { db })).toEqual([]);
    expect(await restoreVersion(OTHER, { plan, nodeId: "hub", n: 1 }, { db, now })).toEqual({ ok: false, error: "no_version" });
    expect(stored(db).body).toBe("First copy.");
  });

  it("go with the article when it is deleted", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await saveVersion(ctx, { plan, node: plan.graph.nodes[0], reason: "apply" }, { db, now });
    await deleteContentPlan(ctx, "ws1", "plan_1", db);
    expect(db.raw("article_versions", "av_plan_1")).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { freshnessWatchId, sweepBrand } from "./freshnessWatch";
import { markChecked, readRefresh, saveRefresh } from "./refreshAdmin";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const ADMIN: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", role: "admin" };
const MEMBER: TenantContext = { ...ADMIN, role: "member" };
const PLANS = "workspaces/ws1/content_plans";
const NOW = new Date("2026-11-24T12:00:00.000Z");

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  const hub = sampleHub({
    status: "approved",
    blog: {
      ...BlogArticleMetaSchema.parse({}),
      live: { url: "https://acme.example/blog/visibility", at: "2026-10-01T08:00:00.000Z", by: "check", titleMatched: true },
      dates: { published: { at: "2026-10-01", source: "page" } },
    },
  });
  db.seed(PLANS, "plan_1", samplePlan({}, hub));
  return db;
}
const none = { losingPages: async () => new Map(), reachPages: async () => new Map(), openQuestions: async () => new Map(), checkLink: async () => "ok" as const };

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED"]) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the refresh settings", () => {
  it("read the test and one refresh pick until set, and let only admins set them to allowed values", async () => {
    const db = world();
    expect(await readRefresh(MEMBER, { db, loadTenant: async () => ({ id: "ten_A" }) as unknown as Tenant })).toMatchObject({ status: 200, body: { clock: "test", share: 1, counts: null } });
    const save = vi.fn(async () => true);
    expect(await saveRefresh(MEMBER, { clock: 30, share: 1 }, { save })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await saveRefresh(ADMIN, { clock: 25, share: 1 }, { save })).toEqual({ status: 400, body: { error: "invalid_clock" } });
    expect(await saveRefresh(ADMIN, { clock: "test", share: 4 }, { save })).toEqual({ status: 400, body: { error: "invalid_share" } });
    expect(save).not.toHaveBeenCalled();
    expect(await saveRefresh(ADMIN, { clock: 45, share: 0 }, { save })).toEqual({ status: 200, body: { clock: 45, share: 0 } });
    expect(save).toHaveBeenCalledWith("ten_A", { refreshClock: 45, refreshShare: 0 });
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "");
    expect(await readRefresh(MEMBER, { db })).toEqual({ status: 503, body: { error: "unavailable" } });
  });
});

describe("Checked, nothing to change", () => {
  it("starts the clock again, keeps Updated as it is, records the check and takes it off the due list", async () => {
    const db = world();
    await sweepBrand(ADMIN, {}, { db, now: () => NOW, rand: () => 0, ...none });
    expect((await forTenant(ADMIN, db).freshnessWatch.getById(freshnessWatchId("ten_A")))?.counts).toEqual({ fresh: 0, soon: 0, due: 1 });
    const r = await markChecked(ADMIN, { workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }, { db, now: () => NOW });
    expect(r.ok).toBe(true);
    const blog = (await getContentPlan(ADMIN, "ws1", "plan_1", db))!.graph.nodes[0]!.blog!;
    expect(blog.freshness).toMatchObject({ checkedAt: NOW.toISOString(), state: "fresh", reasons: [], dueAt: "2026-12-14T12:00:00.000Z" });
    expect(blog.freshness!.events.map((e) => e.kind)).toEqual(["due", "checked"]);
    expect(blog.dates).toEqual({ published: { at: "2026-10-01", source: "page" } });
    const watch = await forTenant(ADMIN, db).freshnessWatch.getById(freshnessWatchId("ten_A"));
    expect(watch).toMatchObject({ due: [], counts: { fresh: 1, soon: 0, due: 0 } });
  });

  it("needs a live article with a clock, and is off with its switch off", async () => {
    const db = world();
    expect(await markChecked(ADMIN, { workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }, { db, now: () => NOW })).toEqual({ ok: false, status: 409, error: "no_clock" });
    expect(await markChecked(ADMIN, { workspaceId: "ws1", planId: "nope", nodeId: "hub" }, { db })).toEqual({ ok: false, status: 404, error: "node_not_found" });
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "");
    expect(await markChecked(ADMIN, { workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }, { db })).toEqual({ ok: false, status: 503, error: "unavailable" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { removePlanPage, removeWorkspacePages, syncPlanPage, syncPlanPageSoftly } from "./pageActions";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const PAGES = "brand_map_pages";
const now = () => new Date("2026-10-15T10:00:00.000Z");

function seed(db: FakeFirestore, plan: ContentPlan = samplePlan()): ContentPlan {
  db.seed(PLANS, plan.id, plan);
  return plan;
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("keeping the brand map's pages in step", () => {
  it("writes an article's row when its facts change, and only then", async () => {
    const db = new FakeFirestore();
    seed(db);
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now })).toBe("written");
    expect(db.raw(PAGES, "p_plan_1")).toMatchObject({ tenantId: "ten_A", kind: "article", planId: "plan_1", state: "draft", updatedAt: "2026-10-15T10:00:00.000Z" });
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now })).toBe("unchanged");
    expect(db.writeCountFor(PAGES, "p_plan_1")).toBe(1);

    seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now })).toBe("written");
    expect(db.raw(PAGES, "p_plan_1")).toMatchObject({ state: "approved" });
  });

  it("removes the row when the plan is gone or no longer a blog article", async () => {
    const db = new FakeFirestore();
    seed(db);
    await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now });
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1", plan: samplePlan({ topology: { hubChannel: "newsletter", spokeChannels: [] } }) }, { db })).toBe("removed");
    expect(db.raw(PAGES, "p_plan_1")).toBeUndefined();
    expect(await removePlanPage(ctx, "plan_1", { db })).toBe(false);
    await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now });
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1", plan: null }, { db })).toBe("removed");
  });

  it("removes every article row of a deleted programme, and only that programme's", async () => {
    const db = new FakeFirestore();
    for (const [id, ws] of [["plan_1", "ws1"], ["plan_2", "ws1"], ["plan_3", "ws2"]] as const) {
      await syncPlanPage(ctx, { workspaceId: ws, planId: id, plan: samplePlan({ id, workspaceId: ws }) }, { db, now });
    }
    expect(await removeWorkspacePages(ctx, "ws1", { db })).toBe(2);
    expect(db.dump(PAGES).map((d) => d.planId)).toEqual(["plan_3"]);
  });

  it("never touches another brand's row, and never fails the caller", async () => {
    const db = new FakeFirestore();
    db.seed(PAGES, "p_plan_1", { tenantId: "ten_B", kind: "article", title: "Theirs", fingerprint: "x" });
    seed(db);
    expect(await syncPlanPageSoftly(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now })).toBeNull();
    expect(db.raw(PAGES, "p_plan_1")).toMatchObject({ tenantId: "ten_B", title: "Theirs" });
  });

  it("reads and writes nothing while the pages switch is off", async () => {
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "false");
    const db = new FakeFirestore();
    seed(db);
    expect(await syncPlanPage(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db })).toBe("off");
    expect(await syncPlanPageSoftly(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db })).toBeNull();
    expect(await removeWorkspacePages(ctx, "ws1", { db })).toBe(0);
    expect(db.dump(PAGES)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: vi.fn(async () => undefined) }));
vi.mock("@/lib/content/blog/liveWatchWake", () => ({ wakeLiveWatch: vi.fn(async () => undefined) }));

import { fillPlanNode } from "./fillPlan";
import type { generateNode } from "./generateNode";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { listVersions } from "@/lib/content/blog/versions";
import { sampleHub, samplePlan } from "@/lib/content/blog/testing/samplePlan";

/** Regenerate keeps the copy it replaces as a version (BLOG_REFRESH_ENABLED); a first draft keeps none. */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const PATH = "workspaces/ws1/content_plans";

const generate = vi.fn(async () => ({ body: "The new copy.", placeholderValues: {}, status: "generated" as const, warnings: [] })) as unknown as typeof generateNode;

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(s, "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Regenerate and versions", () => {
  it("keeps the copy a rewrite replaces, and nothing for a first draft or with the switch off", async () => {
    const db = new FakeFirestore();
    const plan = samplePlan({}, sampleHub({ body: "The old copy." }));
    db.seed(PATH, plan.id, plan);
    const loadMap = async () => null;

    await fillPlanNode(ctx, { workspace: { id: "ws1" }, plan, nodeId: "hub" }, { db, generate, loadMap });
    expect((await listVersions(ctx, plan.id, { db })).map((v) => [v.n, v.reason, v.words])).toEqual([[1, "regenerate", 3]]);

    vi.stubEnv("BLOG_REFRESH_ENABLED", "false");
    await fillPlanNode(ctx, { workspace: { id: "ws1" }, plan: samplePlan({}, sampleHub({ body: "Other copy." })), nodeId: "hub" }, { db, generate, loadMap });
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    const first = samplePlan({ id: "plan_2" }, sampleHub({ body: "" }));
    db.seed(PATH, first.id, first);
    await fillPlanNode(ctx, { workspace: { id: "ws1" }, plan: first, nodeId: "hub" }, { db, generate, loadMap });
    expect(await listVersions(ctx, "plan_2", { db })).toEqual([]);
    expect(await listVersions(ctx, plan.id, { db })).toHaveLength(1);
  });
});

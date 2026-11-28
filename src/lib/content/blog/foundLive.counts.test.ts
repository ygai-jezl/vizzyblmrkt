import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { ContentPlanSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { pinOriginal, recordApprovals } from "@/lib/content/create/aiOriginals";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { countMade, loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { unusedForWeek } from "@/lib/loops/tally";
import { writeLiveMark } from "./foundLive";

/**
 * An article approved by its live mark counts its answer as a canvas Approve does (learning loops
 * step 5): the first approval of its AI original counts kept or edited, whichever comes first, the
 * live mark or the canvas Approve, and the other counts nothing more. Made up brand.
 */

const TENANT = "ten_hearth";
const WS = "ws_1";
const PLAN = "plan_1";
const T = new Date().toISOString();
const person: TenantContext = { tenantId: TENANT, region: "us", source: "idtoken", userId: "uid_1" };
const ARTICLE = "# Keeping sourdough\n\nIntro.\n\n## Why\n\nA loaf dries out.\n\n## How\n\nWrap it in linen.";
const URL = "https://hearth.example.com/blog/keeping-sourdough";
const blogStamp: LoopStamp = { made: "m1.blog_write.0.n", kind: "blog_write", scope: "blog_write", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: T };
const madeBy = { purpose: "blog_write" as const, promptId: "content.blog_draft", sources: [] };

async function seedArticle(db: FakeFirestore): Promise<ContentPlan> {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "Keeping sourdough",
    strategy: { objective: "product_launch", hubUrl: URL },
    scope: {},
    knowledge: {},
    topology: {},
    graph: { nodes: [{ id: "hub", type: "hub", channel: "blog", role: "Piece", position: { x: 0, y: 0 }, body: ARTICLE, status: "generated", made: blogStamp }], edges: [] },
    createdAt: T,
    updatedAt: T,
  });
  db.seed(`workspaces/${WS}/content_plans`, PLAN, plan);
  db.seed("workspaces", WS, { tenantId: TENANT, name: "Hearth Bakery" });
  // Written by the article writer: counted made once, with its AI original pinned.
  await countMade(person, "blog_write", blogStamp, { db });
  await pinOriginal(person, { plan, node: plan.graph.nodes[0]!, body: ARTICLE, madeBy }, { db });
  return plan;
}

const markLive = (db: FakeFirestore, plan: ContentPlan, approve: boolean) =>
  writeLiveMark(person, { workspaceId: WS, plan, nodeId: "hub", mark: () => ({ url: URL, at: T, by: "operator" }) as never, approve }, { db });
const approveOnCanvas = async (db: FakeFirestore) => {
  const before = (await getContentPlan(person, WS, PLAN, db))!;
  const after = { ...before, graph: { ...before.graph, nodes: [{ ...before.graph.nodes[0]!, status: "approved" as const }] } };
  return recordApprovals(person, { before, after }, { db });
};
const week = (db: FakeFirestore) => sumWeek(db, TENANT, loopWeekOf(new Date()));
const cell = (db: FakeFirestore) => (week(db) as { c?: Record<string, Record<string, unknown>> }).c?.blog_write?.blog_write;

beforeEach(() => {
  vi.stubEnv("LOOPS_ENABLED", "true");
  vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("an article approved by its live mark", () => {
  it("counts kept once when found live approves it, and a canvas Approve after counts nothing more", async () => {
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
    const db = new FakeFirestore();
    const plan = await seedArticle(db);
    expect((await markLive(db, plan, true))?.approved).toBe(true);
    expect(cell(db)).toEqual({ v0: { none: { made: 1, kept: 1 } } });
    expect(unusedForWeek([week(db), undefined, undefined]).get("blog_write")).toBe(0);
  });

  it("counts kept once when marked live first, then approved on the canvas with the same copy", async () => {
    const db = new FakeFirestore();
    const plan = await seedArticle(db);
    await markLive(db, plan, false);
    expect((await getContentPlan(person, WS, PLAN, db))!.graph.nodes[0]!.status).toBe("generated");
    expect(cell(db)).toEqual({ v0: { none: { made: 1, kept: 1 } } });
    await approveOnCanvas(db);
    expect(cell(db)).toEqual({ v0: { none: { made: 1, kept: 1 } } });
  });

  it("counts kept once when approved on the canvas first, then marked live", async () => {
    const db = new FakeFirestore();
    const plan = await seedArticle(db);
    expect(await approveOnCanvas(db)).toBe(1);
    await markLive(db, plan, false);
    expect(cell(db)).toEqual({ v0: { none: { made: 1, kept: 1 } } });
  });

  it("with LOOPS_ENABLED off counts nothing", async () => {
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
    const db = new FakeFirestore();
    const plan = await seedArticle(db);
    vi.stubEnv("LOOPS_ENABLED", "");
    expect((await markLive(db, plan, true))?.approved).toBe(true);
    expect(cell(db)).toEqual({ v0: { none: { made: 1 } } });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// Write it on one of Next up's picks (learning loops step 5): the article saved from the pick
// counts the pick kept against its stamp once, read from the brand's own stored Next up, whether
// or not STRATEGY_RESULTS_ENABLED is on. Made up brand and questions.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
vi.mock("@/lib/content/blog/mapActions", () => ({ reconcileWithSavedMap: async (_ctx: unknown, b: unknown) => b }));
vi.mock("@/lib/content/blog/liveWatchWake", () => ({ wakeLiveWatch: async () => undefined }));
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: async () => undefined }));

const { POST } = await import("./route");
const { forTenant } = await import("@/lib/tenant");
const { nextUpDocId } = await import("@/lib/types/autopilot");
const { countMade, loopWeekOf } = await import("@/lib/loops/count");
const { learnedFor } = await import("@/lib/loops/read");
const { sumWeek } = await import("@/lib/loops/testing/sumWeek");

const admin: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const QUESTION = "How long does sourdough keep?";
const intake = (questionId: string) => ({
  name: QUESTION,
  strategy: { objective: "brand_visibility", hubUrl: null },
  scope: { topics: [], spark: "" },
  knowledge: {},
  topology: { hubChannel: "blog", spokeChannels: [] },
  blog: { primaryQuestion: QUESTION, buyerQuestions: "", questionId },
});
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/admin/workspace/ws_blog/content-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ workspaceId: "ws_blog" }) });

let db: FakeFirestore;
const cell = () => (sumWeek(db, admin.tenantId, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>> }).c?.next_up?.next_up;

/** Hearth Bakery's stored pick with its next_up stamp, counted made once as pickNextUp does. */
async function storedPick() {
  const { stamp } = await learnedFor(admin, "next_up", { promptId: "next_up.pick" });
  const pick = { questionId: "q_sourdough1", question: QUESTION, subjectId: "sub_bread01", subjectName: "Bread", because: "Asked often.", chips: [], from: "gemini" as const, made: stamp };
  await forTenant(admin, db).nextUp.create(nextUpDocId(admin.tenantId), { picks: [pick], notOnMap: [], missing: [], candidates: 1, at: "2026-11-18T09:00:00.000Z", by: "schedule" } as never);
  await countMade(admin, "next_up", stamp, { type: "next_up", db });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of ["BRAND_MAP_ENABLED", "CREATE_BLOG_BRAND_MAP_ENABLED", "LOOPS_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  store.db = db;
  session.getAdminContext.mockResolvedValue(admin);
  await forTenant(admin, db).workspaces.create("ws_blog", { name: "Hearth Bakery blog", createdAt: "2026-11-01T00:00:00.000Z" } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST content-plans from a Next up pick, with the learning loops on", () => {
  it("counts the pick kept once, with STRATEGY_RESULTS_ENABLED off, however many articles are saved from it", async () => {
    await storedPick();
    expect((await post(intake("q_sourdough1"))).status).toBe(200);
    expect((await post(intake("q_sourdough1"))).status).toBe(200);
    expect(cell()).toEqual({ v0: { none: { made: 1, kept: 1 } } });
    // The pick stays on Next up, without its stamp.
    const picks = (await forTenant(admin, db).nextUp.getById(nextUpDocId(admin.tenantId)))!.picks;
    expect(picks.map((p) => p.questionId)).toEqual(["q_sourdough1"]);
    expect(picks[0]).not.toHaveProperty("made");
  });

  it("counts nothing for a question that isn't a pick", async () => {
    await storedPick();
    expect((await post(intake("q_ryebread01"))).status).toBe(200);
    expect(cell()).toEqual({ v0: { none: { made: 1 } } });
  });

  it("with LOOPS_ENABLED off counts nothing and leaves the pick as it was", async () => {
    await storedPick();
    const before = (await forTenant(admin, db).nextUp.getById(nextUpDocId(admin.tenantId)))!.picks;
    vi.stubEnv("LOOPS_ENABLED", "");
    expect((await post(intake("q_sourdough1"))).status).toBe(200);
    expect(cell()).toEqual({ v0: { none: { made: 1 } } });
    expect((await forTenant(admin, db).nextUp.getById(nextUpDocId(admin.tenantId)))!.picks).toEqual(before);
  });
});

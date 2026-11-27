import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Making an article from Next up's "Write it" (STRATEGY_RESULTS_ENABLED): the brief takes what the
// brand's own stored pick came from, never a basedOn the page sends. Made-up brand and question.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const BASED = { strategyAt: "2026-11-02T09:00:00.000Z", planAt: null, situationId: "sit_aaaaaa01", slotId: null };
const store = vi.hoisted(() => ({ picks: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  forTenant: () => ({
    workspaces: { getById: async () => ({ id: "ws1", tenantId: "ten_A", name: "Blog" }) },
    nextUp: { getById: async () => ({ picks: store.picks }) },
  }),
}));
const content = vi.hoisted(() => ({ createContentPlan: vi.fn(async (_ctx: unknown, _ws: string, fields: Record<string, unknown>) => ({ id: "plan_1", strategy: { hubUrl: null }, ...fields })), listContentPlans: vi.fn() }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
vi.mock("@/lib/content/blog/mapActions", () => ({ reconcileWithSavedMap: async (_ctx: unknown, b: unknown) => b }));
vi.mock("@/lib/content/blog/liveWatchWake", () => ({ wakeLiveWatch: async () => undefined }));
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: async () => undefined }));

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const intake = (blog: Record<string, unknown>) => ({
  name: "How do I stop back pain at my desk?",
  strategy: { objective: "brand_visibility", hubUrl: null },
  scope: { topics: [], spark: "" },
  knowledge: {},
  topology: { hubChannel: "blog", spokeChannels: [] },
  blog: { primaryQuestion: "How do I stop back pain at my desk?", buyerQuestions: "", ...blog },
});
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/admin/workspace/ws1/content-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ workspaceId: "ws1" }) });
const savedBrief = () => (content.createContentPlan.mock.calls.at(-1)![2] as { blog: Record<string, unknown> }).blog;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["BRAND_MAP_ENABLED", "CREATE_BLOG_BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "STRATEGY_RESULTS_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
  store.picks = [{ questionId: "q_aaaaaaa1", basedOn: BASED }];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST content-plans from a Next up pick", () => {
  it("stamps the brief with what the stored pick came from, ignoring a basedOn the page sends", async () => {
    expect((await post(intake({ questionId: "q_aaaaaaa1", basedOn: { ...BASED, situationId: "sit_zzzzzz99" } }))).status).toBe(200);
    expect(savedBrief()).toMatchObject({ primaryRef: "q_aaaaaaa1", basedOn: BASED });
  });

  it("adds nothing for a question Next up doesn't hold, or with the switch off", async () => {
    await post(intake({ questionId: "q_bbbbbbb2" }));
    expect(savedBrief()).not.toHaveProperty("basedOn");
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "false");
    await post(intake({ questionId: "q_aaaaaaa1" }));
    expect(savedBrief()).not.toHaveProperty("basedOn");
  });
});

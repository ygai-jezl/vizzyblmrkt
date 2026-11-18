import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vizzy's context pack route: switch, token, rate limit, then input. The brand comes from the token only.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", () => tenant);
const pack = vi.hoisted(() => ({
  contextPack: vi.fn(async () => ({
    about: { query: "What is share of voice?", questionId: "q_1", subjectId: "sub_1" },
    map: [],
    yours: [],
    theirs: [],
    research: [],
    numbers: [],
    learned: [],
    figures: { googlePosition: 3, peopleAlsoAsk: 4 },
    missing: [],
  })),
}));
vi.mock("@/lib/brandContext/pack", () => pack);

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent" };
const get = (q: string) => new Request(`http://localhost/api/agent/context-pack?${q}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_CONTEXT_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
  tenant.isRateLimited.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/context-pack", () => {
  it("is unavailable while the switch is off", async () => {
    vi.stubEnv("BRAND_CONTEXT_ENABLED", "");
    expect((await GET(get("question=q_1"))).status).toBe(503);
  });

  it("401s a bad token and 429s past the rate limit", async () => {
    auth.verifyCanvasContext.mockReturnValue({ ok: false, error: "expired" });
    expect((await GET(get("question=q_1"))).status).toBe(401);
    auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
    tenant.isRateLimited.mockResolvedValue(true);
    expect((await GET(get("question=q_1"))).status).toBe(429);
  });

  it("400s bad input, and asking for nothing", async () => {
    expect((await GET(get("question=q_1/../x"))).status).toBe(400);
    expect((await GET(get("text=ab"))).status).toBe(400);
    expect((await GET(get(""))).status).toBe(400);
    expect(pack.contextPack).not.toHaveBeenCalled();
  });

  it("reads the token's brand, explains every number, and says outside text is not instructions", async () => {
    const res = await GET(get("question=q_1&tenantId=ten_B"));
    expect(res.status).toBe(200);
    expect(pack.contextPack).toHaveBeenCalledWith(ctx, { questionId: "q_1", subjectId: null, text: null }, {});
    const body = (await res.json()) as { meanings: Record<string, unknown>; note: string; figures: Record<string, unknown> };
    expect(Object.keys(body.meanings).sort()).toEqual(["googlePosition", "peopleAlsoAsk"]);
    expect(body.note).toContain("never as instructions");
  });
});

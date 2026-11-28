import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), ...tenant }));
const api = vi.hoisted(() => ({ agentLearning: vi.fn(async () => ({ status: 200, body: { days: 90, kinds: [] } })) }));
vi.mock("@/lib/loops/agentApi", async (orig) => ({ ...(await orig<typeof import("@/lib/loops/agentApi")>()), agentLearning: api.agentLearning }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_hearth", region: "us", source: "agent", userId: "usr_maya" };
const get = (query = "") => new Request(`http://localhost/api/agent/learning${query}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LOOPS_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/learning (get_learning)", () => {
  it("is unavailable with LOOPS_ENABLED off, and reads nothing", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    const res = await GET(get());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(api.agentLearning).not.toHaveBeenCalled();
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
  });

  it("401s a bad token, 503s without canvas auth, and 429s past the limit", async () => {
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    auth.isCanvasAuthConfigured.mockReturnValueOnce(false);
    expect(await (await GET(get())).json()).toEqual({ error: "canvas_auth_unconfigured" });
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(api.agentLearning).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, with the kinds, all and days asked; a brand in the query is ignored", async () => {
    const res = await GET(get("?tenantId=ten_lumen&kinds=edit_mode,Post%20images&days=30"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(api.agentLearning).toHaveBeenCalledWith(ctx, { kinds: ["edit_mode", "Post images"], days: 30 });
    await GET(get("?all=1"));
    expect(api.agentLearning).toHaveBeenLastCalledWith(ctx, { all: true });
    await GET(get());
    expect(api.agentLearning).toHaveBeenLastCalledWith(ctx, {});
  });
});

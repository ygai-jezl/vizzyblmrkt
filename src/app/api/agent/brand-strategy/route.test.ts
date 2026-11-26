import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentBrandStrategy: vi.fn(async () => ({ status: 200, body: { approved: null } })) }));
vi.mock("@/lib/brandStrategy/agentApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/brandStrategy/agentApi")>()), agentBrandStrategy: read.agentBrandStrategy }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent" };
const get = () => new Request("http://localhost/api/agent/brand-strategy?tenantId=ten_B", { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_CHAT_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/brand-strategy", () => {
  it("is unavailable with its switch or the strategy off, 401s a bad token and 429s past the limit", async () => {
    vi.stubEnv("BRAND_STRATEGY_CHAT_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BRAND_STRATEGY_CHAT_ENABLED", "true");
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(read.agentBrandStrategy).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, never one the query names", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(read.agentBrandStrategy).toHaveBeenCalledWith(ctx);
  });
});

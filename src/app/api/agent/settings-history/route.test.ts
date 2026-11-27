import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentSettingsHistory: vi.fn(async () => ({ status: 200, body: { entries: [] } })) }));
vi.mock("@/lib/settings/agentApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings/agentApi")>()), agentSettingsHistory: read.agentSettingsHistory }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent" };
const get = (q = "") => new Request(`http://localhost/api/agent/settings-history?tenantId=ten_B${q}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SETTINGS_HISTORY_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/settings-history", () => {
  it("doesn't exist with its switch off, 401s a bad token and 429s past the limit", async () => {
    vi.stubEnv("SETTINGS_HISTORY_ENABLED", "");
    expect((await GET(get())).status).toBe(404);
    vi.stubEnv("SETTINGS_HISTORY_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(read.agentSettingsHistory).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, never one the query names, and passes the rest on", async () => {
    const res = await GET(get("&kind=journeys&subject=journey:lcj_1&rev=3&cursor=abc"));
    expect(res.status).toBe(200);
    expect(read.agentSettingsHistory).toHaveBeenCalledWith(ctx, { kind: "journeys", subject: "journey:lcj_1", rev: "3", cursor: "abc" });
  });
});

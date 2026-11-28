import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentRaiseDocs: vi.fn(async () => ({ status: 200, body: { docs: [] } })) }));
vi.mock("@/lib/raise/docs/agentApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/raise/docs/agentApi")>()), agentRaiseDocs: read.agentRaiseDocs }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_acme", region: "us", source: "agent", userId: "usr_member", role: "member" };
const get = (query = "") => new Request(`http://localhost/api/agent/raise/docs${query}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/raise/docs", () => {
  it("is unavailable with either switch off, 503s without the canvas key, 401s a bad token and 429s past the limit", async () => {
    vi.stubEnv("VIZZY_RAISE_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    auth.isCanvasAuthConfigured.mockReturnValueOnce(false);
    const unconfigured = await GET(get());
    expect([unconfigured.status, await unconfigured.json()]).toEqual([503, { error: "canvas_auth_unconfigured" }]);
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(read.agentRaiseDocs).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, with the deck the query names, and is never cached", async () => {
    const res = await GET(get("?docId=rd_abcdefghijkl&tenantId=ten_other"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(read.agentRaiseDocs).toHaveBeenCalledWith(ctx, "rd_abcdefghijkl");
    await GET(get("?docId="));
    expect(read.agentRaiseDocs).toHaveBeenLastCalledWith(ctx, null);
  });

  it("passes a not found straight through", async () => {
    read.agentRaiseDocs.mockResolvedValueOnce({ status: 404, body: { error: "doc_not_found" } } as never);
    const res = await GET(get("?docId=rd_zzzzzzzzzzzz"));
    expect([res.status, await res.json()]).toEqual([404, { error: "doc_not_found" }]);
  });
});

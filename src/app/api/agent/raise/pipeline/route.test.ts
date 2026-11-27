import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vizzy's get_raise_pipeline (RAISE_PIPELINE_ENABLED): the canvas token's brand only, counts only.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentRaisePipeline: vi.fn(async () => ({ status: 200, body: { status: "success", setUp: false } })) }));
vi.mock("@/lib/raise/pipeline/agentApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/raise/pipeline/agentApi")>()), agentRaisePipeline: read.agentRaisePipeline }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_a", region: "us", source: "agent", userId: "u_member", role: "member" };
const get = () => new Request("http://localhost/api/agent/raise/pipeline?tenantId=ten_b", { headers: { "x-canvas-context": "tok", "x-tenant-id": "ten_b" } });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED"]) vi.stubEnv(k, "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/raise/pipeline", () => {
  it("is unavailable with the board off or canvas auth unset, 401s a bad token and 429s past the brand's limit", async () => {
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "false");
    const off = await GET(get());
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "unavailable" });
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "true");
    auth.isCanvasAuthConfigured.mockReturnValueOnce(false);
    expect(await (await GET(get())).json()).toEqual({ error: "canvas_auth_unconfigured" });
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    const bad = await GET(get());
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "unauthorized", reason: "expired" });
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenLastCalledWith("tenant:ten_a", expect.objectContaining({ prefix: "raise_agent", burstLimit: 6, hourlyLimit: 60 }), expect.anything());
    expect(read.agentRaisePipeline).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, whatever the request names", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(read.agentRaisePipeline).toHaveBeenCalledWith(ctx);
  });
});

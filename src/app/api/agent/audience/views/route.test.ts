import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentViewCounts: vi.fn(async () => ({ status: 200, body: { views: [] } })) }));
vi.mock("@/lib/views/agentViews", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/views/agentViews")>()), agentViewCounts: read.agentViewCounts }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_member", role: "member" };
const get = (query = "") => new Request(`http://localhost/api/agent/audience/views?tenantId=ten_B${query}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "CRM_VIEWS_ENABLED"]) vi.stubEnv(k, "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/audience/views", () => {
  it("is unavailable with views off, 401s a bad token and 429s past the brand's limit", async () => {
    vi.stubEnv("CRM_VIEWS_ENABLED", "false");
    const off = await GET(get());
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "unavailable" });
    vi.stubEnv("CRM_VIEWS_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenLastCalledWith("tenant:ten_A", expect.objectContaining({ burstLimit: 6, hourlyLimit: 60 }), expect.anything());
    expect(read.agentViewCounts).not.toHaveBeenCalled();
  });

  it("reads the token's brand and member only, with the views named to count", async () => {
    const res = await GET(get("&count=Wholesale%2C%20ordered%20lately&count=viw_000000000002"));
    expect(res.status).toBe(200);
    expect(read.agentViewCounts).toHaveBeenCalledWith(ctx, ["Wholesale, ordered lately", "viw_000000000002"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const read = vi.hoisted(() => ({ agentDrafts: vi.fn(async () => ({ status: 200, body: { made: 0, kinds: [] } })) }));
vi.mock("@/lib/agentRecord/agentDrafts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agentRecord/agentDrafts")>()), agentDrafts: read.agentDrafts }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_sam", role: "admin" };
const get = (q = "") => new Request(`http://localhost/api/agent/drafts?tenantId=ten_B${q}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENT_RECORD_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/drafts", () => {
  it("answers 503 with the record off, 401s a bad token and 429s past 6 a minute and 60 an hour", async () => {
    vi.stubEnv("AGENT_RECORD_ENABLED", "");
    const off = await GET(get());
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "agent_record_disabled" });
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenLastCalledWith("tenant:ten_A", { prefix: "drafts_agent", burstLimit: 6, hourlyLimit: 60 });
    expect(read.agentDrafts).not.toHaveBeenCalled();
  });

  it("reads the token's brand only, never one the query names, and passes the kind and days on", async () => {
    const res = await GET(get("&kind=lifecycle_journey&days=14"));
    expect(res.status).toBe(200);
    expect(read.agentDrafts).toHaveBeenCalledWith(ctx, { kind: "lifecycle_journey", days: "14" });
  });
});

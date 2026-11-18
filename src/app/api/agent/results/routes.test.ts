import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vizzy's results routes: switch, token, rate limit, then input. The brand comes from the token only.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", () => tenant);
const results = vi.hoisted(() => ({ emailResults: vi.fn(async () => ({ status: 200, body: { ok: 1 } })), postResults: vi.fn(async () => ({ status: 200, body: { ok: 1 } })) }));
vi.mock("@/lib/metrics/results", () => results);

const email = await import("./email/route");
const posts = await import("./posts/route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent" };
const get = (path: string) => new Request(`http://localhost/api/agent/results/${path}`, { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESULTS_CHAT_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
  tenant.isRateLimited.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/results", () => {
  it("is unavailable while the switch is off", async () => {
    vi.stubEnv("RESULTS_CHAT_ENABLED", "");
    expect((await email.GET(get("email"))).status).toBe(503);
    expect((await posts.GET(get("posts"))).status).toBe(503);
  });

  it("401s a bad token and 429s past the rate limit", async () => {
    auth.verifyCanvasContext.mockReturnValue({ ok: false, error: "expired" });
    expect((await email.GET(get("email"))).status).toBe(401);
    auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
    tenant.isRateLimited.mockResolvedValue(true);
    expect((await posts.GET(get("posts"))).status).toBe(429);
  });

  it("400s bad input", async () => {
    expect((await email.GET(get("email?scope=people"))).status).toBe(400);
    expect((await email.GET(get("email?scope=journey&id=a/b"))).status).toBe(400);
    expect((await posts.GET(get("posts?days=0"))).status).toBe(400);
    expect((await posts.GET(get("posts?channel=instagram"))).status).toBe(400);
  });

  it("reads the token's brand with the asked scope, never a brand in the query", async () => {
    await email.GET(get("email?scope=journey&id=lcj_1&tenantId=ten_B"));
    expect(results.emailResults).toHaveBeenCalledWith(ctx, { scope: "journey", id: "lcj_1" });
    await posts.GET(get("posts?channel=linkedin&days=14"));
    expect(results.postResults).toHaveBeenCalledWith(ctx, { channel: "linkedin", days: 14 });
  });
});

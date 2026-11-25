import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), ...tenant }));
const api = vi.hoisted(() => ({
  agentReadReview: vi.fn(async () => ({ status: 200, body: { review: null } })),
  agentReviewArticle: vi.fn(async () => ({ status: 200, body: { review: { state: "running" } } })),
}));
vi.mock("@/lib/content/blog/refreshAgentApi", async (orig) => ({ ...(await orig<typeof import("@/lib/content/blog/refreshAgentApi")>()), ...api }));

const { GET, POST } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1" };
const URL = "http://localhost/api/agent/article-review";

beforeEach(() => {
  vi.clearAllMocks();
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED", "BLOG_REFRESH_CHAT_ENABLED"]) vi.stubEnv(s, "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/article-review", () => {
  it("is unavailable with its chat switch off, 401s a bad token, 429s past the limit", async () => {
    const get = () => new Request(`${URL}?articleId=plan_123`, { headers: { "x-canvas-context": "tok" } });
    vi.stubEnv("BLOG_REFRESH_CHAT_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BLOG_REFRESH_CHAT_ENABLED", "true");
    vi.stubEnv("BLOG_REFRESH_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
  });

  it("reads and moves the token's brand's review only", async () => {
    expect((await GET(new Request(`${URL}?articleId=plan_123&tenantId=ten_B`, { headers: { "x-canvas-context": "tok" } }))).status).toBe(200);
    expect(api.agentReadReview).toHaveBeenCalledWith(ctx, "plan_123");
    const res = await POST(new Request(URL, { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, body: JSON.stringify({ articleId: "plan_123" }) }));
    expect(res.status).toBe(200);
    expect(api.agentReviewArticle).toHaveBeenCalledWith(ctx, { articleId: "plan_123" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

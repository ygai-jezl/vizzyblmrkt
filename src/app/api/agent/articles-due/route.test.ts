import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), ...tenant }));
const pages = vi.hoisted(() => ({ readFreshnessWatch: vi.fn(async () => null) }));
vi.mock("@/lib/content/blog/freshnessPages", async (orig) => ({ ...(await orig<typeof import("@/lib/content/blog/freshnessPages")>()), ...pages }));

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1" };
const get = () => new Request("http://localhost/api/agent/articles-due?tenantId=ten_B", { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/articles-due", () => {
  it("is unavailable with freshness off, 401s a bad token, 429s past the limit", async () => {
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
    auth.isCanvasAuthConfigured.mockReturnValueOnce(false);
    expect((await GET(get())).status).toBe(503);
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
  });

  it("reads the token's brand only: a brand in the query is ignored", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(pages.readFreshnessWatch).toHaveBeenCalledWith(ctx, {});
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

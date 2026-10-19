import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenantMod = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws_1", brandVoice: null, audience: null })) } })),
  getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme" })),
  isRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/tenant", () => tenantMod);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(async () => ({ id: "p1" })) }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const hero = vi.hoisted(() => ({
  makeBlogHero: vi.fn(async (_i: Record<string, unknown>) => ({ ok: true, node: {}, hero: { status: "ready" } }) as unknown),
  setHeroAlt: vi.fn(async () => ({ blog: { hero: { alt: "A desk" } } }) as unknown),
}));
vi.mock("@/lib/content/blog/hero", () => hero);

const { POST, PATCH } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws_1", planId: "p1", nodeId: "hub" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/x", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
  vi.stubEnv("BLOG_HERO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST blog hero", () => {
  it("needs the switch", async () => {
    vi.stubEnv("BLOG_HERO_ENABLED", "false");
    expect((await POST(req("POST", {}), params)).status).toBe(503);
  });

  it("makes it with the article's pick kept, a new pick, or back to the brand's", async () => {
    await POST(req("POST", {}), params);
    expect(hero.makeBlogHero.mock.calls[0]![0]).not.toHaveProperty("styleOverride");
    expect(hero.makeBlogHero.mock.calls[0]![0]).toMatchObject({ nodeId: "hub", budgetMs: 140_000, retry: true });
    await POST(req("POST", { styleId: "soft_3d" }), params);
    expect(hero.makeBlogHero.mock.calls[1]![0]).toMatchObject({ styleOverride: "soft_3d" });
    await POST(req("POST", { styleId: "brand" }), params);
    expect(hero.makeBlogHero.mock.calls[2]![0]).toMatchObject({ styleOverride: null });
  });

  it("passes on a run in progress, and is rate limited", async () => {
    hero.makeBlogHero.mockResolvedValueOnce({ ok: false, status: 409, error: "hero_running" });
    const res = await POST(req("POST", {}), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "hero_running" });
    tenantMod.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req("POST", {}), params)).status).toBe(429);
  });

  it("saves a person's alt text", async () => {
    const res = await PATCH(req("PATCH", { alt: "A desk" }), params);
    expect(await res.json()).toEqual({ hero: { alt: "A desk" } });
    expect((await PATCH(req("PATCH", { alt: 3 }), params)).status).toBe(400);
  });
});

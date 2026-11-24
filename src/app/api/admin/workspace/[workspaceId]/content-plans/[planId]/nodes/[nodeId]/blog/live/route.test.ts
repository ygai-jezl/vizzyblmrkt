import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: origin check, switch, sign-in, input, then setArticleLive (tested in src/lib/content/blog).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1" })) } })),
  isRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(async () => ({ id: "plan_1" })) }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const live = vi.hoisted(() => ({ setArticleLive: vi.fn(async () => ({ ok: true, node: { id: "hub" }, check: null })) }));
vi.mock("@/lib/content/blog/live", () => live);

const { POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/plan_1/nodes/hub/blog/live", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", source: "idtoken", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the live route", () => {
  it("passes the day a person gives with It's live, and only an action and a day", async () => {
    expect((await POST(req({ action: "mark", day: "2026-11-20" }), params)).status).toBe(200);
    expect(live.setArticleLive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "mark", day: "2026-11-20" }));
    expect((await POST(req({ action: "check" }), params)).status).toBe(200);
    expect(live.setArticleLive).toHaveBeenLastCalledWith(expect.anything(), expect.not.objectContaining({ day: expect.anything() }));
    expect((await POST(req({ action: "mark", day: "2026-11-20", tenantId: "ten_B" }), params)).status).toBe(400);
    expect((await POST(req({ action: "mark", day: "a very long day" }), params)).status).toBe(400);
  });

  it("answers with what setArticleLive refuses, and is off with its switch off", async () => {
    live.setArticleLive.mockResolvedValueOnce({ ok: false, status: 400, error: "invalid_day" } as never);
    const r = await POST(req({ action: "mark", day: "2026-12-30" }), params);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_day" });
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "false");
    expect((await POST(req({ action: "check" }), params)).status).toBe(503);
  });
});

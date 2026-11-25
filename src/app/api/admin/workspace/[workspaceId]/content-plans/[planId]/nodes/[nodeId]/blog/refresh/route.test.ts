import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: origin check, switch, sign-in, input, then the review module (tested in
// src/lib/content/blog/refreshReview.test.ts). Start also asks the brand's grant and cap.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1", name: "Acme" })) } })),
  isRateLimited: vi.fn(async () => false),
}));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(async (): Promise<unknown> => ({ id: "plan_1", workspaceId: "ws1" })) }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const review = vi.hoisted(() => ({
  readReview: vi.fn(async (): Promise<unknown> => ({ planId: "plan_1", workspaceId: "ws1", state: "running" })),
  startReview: vi.fn(async (): Promise<unknown> => ({ ok: true, review: { state: "running" }, started: true })),
  advanceReview: vi.fn(async (): Promise<unknown> => ({ state: "running", step: "sources" })),
  stopReview: vi.fn(async () => ({ state: "stopped" })),
}));
vi.mock("@/lib/content/blog/refreshReview", () => review);
const propose = vi.hoisted(() => ({
  applyReview: vi.fn(async (): Promise<unknown> => ({ ok: true, node: { id: "hub" }, applied: 2, skipped: 0, real: true, checked: true, review: null })),
  dismissReview: vi.fn(async (): Promise<unknown> => ({ ok: true, review: { state: "dismissed" } })),
}));
vi.mock("@/lib/content/blog/refreshPropose", () => propose);
const gate = vi.hoisted(() => ({ mayStartReview: vi.fn(async (): Promise<unknown> => ({ ok: true, used: 0, limit: 20 })) }));
vi.mock("@/lib/content/blog/refreshGate", () => gate);

const { GET, POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }) };
const URL = "http://localhost/api/admin/workspace/ws1/content-plans/plan_1/nodes/hub/blog/refresh";
const post = (body: unknown) => new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(s, "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", source: "idtoken", role: "member", userId: "u1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the refresh route", () => {
  it("is off with its switch off, and signed out", async () => {
    vi.stubEnv("BLOG_REFRESH_ENABLED", "false");
    expect((await GET(new Request(URL), params)).status).toBe(503);
    expect((await POST(post({ action: "start" }), params)).status).toBe(503);
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await POST(post({ action: "start" }), params)).status).toBe(401);
  });

  it("starts a review for a member, only with the brand's grant and reviews left", async () => {
    const r = await POST(post({ action: "start" }), params);
    expect(r.status).toBe(200);
    expect(review.startReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nodeId: "hub", by: "person" }));
    gate.mayStartReview.mockResolvedValueOnce({ ok: false, status: 403, error: "not_included" });
    expect((await POST(post({ action: "start" }), params)).status).toBe(403);
    gate.mayStartReview.mockResolvedValueOnce({ ok: false, status: 429, error: "monthly_limit" });
    expect(await (await POST(post({ action: "start" }), params)).json()).toEqual({ error: "monthly_limit" });
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(post({ action: "start" }), params)).status).toBe(429);
  });

  it("moves it a step, applies the ticked changes, dismisses or stops", async () => {
    expect(await (await POST(post({ action: "step" }), params)).json()).toEqual({ review: { state: "running", step: "sources" } });
    expect((await POST(post({ action: "apply", ids: ["p1", "p2"] }), params)).status).toBe(200);
    expect(propose.applyReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ planId: "plan_1", ids: ["p1", "p2"] }));
    expect((await POST(post({ action: "dismiss" }), params)).status).toBe(200);
    expect((await POST(post({ action: "stop" }), params)).status).toBe(200);
  });

  it("refuses bad input, another brand's tenant id, and changes while the autopilot writes", async () => {
    expect((await POST(post({ action: "apply", ids: [] }), params)).status).toBe(400);
    expect((await POST(post({ action: "apply", ids: ["../x"] }), params)).status).toBe(400);
    expect((await POST(post({ action: "start", tenantId: "ten_B" }), params)).status).toBe(400);
    content.getContentPlan.mockResolvedValueOnce({ id: "plan_1", workspaceId: "ws1", autopilot: { runId: "r", state: "working", at: "2026-11-25T10:00:00.000Z" } });
    expect((await POST(post({ action: "start" }), params)).status).toBe(409);
    expect(review.startReview).not.toHaveBeenCalled();
  });

  it("reads the review of an article in this programme only", async () => {
    expect((await (await GET(new Request(URL), params)).json()).review).toMatchObject({ state: "running" });
    review.readReview.mockResolvedValueOnce({ planId: "plan_1", workspaceId: "ws_other" });
    expect((await (await GET(new Request(URL), params)).json()).review).toBeNull();
  });
});

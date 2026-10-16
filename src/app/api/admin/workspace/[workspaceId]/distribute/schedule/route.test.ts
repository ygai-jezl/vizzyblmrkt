import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The order guard: a LinkedIn or X post with no account to publish from is refused at
// schedule time, instead of being accepted and failing when it's due.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const content = vi.hoisted(() => ({
  verifyWorkspace: vi.fn(async () => true),
  getContentPlan: vi.fn(),
  updateContentPlanNode: vi.fn(async () => {}),
}));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const scheduler = vi.hoisted(() => ({
  schedulePost: vi.fn(async () => ({ post: { id: "post_1" } })),
  setPostSpintax: vi.fn(),
  cancelScheduledPost: vi.fn(),
  listScheduledPosts: vi.fn(),
  SchedulePostConflictError: class extends Error {},
}));
vi.mock("@/lib/distribute/scheduler", () => scheduler);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenants);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const params = { params: Promise.resolve({ workspaceId: "ws_1" }) };
const later = new Date(Date.now() + 3600_000).toISOString();
const req = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/admin/workspace/ws_1/distribute/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentPlanId: "plan_1", nodeId: "n1", scheduledAt: later, ...body }),
  });
const planWith = (channel: string) => ({
  graph: { nodes: [{ id: "n1", status: "generated", body: "Hello", channel }] },
});
const conn = { enc: { ct: "c", iv: "i", tag: "t" }, connectedAt: "2026-10-16T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ORDER_GUARDS_ENABLED", "true");
  vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/workspace/[workspaceId]/distribute/schedule", () => {
  it("refuses a LinkedIn post when no LinkedIn account is connected", async () => {
    content.getContentPlan.mockResolvedValue(planWith("linkedin"));
    tenants.getTenantById.mockResolvedValue({ socialConnections: {} });
    const res = await POST(req({}), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "linkedin_not_connected" });
    expect(scheduler.schedulePost).not.toHaveBeenCalled();
  });

  it("refuses an X post without X, and a Page post without that Page", async () => {
    content.getContentPlan.mockResolvedValue(planWith("x"));
    tenants.getTenantById.mockResolvedValue({ socialConnections: { linkedin: { ...conn, platform: "linkedin", userId: "m1" } } });
    expect(await (await POST(req({}), params)).json()).toEqual({ error: "x_not_connected" });
    content.getContentPlan.mockResolvedValue(planWith("linkedin"));
    const asPage = await POST(req({ linkedInAuthorUrn: "urn:li:organization:42" }), params);
    expect(await asPage.json()).toEqual({ error: "linkedin_page_not_connected" });
  });

  it("schedules once the account is connected", async () => {
    content.getContentPlan.mockResolvedValue(planWith("linkedin"));
    tenants.getTenantById.mockResolvedValue({ socialConnections: { linkedin: { ...conn, platform: "linkedin", userId: "m1" } } });
    const res = await POST(req({}), params);
    expect(res.status).toBe(200);
    expect(scheduler.schedulePost).toHaveBeenCalledOnce();
  });

  it("leaves scheduling as before with the guards off, or while posting for real is off", async () => {
    content.getContentPlan.mockResolvedValue(planWith("linkedin"));
    tenants.getTenantById.mockResolvedValue({ socialConnections: {} });
    vi.stubEnv("ORDER_GUARDS_ENABLED", "false");
    expect((await POST(req({}), params)).status).toBe(200);
    vi.stubEnv("ORDER_GUARDS_ENABLED", "true");
    vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "false");
    expect((await POST(req({}), params)).status).toBe(200);
  });
});

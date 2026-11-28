import { beforeEach, describe, expect, it, vi } from "vitest";

// An article's versions in other languages (PAGE_LANGUAGES_ENABLED): members look, admins act.
// The logic is tested in src/lib/i18n/articleTranslations.test.ts; this checks the gate.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async (id: string) => (id === "ws1" ? { id } : null)) } })) }));
vi.mock("@/lib/tenant", () => tenant);
const logic = vi.hoisted(() => ({
  articleTranslationsView: vi.fn(async () => ({ status: 200, body: { versions: [] } })),
  articleTranslationsAction: vi.fn(async () => ({ status: 200, body: { approved: 1 } })),
}));
vi.mock("@/lib/i18n/articleTranslations", () => logic);

const { GET, POST } = await import("./route");
const params = (workspaceId = "ws1") => ({ params: Promise.resolve({ workspaceId, planId: "plan_1" }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/plan_1/translations", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});

describe("article translations route", () => {
  it("is 401 signed out and 404 for a workspace that isn't the brand's", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"), params())).status).toBe(401);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await GET(req("GET"), params("ws_other"))).status).toBe(404);
  });

  it("lets a member look but not act", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await GET(req("GET"), params())).status).toBe(200);
    expect((await POST(req("POST", { action: "make", lang: "fr" }), params())).status).toBe(403);
    expect(logic.articleTranslationsAction).not.toHaveBeenCalled();
  });

  it("hands an admin's action on with the plan and the body", async () => {
    expect(await (await POST(req("POST", { action: "approve", id: "tra_x", rev: 1 }), params())).json()).toEqual({ approved: 1 });
    expect(logic.articleTranslationsAction).toHaveBeenCalledWith(admin, "ws1", "plan_1", { action: "approve", id: "tra_x", rev: 1 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A journey's emails in other languages (ASSET_TRANSLATIONS_ENABLED): members look, admins act.
// The logic is tested in src/lib/i18n/translationsAdmin.test.ts; this checks the gate.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const admin = vi.hoisted(() => ({
  translationsView: vi.fn(async () => ({ status: 200, body: { emails: [] } })),
  translationsAction: vi.fn(async () => ({ status: 200, body: { approved: 1 } })),
}));
vi.mock("@/lib/i18n/translationsAdmin", () => admin);

const { GET, POST } = await import("./route");

const params = { params: Promise.resolve({ journeyId: "lcj_1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/lifecycle/journeys/lcj_1/translations", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const adminCtx = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("LIFECYCLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(adminCtx);
});
afterEach(() => vi.unstubAllEnvs());

describe("translations route", () => {
  it("is 503 while journeys are off", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "false");
    expect((await GET(req("GET"), params)).status).toBe(503);
  });

  it("is 401 when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"), params)).status).toBe(401);
    expect((await POST(req("POST", { action: "make" }), params)).status).toBe(401);
  });

  it("lets a member look but not act", async () => {
    session.getAdminContext.mockResolvedValue({ ...adminCtx, userId: "usr_member", role: "member" });
    expect((await GET(req("GET"), params)).status).toBe(200);
    expect((await POST(req("POST", { action: "make" }), params)).status).toBe(403);
    expect(admin.translationsAction).not.toHaveBeenCalled();
  });

  it("hands an admin's action on with the journey and the body", async () => {
    const res = await POST(req("POST", { action: "approve", id: "tr_x", rev: 1 }), params);
    expect(await res.json()).toEqual({ approved: 1 });
    expect(admin.translationsAction).toHaveBeenCalledWith(adminCtx, "lcj_1", { action: "approve", id: "tr_x", rev: 1 });
  });
});

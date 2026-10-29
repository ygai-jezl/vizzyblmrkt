import { beforeEach, describe, expect, it, vi } from "vitest";

// A save that carries the brief, and a delete, tell the article's notes what it holds now.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1" })) } })) }));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(), updateContentPlan: vi.fn(), deleteContentPlan: vi.fn() }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: vi.fn(), removePlanPageSoftly: vi.fn() }));
const seen = vi.hoisted(() => ({ syncSeenHolds: vi.fn() }));
vi.mock("@/lib/content/blog/seen", () => seen);

const { PUT, DELETE } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "p1" }) };
const BEFORE = { primaryQuestion: "Before?" };
const AFTER = { primaryQuestion: "After?" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/p1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
  content.getContentPlan.mockResolvedValueOnce({ id: "p1", name: "Old name", blog: BEFORE }).mockResolvedValue({ id: "p1", name: "How often to check", blog: AFTER });
});

describe("the plan route and the article's held notes", () => {
  it("a save with the brief passes what it held before and holds now", async () => {
    expect((await PUT(req("PUT", { blog: { primaryQuestion: "After?" } }), params)).status).toBe(200);
    expect(seen.syncSeenHolds).toHaveBeenCalledWith(admin, { article: { ref: "ws1/p1", title: "How often to check" }, before: BEFORE, after: AFTER });
  });

  it("a save without the brief leaves the notes alone", async () => {
    expect((await PUT(req("PUT", { name: "Renamed" }), params)).status).toBe(200);
    expect(seen.syncSeenHolds).not.toHaveBeenCalled();
  });

  it("a delete lets go of everything the article held", async () => {
    expect((await DELETE(req("DELETE"), params)).status).toBe(200);
    expect(seen.syncSeenHolds).toHaveBeenCalledWith(admin, { article: { ref: "ws1/p1", title: "Old name" }, before: BEFORE, after: null });
  });

  it("signed out, nothing is touched", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req("PUT", { blog: AFTER }), params)).status).toBe(401);
    expect((await DELETE(req("DELETE"), params)).status).toBe(401);
    expect(seen.syncSeenHolds).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Approving, archiving or deleting an autopilot draft closes its question rows in Review.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1" })) } })) }));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(), updateContentPlan: vi.fn(), deleteContentPlan: vi.fn() }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: vi.fn(), removePlanPageSoftly: vi.fn() }));
vi.mock("@/lib/content/blog/seen", () => ({ syncSeenHolds: vi.fn() }));
vi.mock("@/lib/content/blog/hubActions", () => ({ keepApprovedSeen: vi.fn() }));
const answers = vi.hoisted(() => ({ closeDraftRows: vi.fn() }));
vi.mock("@/lib/autopilot/answers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/autopilot/answers")>()), ...answers }));

const { PUT, DELETE } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "ap_1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/ap_1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const draft = (hubStatus: string, over: Record<string, unknown> = {}) => ({
  id: "ap_1",
  name: "How?",
  status: "ready",
  autopilot: { runId: "run_a", state: "done", at: "" },
  graph: { nodes: [{ id: "hub", type: "hub", status: hubStatus, body: "Text" }], edges: [] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});

describe("an autopilot draft's rows close with it", () => {
  it("approving the article closes them", async () => {
    content.getContentPlan.mockResolvedValueOnce(draft("generated")).mockResolvedValue(draft("approved"));
    expect((await PUT(req("PUT", { name: "How?" }), params)).status).toBe(200);
    expect(answers.closeDraftRows).toHaveBeenCalledWith(admin, expect.objectContaining({ id: "ap_1" }));
  });

  it("archiving it closes them", async () => {
    content.getContentPlan.mockResolvedValueOnce(draft("generated")).mockResolvedValue(draft("generated", { status: "archived" }));
    expect((await PUT(req("PUT", { status: "archived" }), params)).status).toBe(200);
    expect(answers.closeDraftRows).toHaveBeenCalledTimes(1);
  });

  it("a save that leaves it waiting doesn't", async () => {
    content.getContentPlan.mockResolvedValue(draft("generated"));
    expect((await PUT(req("PUT", { name: "Renamed" }), params)).status).toBe(200);
    expect(answers.closeDraftRows).not.toHaveBeenCalled();
  });

  it("deleting it closes them", async () => {
    content.getContentPlan.mockResolvedValue(draft("generated"));
    expect((await DELETE(req("DELETE"), params)).status).toBe(200);
    expect(answers.closeDraftRows).toHaveBeenCalledWith(admin, expect.objectContaining({ id: "ap_1" }));
  });
});

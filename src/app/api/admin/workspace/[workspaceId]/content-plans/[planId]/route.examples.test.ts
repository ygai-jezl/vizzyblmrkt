import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Approving a workflow email or a hub keeps it as an example in the exemplar store, on the channel
// its writer asks for (CONTENT_APPROVED_EXAMPLES_ENABLED). Before this, only LinkedIn and X posts
// were ever stored there, so email and hub writers asked for "newsletter" or "blog" and got nothing.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws1" })) } })),
  writePerformanceExemplar: vi.fn(async () => undefined),
  listApprovedExemplars: vi.fn(async () => []),
  deletePerformanceExemplars: vi.fn(async () => 0),
}));
vi.mock("@/lib/tenant", () => tenant);
const content = vi.hoisted(() => ({ getContentPlan: vi.fn(), updateContentPlan: vi.fn(), deleteContentPlan: vi.fn() }));
vi.mock("@/lib/tenant/workspaceContent", () => content);
vi.mock("@/lib/content/blog/pageActions", () => ({ syncPlanPageSoftly: vi.fn(), removePlanPageSoftly: vi.fn() }));
vi.mock("@/lib/content/blog/seen", () => ({ syncSeenHolds: vi.fn() }));
vi.mock("@/lib/content/blog/hubActions", () => ({ keepApprovedSeen: vi.fn() }));
vi.mock("@/lib/autopilot/answers", () => ({ closeDraftRows: vi.fn(), draftDoneWith: () => false }));
const embeddings = vi.hoisted(() => ({ embedDocument: vi.fn(async () => [0.1, 0.2, 0.3]) }));
vi.mock("@/lib/agents/embeddings", () => embeddings);

const { PUT } = await import("./route");

const admin = { tenantId: "ten_A", region: "eu", source: "idtoken", userId: "usr_admin", role: "member" };
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "plan_1" }) };
const save = (body: unknown) =>
  new Request("http://localhost/api/admin/workspace/ws1/content-plans/plan_1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const email = (status: string) => ({
  id: "email_1",
  type: "email",
  channel: "newsletter",
  status,
  subject: "Your first loaf, {{first_name}}",
  body: "Hi {{first_name}},\n\nHearth Bakery opens at seven. Come early for the sourdough.",
  placeholderValues: {},
});
const hub = (status: string) => ({
  id: "hub_1",
  type: "hub",
  channel: "newsletter",
  status,
  body: "# The week at Hearth Bakery\n\nWe tried a rye starter this week and kept it.",
  placeholderValues: {},
});
const plan = (nodes: Array<Record<string, unknown>>) => ({ id: "plan_1", workspaceId: "ws1", name: "Week", status: "ready", graph: { nodes, edges: [] } });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("approving a workflow email or a hub keeps it as an example", () => {
  it("stores an approved workflow email on the channel the email writer asks for, as its template", async () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true");
    content.getContentPlan.mockResolvedValueOnce(plan([email("generated")])).mockResolvedValue(plan([email("approved")]));
    expect((await PUT(save({ name: "Week" }), params)).status).toBe(200);

    expect(tenant.writePerformanceExemplar).toHaveBeenCalledTimes(1);
    const [ctx, row] = tenant.writePerformanceExemplar.mock.calls[0] as unknown as [typeof admin, Record<string, unknown>];
    expect(ctx).toBe(admin);
    expect(row).toMatchObject({ channel: "newsletter", metric: { name: "approved", value: 1 }, tags: ["piece:email"] });
    // The template a person approved: its merge values stay as tags, never filled in.
    expect(row.text).toContain("Subject: Your first loaf, {{first_name}}");
    expect(row.text).toContain("Hi {{first_name}},");
  });

  it("stores an approved hub on its own channel", async () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true");
    content.getContentPlan.mockResolvedValueOnce(plan([hub("generated")])).mockResolvedValue(plan([hub("approved")]));
    expect((await PUT(save({ name: "Week" }), params)).status).toBe(200);

    expect(tenant.writePerformanceExemplar).toHaveBeenCalledTimes(1);
    const [, row] = tenant.writePerformanceExemplar.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(row).toMatchObject({ channel: "newsletter", tags: ["piece:hub"] });
    expect(row.text).toContain("We tried a rye starter");
  });

  it("stores nothing with the switch off", async () => {
    content.getContentPlan.mockResolvedValueOnce(plan([email("generated"), hub("generated")])).mockResolvedValue(plan([email("approved"), hub("approved")]));
    expect((await PUT(save({ name: "Week" }), params)).status).toBe(200);
    expect(tenant.writePerformanceExemplar).not.toHaveBeenCalled();
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  it("stores nothing for a save that approves nothing", async () => {
    vi.stubEnv("CONTENT_APPROVED_EXAMPLES_ENABLED", "true");
    content.getContentPlan.mockResolvedValue(plan([email("approved"), hub("generated")]));
    expect((await PUT(save({ name: "Week" }), params)).status).toBe(200);
    expect(tenant.writePerformanceExemplar).not.toHaveBeenCalled();
  });
});

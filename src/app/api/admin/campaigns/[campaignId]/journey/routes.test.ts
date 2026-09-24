import { beforeEach, describe, expect, it, vi } from "vitest";

// Engine move D1: status changes only through Publish/Pause, which are admin-only,
// and an archived launch can't be published.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const service = vi.hoisted(() => ({
  journeyIdFor: (id: string) => `journey_${id}`,
  upsertJourneyDraft: vi.fn(async () => ({ ok: true, journey: { id: "journey_camp1" } })),
  setJourneyState: vi.fn(),
}));
vi.mock("@/lib/journey/service", () => service);
const abTest = vi.hoisted(() => ({ promoteVariant: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/journey/abTest", () => abTest);

const { PUT } = await import("./route");
const { POST: activate } = await import("./activate/route");
const { POST: promote } = await import("./abtest/route");

const params = { params: Promise.resolve({ campaignId: "camp1" }) };
const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const member = { ...admin, role: "member" };
const req = (method: string, body: unknown) =>
  new Request("http://localhost/api/admin/campaigns/camp1/journey", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const graph = { nodes: [], edges: [] };

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});

describe("journey routes (engine move D1)", () => {
  it("saving can't change a journey's status", async () => {
    const res = await PUT(req("PUT", { graph, status: "active" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "status_not_allowed" });
    expect(service.upsertJourneyDraft).not.toHaveBeenCalled();

    const ok = await PUT(req("PUT", { graph }), params);
    expect(ok.status).toBe(200);
    expect(service.upsertJourneyDraft).toHaveBeenCalledWith(admin, "camp1", graph);
  });

  it("only admins can publish or pause", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await activate(req("POST", { action: "activate" }), params);
    expect(res.status).toBe(403);
    expect(service.setJourneyState).not.toHaveBeenCalled();
  });

  it("publishing an archived launch is refused with 409", async () => {
    service.setJourneyState.mockResolvedValue({ ok: false, error: "launch_archived" });
    const res = await activate(req("POST", { action: "activate" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "launch_archived" });
  });

  it("only admins can promote an A/B winner", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await promote(req("POST", { action: "promote", nodeId: "email1", winnerVariantId: "v1" }), params);
    expect(res.status).toBe(403);
    expect(abTest.promoteVariant).not.toHaveBeenCalled();
  });
});

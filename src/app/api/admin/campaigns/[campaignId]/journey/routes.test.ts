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
const record = vi.hoisted(() => ({ closeDraft: vi.fn(async () => 1), memberOf: (ctx: { userId?: string }) => ({ type: "member", id: ctx.userId ?? null }) }));
vi.mock("@/lib/agentRecord/record", () => record);

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

  it("once the original editor is retired (engine move D6), saving is refused and a first publish is a 409", async () => {
    vi.stubEnv("WAITLIST_LEGACY_EDITOR", "read_only");
    const res = await PUT(req("PUT", { graph }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "original_editor_retired" });
    expect(service.upsertJourneyDraft).not.toHaveBeenCalled();
    service.setJourneyState.mockResolvedValue({ ok: false, error: "original_editor_retired" });
    expect((await activate(req("POST", { action: "activate" }), params)).status).toBe(409);
    vi.unstubAllEnvs();
  });

  it("says where to move the launch in the words in use (an idea while the words are on)", async () => {
    vi.stubEnv("WAITLIST_LEGACY_EDITOR", "read_only");
    try {
      expect((await (await PUT(req("PUT", { graph }), params)).json()).message).toBe(
        "Welcome emails are now built in the new journey editor. Move this launch in its Settings.",
      );
      for (const k of ["NEXT_PUBLIC_NAV_V2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "NEXT_PUBLIC_NAV_IDEAS_ENABLED", "LAUNCH_IDEAS_ENABLED"]) {
        vi.stubEnv(k, "true");
      }
      expect((await (await PUT(req("PUT", { graph }), params)).json()).message).toBe(
        "Welcome emails are now built in the new journey editor. Move this idea in its Settings.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("publishing an archived launch is refused with 409", async () => {
    service.setJourneyState.mockResolvedValue({ ok: false, error: "launch_archived" });
    const res = await activate(req("POST", { action: "activate" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "launch_archived" });
  });

  it("turning the welcome emails on closes Vizzy's draft record as kept by the admin; pausing doesn't", async () => {
    service.setJourneyState.mockResolvedValue({ ok: true, status: "active", enqueued: 0 });
    expect((await activate(req("POST", { action: "activate" }), params)).status).toBe(200);
    expect(record.closeDraft).toHaveBeenCalledWith(
      admin,
      { kind: "launch_journey", ref: "journey_camp1" },
      expect.objectContaining({ to: "acted", by: { type: "member", id: "u1" } }),
    );
    record.closeDraft.mockClear();
    service.setJourneyState.mockResolvedValue({ ok: true, status: "paused" });
    expect((await activate(req("POST", { action: "pause" }), params)).status).toBe(200);
    expect(record.closeDraft).not.toHaveBeenCalled();
  });

  it("only admins can promote an A/B winner", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const res = await promote(req("POST", { action: "promote", nodeId: "email1", winnerVariantId: "v1" }), params);
    expect(res.status).toBe(403);
    expect(abTest.promoteVariant).not.toHaveBeenCalled();
  });
});

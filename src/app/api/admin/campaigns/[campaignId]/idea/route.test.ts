import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A launch's idea: same origin, then the switch (404), sign-in (401), admin (403) and a strict body
// (400). The service owns the rest (src/lib/ideas/service.test.ts); here it is a stub.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const service = vi.hoisted(() => ({ setIdea: vi.fn() }));
vi.mock("@/lib/ideas/service", async (orig) => ({ ...(await orig<typeof import("@/lib/ideas/service")>()), setIdea: service.setIdea }));

const { PATCH } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const params = (campaignId = "team-spaces") => ({ params: Promise.resolve({ campaignId }) });
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/campaigns/team-spaces/idea", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LAUNCH_IDEAS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  service.setIdea.mockResolvedValue({ ok: true, idea: { status: "testing" }, changed: true, archived: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/admin/campaigns/[campaignId]/idea", () => {
  it("is not found while LAUNCH_IDEAS_ENABLED is off, before anything else", async () => {
    vi.stubEnv("LAUNCH_IDEAS_ENABLED", "false");
    const res = await PATCH(req({ status: "testing" }), params());
    expect(res.status).toBe(404);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(service.setIdea).not.toHaveBeenCalled();
  });

  it("refuses another site's request", async () => {
    const res = await PATCH(req({ status: "testing" }, { "sec-fetch-site": "cross-site" }), params());
    expect(res.status).toBe(403);
    expect(service.setIdea).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PATCH(req({ status: "testing" }), params())).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PATCH(req({ status: "testing" }), params())).status).toBe(403);
    expect(service.setIdea).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["nothing to change", {}],
    ["an unknown status", { status: "archived" }],
    ["a field it doesn't know", { status: "testing", tenantId: "ten_B" }],
    ["a hypothesis over 500 characters", { hypothesis: "a".repeat(501) }],
  ])("400s for %s", async (_label, body) => {
    const res = await PATCH(req(body), params());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_input" });
    expect(service.setIdea).not.toHaveBeenCalled();
  });

  it("passes the admin's own context and the parsed change, and answers with the idea", async () => {
    const res = await PATCH(req({ status: "testing", hypothesis: "  Teams pay.  " }), params());
    expect(res.status).toBe(200);
    expect(service.setIdea).toHaveBeenCalledWith(admin, "team-spaces", { status: "testing", hypothesis: "Teams pay." });
    expect(await res.json()).toEqual({ ok: true, idea: { status: "testing" }, changed: true, archived: null });
  });

  it("answers the service's refusals: another brand's launch is not found, closing needs parked or killed", async () => {
    service.setIdea.mockResolvedValueOnce({ ok: false, status: 404, error: "not_found" });
    const missing = await PATCH(req({ status: "testing" }), params("their-launch"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    service.setIdea.mockResolvedValueOnce({ ok: false, status: 400, error: "not_parked_or_killed" });
    const early = await PATCH(req({ status: "testing", closeWaitlist: true }), params());
    expect(early.status).toBe(400);
    expect(await early.json()).toEqual({ error: "not_parked_or_killed" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The gate for every connection route: origin, sign-in, then the admin role when the
// route changes something. The OAuth hops skip the origin check (they come back from
// the provider's site) and leave the response to the route.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const { integrationsAdmin, integrationsHopAdmin } = await import("./admin");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (site?: string) =>
  new Request("http://localhost/api/admin/integrations/x", {
    method: "DELETE",
    headers: site ? { "sec-fetch-site": site } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});

describe("integrationsAdmin", () => {
  it("403s a cross-site request before reading the session", async () => {
    const gate = await integrationsAdmin(req("cross-site"), { adminOnly: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    for (const adminOnly of [true, false]) {
      const gate = await integrationsAdmin(req(), { adminOnly });
      expect(gate.ok).toBe(false);
      if (!gate.ok) {
        expect(gate.response.status).toBe(401);
        expect(await gate.response.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  it("403s a member only when the route is admin only", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const blocked = await integrationsAdmin(req(), { adminOnly: true });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.response.status).toBe(403);
      expect(await blocked.response.json()).toEqual({ error: "forbidden" });
    }
    const read = await integrationsAdmin(req(), { adminOnly: false });
    expect(read).toEqual({ ok: true, ctx: member });
  });

  it("403s a context with no role on an admin only route", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: undefined });
    const gate = await integrationsAdmin(req(), { adminOnly: true });
    expect(gate.ok).toBe(false);
  });

  it("lets an admin through, same origin", async () => {
    const gate = await integrationsAdmin(req("same-origin"), { adminOnly: true });
    expect(gate).toEqual({ ok: true, ctx: admin });
  });
});

describe("integrationsHopAdmin", () => {
  it("says signed_out, forbidden or ok", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect(await integrationsHopAdmin()).toEqual({ ok: false, why: "signed_out" });
    session.getAdminContext.mockResolvedValue(member);
    expect(await integrationsHopAdmin()).toEqual({ ok: false, why: "forbidden" });
    session.getAdminContext.mockResolvedValue(admin);
    expect(await integrationsHopAdmin()).toEqual({ ok: true, ctx: admin });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Save and dismiss on Brand › Brand map: flag, then sign-in, then admin; the store decides
// the rest (a save over someone else's, an unreadable map, a check that fails).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({
  saveBrandMap: vi.fn(),
  dismissBrandMapSuggestions: vi.fn(),
}));
vi.mock("@/lib/brandMap/store", () => store);
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", rootDomain: "acme.example", allowedOrigins: [] })) }));
vi.mock("@/lib/tenant", () => tenant);

const { PUT } = await import("./route");
const { DELETE } = await import("./suggestions/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/map", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const MAP = { id: "bm_ten_A", tenantId: "ten_A", rev: 2, identity: { name: "Acme" }, subjects: [], names: [], suggestions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  store.saveBrandMap.mockResolvedValue({ ok: true, value: MAP });
  store.dismissBrandMapSuggestions.mockResolvedValue({ ok: true, value: MAP });
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/brand-kit/map", () => {
  it("503s with the flag off, before anything else", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "");
    expect((await PUT(req("PUT", { baseRev: 0, map: {} }))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req("PUT", { baseRev: 0, map: {} }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", { baseRev: 0, map: {} }))).status).toBe(403);
    expect(store.saveBrandMap).not.toHaveBeenCalled();
  });

  it("400s without a revision to start from", async () => {
    for (const body of [undefined, {}, { map: {} }, { baseRev: -1, map: {} }, { baseRev: "1", map: {} }]) {
      expect((await PUT(req("PUT", body))).status).toBe(400);
    }
    expect(store.saveBrandMap).not.toHaveBeenCalled();
  });

  it("saves, checking home pages against the brand's own domains", async () => {
    const res = await PUT(req("PUT", { baseRev: 1, map: { identity: { name: "Acme" } }, accepted: ["name:peec"], dismissed: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, map: MAP });
    expect(store.saveBrandMap).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ baseRev: 1, accepted: ["name:peec"], dismissed: [], ownSites: ["acme.example"] }),
      {},
    );
  });

  it("hands back the current map when someone else saved first", async () => {
    store.saveBrandMap.mockResolvedValue({ ok: false, status: 409, error: "map_changed", current: MAP });
    const res = await PUT(req("PUT", { baseRev: 1, map: {} }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "map_changed", map: MAP });
  });

  it("says which rows fail a check", async () => {
    store.saveBrandMap.mockResolvedValue({ ok: false, status: 400, error: "invalid_map", issues: [{ path: "names.0.home", message: "must be a page on your own site" }] });
    const res = await PUT(req("PUT", { baseRev: 1, map: {} }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_map", issues: [{ path: "names.0.home", message: "must be a page on your own site" }] });
  });
});

describe("DELETE /api/admin/brand-kit/map/suggestions", () => {
  it("is an admin's, behind the flag", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "");
    expect((await DELETE(req("DELETE", { keys: ["name:peec"] }))).status).toBe(503);
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(member);
    expect((await DELETE(req("DELETE", { keys: ["name:peec"] }))).status).toBe(403);
    expect(store.dismissBrandMapSuggestions).not.toHaveBeenCalled();
  });

  it("needs at least one key", async () => {
    for (const body of [undefined, {}, { keys: [] }, { keys: [""] }]) {
      expect((await DELETE(req("DELETE", body))).status).toBe(400);
    }
  });

  it("dismisses by key at once", async () => {
    const res = await DELETE(req("DELETE", { keys: ["name:peec", "subject:audits"] }));
    expect(res.status).toBe(200);
    expect(store.dismissBrandMapSuggestions).toHaveBeenCalledWith(admin, ["name:peec", "subject:audits"], {});
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › What we've seen › How often a note goes in: origin, the notes, sign-in and admin, then this switch.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const control = vi.hoisted(() => ({ setTenantNotesRest: vi.fn(async (_id: string, rest: unknown) => rest) }));
vi.mock("@/lib/tenant/control", () => control);

const { PUT } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const put = (body: unknown, site?: string) =>
  new Request("http://localhost/api/admin/brand-kit/notes/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) },
    body: JSON.stringify(body),
  });
const REST = { restDays: 21, maxUses: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  for (const v of ["BRAND_NOTES_ENABLED", "BRAND_NOTES_QUESTIONS_ENABLED", "BRAND_NOTES_REST_ENABLED"]) vi.stubEnv(v, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/brand-kit/notes/settings", () => {
  it("saves both numbers for the signed-in admin's own brand", async () => {
    const res = await PUT(put(REST));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rest: REST });
    expect(control.setTenantNotesRest).toHaveBeenCalledWith("ten_A", REST, undefined);
  });

  it("503 with the switch off, and nothing saved", async () => {
    vi.stubEnv("BRAND_NOTES_REST_ENABLED", "");
    expect((await PUT(put(REST))).status).toBe(503);
    vi.stubEnv("BRAND_NOTES_ENABLED", "");
    expect((await PUT(put(REST))).status).toBe(503);
    expect(control.setTenantNotesRest).not.toHaveBeenCalled();
  });

  it("401 signed out, 403 for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(put(REST))).status).toBe(401);
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await PUT(put(REST))).status).toBe(403);
    expect(control.setTenantNotesRest).not.toHaveBeenCalled();
  });

  it("400 unless both numbers are given and in range, and never takes a brand from the body", async () => {
    for (const body of [{ restDays: 30 }, { restDays: -1, maxUses: 3 }, { restDays: 30, maxUses: 0 }, { restDays: 1.5, maxUses: 3 }, { ...REST, tenantId: "ten_B" }, null]) {
      expect((await PUT(put(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(control.setTenantNotesRest).not.toHaveBeenCalled();
  });

  it("403 from another site", async () => {
    expect((await PUT(put(REST, "cross-site"))).status).toBe(403);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › Image style: switch, then sign-in, then admin; a strict parse; writes only the style.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const control = vi.hoisted(() => ({
  setTenantImageStyle: vi.fn(async (_id: string, style: unknown) => ({ ...(style as object), updatedAt: "2026-10-19T00:00:00.000Z" })),
  clearTenantImageStyle: vi.fn(async () => undefined),
  clearTenantImageStyleSuggestion: vi.fn(async () => true),
}));
vi.mock("@/lib/tenant/control", () => control);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenants);

const { GET, PUT, DELETE } = await import("./route");
const suggestion = await import("./suggestion/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const style = { defaultStyleId: "headline_card", channels: { linkedin: "natural_photo" } };
const req = (method: string, body?: unknown, url = "http://localhost/api/admin/brand-kit/image-style") =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/brand-kit/image-style", () => {
  it("503s with the switch off, before anything else", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "");
    expect((await PUT(req("PUT", style))).status).toBe(503);
    expect((await GET()).status).toBe(503);
    expect(control.setTenantImageStyle).not.toHaveBeenCalled();
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out; members can read but not save", async () => {
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await PUT(req("PUT", style))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", style))).status).toBe(403);
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    tenants.getTenantById.mockResolvedValue({ imageStyle: { defaultStyleId: "soft_3d" } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imageStyle: { defaultStyleId: "soft_3d" }, suggestion: null });
  });

  it("saves a strict style, stamped with who saved it, and clears the suggestion it applies", async () => {
    const res = await PUT(req("PUT", { ...style, fromSuggestion: "2026-10-19T10:00:00.000Z" }));
    expect(res.status).toBe(200);
    expect(control.setTenantImageStyle).toHaveBeenCalledWith(
      "ten_A",
      { defaultStyleId: "headline_card", channels: { linkedin: "natural_photo" }, accentHex: null, logoOnSocial: true, headlineOnSocial: true },
      undefined,
      { updatedBy: "usr_admin", clearSuggestionAt: "2026-10-19T10:00:00.000Z" },
    );
  });

  it("refuses an unknown style or a stray field", async () => {
    expect((await PUT(req("PUT", { defaultStyleId: "nope" }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...style, sneaky: true }))).status).toBe(400);
    expect(control.setTenantImageStyle).not.toHaveBeenCalled();
  });

  it("Reset removes the style", async () => {
    expect((await DELETE(req("DELETE"))).status).toBe(200);
    expect(control.clearTenantImageStyle).toHaveBeenCalledWith("ten_A");
  });

  it("Dismiss clears the suggestion the admin saw", async () => {
    const res = await suggestion.DELETE(req("DELETE", { suggestedAt: "2026-10-19T10:00:00.000Z" }));
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(control.clearTenantImageStyleSuggestion).toHaveBeenCalledWith("ten_A", "2026-10-19T10:00:00.000Z");
    expect((await suggestion.DELETE(req("DELETE", {}))).status).toBe(400);
  });
});

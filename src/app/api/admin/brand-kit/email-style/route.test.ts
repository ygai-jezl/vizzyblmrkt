import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › Email style: flag, then sign-in, then admin; a strict parse; the logo must be
// this tenant's PNG/JPEG. Save and Reset write only `tenant.emailStyle` (Save may also clear
// the suggestion it applies).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const logos = vi.hoisted(() => ({ getLogo: vi.fn() }));
vi.mock("@/lib/admin/brandLogos", () => logos);
const control = vi.hoisted(() => ({
  setTenantEmailStyle: vi.fn(async (_id: string, style: unknown) => (style ? { ...style, updatedAt: "2026-09-27T00:00:00.000Z" } : null)),
}));
vi.mock("@/lib/tenant/control", () => control);

const { PUT, DELETE } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const logoRow = {
  id: "logo_1",
  tenantId: "ten_A",
  filename: FILE,
  mimeType: "image/png",
  title: "Logo",
  byteSize: 1000,
  isPrimary: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const style = {
  logo: { id: "logo_1", filename: FILE, width: 120, height: 40 },
  companyName: null,
  headerColor: "#0b1f3a",
  accentColor: "#ff6b35",
};
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/email-style", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  logos.getLogo.mockResolvedValue(logoRow);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/brand-kit/email-style", () => {
  it("503s with the flag off, before anything else", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "");
    const res = await PUT(req("PUT", style));
    expect(res.status).toBe(503);
    expect((await DELETE(req("DELETE"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await PUT(req("PUT", style))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", style))).status).toBe(403);
    expect((await DELETE(req("DELETE"))).status).toBe(403);
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad hex", { ...style, headerColor: "navy" }],
    ["a short hex", { ...style, accentColor: "#abc" }],
    ["{{ in the name", { ...style, companyName: "Hi {{user.first_name}}" }],
    ["*| in the name", { ...style, companyName: "*|FNAME|* Co" }],
    ["< in the name", { ...style, companyName: "<b>Example</b>" }],
    ["a WebP filename", { ...style, logo: { ...style.logo, filename: FILE.replace(".png", ".webp") } }],
    ["no body", undefined],
  ])("400s for %s", async (_label, body) => {
    const res = await PUT(req("PUT", body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input", issues: expect.any(Array) });
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("400s for a logo that isn't this tenant's, or whose file doesn't match", async () => {
    logos.getLogo.mockResolvedValue(null);
    const res = await PUT(req("PUT", style));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_logo" });
    expect(logos.getLogo).toHaveBeenCalledWith(admin, "logo_1");

    logos.getLogo.mockResolvedValue({ ...logoRow, filename: "7c9e6679-7425-40de-944b-e07fc1f90ae7.png" });
    expect((await PUT(req("PUT", style))).status).toBe(400);
    logos.getLogo.mockResolvedValue({ ...logoRow, mimeType: "image/webp" });
    expect((await PUT(req("PUT", style))).status).toBe(400);
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("rounds and clamps the logo's measured size instead of refusing it", async () => {
    const res = await PUT(req("PUT", { ...style, logo: { ...style.logo, width: 199.6, height: 47.2 } }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[0]![1]).toMatchObject({ logo: { width: 200, height: 47 } });

    await PUT(req("PUT", { ...style, logo: { ...style.logo, width: 640, height: 0.2 } }));
    expect(control.setTenantEmailStyle.mock.calls[1]![1]).toMatchObject({ logo: { width: 200, height: 1 } });
  });

  it("saves for an admin: a cleaned name, lowercased colours, stamped with who saved it", async () => {
    const res = await PUT(req("PUT", { ...style, companyName: "  Example⁣ Co  ", headerColor: "#0B1F3A" }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith(
      "ten_A",
      { ...style, companyName: "Example Co", headerColor: "#0b1f3a" },
      undefined,
      { updatedBy: "usr_admin" },
    );
    expect(await res.json()).toMatchObject({ emailStyle: { companyName: "Example Co", headerColor: "#0b1f3a" } });
  });

  it("saving a reviewed suggestion asks for it to be cleared (if it's still the pending one)", async () => {
    const suggestedAt = "2026-09-27T10:00:00.000Z";
    const res = await PUT(req("PUT", { ...style, fromSuggestion: suggestedAt }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", style, undefined, {
      updatedBy: "usr_admin",
      clearSuggestionAt: suggestedAt,
    });
  });

  it("400s for a fromSuggestion that isn't a short string", async () => {
    for (const fromSuggestion of [42, "", "x".repeat(41)]) {
      expect((await PUT(req("PUT", { ...style, fromSuggestion }))).status).toBe(400);
    }
    expect(control.setTenantEmailStyle).not.toHaveBeenCalled();
  });

  it("a blank name or no logo is fine", async () => {
    const res = await PUT(req("PUT", { ...style, logo: null, companyName: "   " }));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle.mock.calls[0]![1]).toMatchObject({ logo: null, companyName: null });
    expect(logos.getLogo).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/brand-kit/email-style", () => {
  it("clears the style for an admin", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(control.setTenantEmailStyle).toHaveBeenCalledWith("ten_A", null);
  });
});

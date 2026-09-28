import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a logo the Email style uses drops the style to its name band first.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const logos = vi.hoisted(() => ({
  getLogo: vi.fn(),
  updateLogo: vi.fn(),
  deleteLogo: vi.fn(async () => {}),
  setPrimaryLogo: vi.fn(),
}));
vi.mock("@/lib/admin/brandLogos", () => logos);
const storage = vi.hoisted(() => ({ deleteBrandLogo: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/brandLogo", () => storage);
const control = vi.hoisted(() => ({ clearTenantEmailStyleLogo: vi.fn(async () => true) }));
vi.mock("@/lib/tenant/control", () => control);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenants);

const { DELETE } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const styleWith = (filename: string) => ({
  emailStyle: { logo: { id: "logo_x", filename, width: 120, height: 40 }, companyName: null, headerColor: "#111111", accentColor: "#111111" },
});
const params = { params: Promise.resolve({ id: "logo_1" }) };
const req = () => new Request("http://localhost/api/admin/brand-kit/logos/logo_1", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  logos.getLogo.mockResolvedValue({ id: "logo_1", tenantId: "ten_A", filename: FILE, mimeType: "image/png" });
});
afterEach(() => vi.unstubAllEnvs());

describe("DELETE /api/admin/brand-kit/logos/[id]", () => {
  it("clears the Email style's logo before deleting the row and the bytes", async () => {
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(control.clearTenantEmailStyleLogo).toHaveBeenCalledWith("ten_A", FILE);
    expect(control.clearTenantEmailStyleLogo.mock.invocationCallOrder[0]).toBeLessThan(
      logos.deleteLogo.mock.invocationCallOrder[0]!,
    );
    expect(storage.deleteBrandLogo).toHaveBeenCalledWith("ten_A", FILE);
  });

  it("a member can't delete the logo the Email style uses", async () => {
    session.getAdminContext.mockResolvedValue(member);
    tenants.getTenantById.mockResolvedValue(styleWith(FILE));
    const res = await DELETE(req(), params);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/ask an admin/);
    expect(control.clearTenantEmailStyleLogo).not.toHaveBeenCalled();
    expect(logos.deleteLogo).not.toHaveBeenCalled();
    expect(storage.deleteBrandLogo).not.toHaveBeenCalled();
  });

  it("a member can delete any other logo", async () => {
    session.getAdminContext.mockResolvedValue(member);
    tenants.getTenantById.mockResolvedValue(styleWith("11111111-2222-4333-8444-555555555555.png"));
    expect((await DELETE(req(), params)).status).toBe(200);
    expect(logos.deleteLogo).toHaveBeenCalled();
    tenants.getTenantById.mockResolvedValue({});
    expect((await DELETE(req(), params)).status).toBe(200);
  });

  it("an unknown logo clears nothing", async () => {
    logos.getLogo.mockResolvedValue(null);
    expect((await DELETE(req(), params)).status).toBe(404);
    expect(control.clearTenantEmailStyleLogo).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenants);
const control = vi.hoisted(() => ({ setTenantSiteFonts: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/control", () => control);
const detect = vi.hoisted(() => ({ detectSiteFonts: vi.fn() }));
vi.mock("@/lib/content/create/fontsFromWebsite", () => detect);

const { POST } = await import("./route");
const req = () => new Request("http://localhost/api/admin/brand-kit/site-fonts", { method: "POST" });
const FOUND = {
  heading: { family: "Roboto", detected: null, source: "match" },
  body: { family: "Roboto", detected: null, source: "match" },
  domain: "example.com",
  detectedAt: "2026-10-19T12:00:00.000Z",
  systemOnly: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
  tenants.getTenantById.mockResolvedValue({ rootDomain: "example.com" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST site fonts", () => {
  it("needs both switches", async () => {
    expect((await POST(req())).status).toBe(503);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect(await (await POST(req())).json()).toMatchObject({ error: "site_fonts_disabled" });
    expect(detect.detectSiteFonts).not.toHaveBeenCalled();
  });

  describe("with the switches on", () => {
    beforeEach(() => {
      vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
      vi.stubEnv("BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED", "true");
    });

    it("reads the primary domain and saves what it found", async () => {
      detect.detectSiteFonts.mockResolvedValueOnce(FOUND);
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(detect.detectSiteFonts).toHaveBeenCalledWith("example.com");
      expect(control.setTenantSiteFonts).toHaveBeenCalledWith("ten_A", FOUND);
    });

    it("saves nothing when the site can't be read, and needs a domain", async () => {
      detect.detectSiteFonts.mockResolvedValueOnce(null);
      expect((await POST(req())).status).toBe(502);
      tenants.getTenantById.mockResolvedValueOnce({ rootDomain: "" });
      expect((await POST(req())).status).toBe(400);
      expect(control.setTenantSiteFonts).not.toHaveBeenCalled();
    });

    it("members can't run it", async () => {
      session.getAdminContext.mockResolvedValueOnce({ tenantId: "ten_A", region: "us", userId: "u", role: "member" });
      expect((await POST(req())).status).toBe(403);
    });
  });
});

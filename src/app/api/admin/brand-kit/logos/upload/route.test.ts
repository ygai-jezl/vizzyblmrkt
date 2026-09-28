import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `keepPrimary` (the Email style's logo clean-up) flags today's primary on the server first,
// only with the header options on.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const logos = vi.hoisted(() => ({
  MAX_LOGOS_PER_TENANT: 60,
  countLogosUpTo: vi.fn(),
  pinPrimaryLogo: vi.fn(),
  recordLogo: vi.fn(),
}));
vi.mock("@/lib/admin/brandLogos", () => logos);
const storage = vi.hoisted(() => ({ MAX_LOGO_BYTES: 8 * 1024 * 1024, storeBrandLogo: vi.fn() }));
vi.mock("@/lib/tenant/brandLogo", () => storage);
vi.mock("@/lib/workspace/assetStore", () => ({ isAllowedScreenshotType: (t: string) => t === "image/png" }));

const { POST } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

function req(fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "Logo (white).png", { type: "image/png" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/api/admin/brand-kit/logos/upload", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_KIT_LOGOS_ENABLED", "true");
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  logos.countLogosUpTo.mockResolvedValue(3);
  logos.pinPrimaryLogo.mockResolvedValue("logo_primary");
  logos.recordLogo.mockImplementation(async (_scope: unknown, input: Record<string, unknown>) => ({ id: "logo_new", ...input }));
  storage.storeBrandLogo.mockResolvedValue({ ok: true, filename: FILE, mimeType: "image/png" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/logos/upload", () => {
  it("without keepPrimary, leaves the primary alone and answers as before", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(logos.pinPrimaryLogo).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ logo: expect.objectContaining({ id: "logo_new", isPrimary: false }) });
  });

  it("with keepPrimary, flags today's primary before storing the new logo, and says which it is", async () => {
    const res = await POST(req({ keepPrimary: "1" }));
    expect(res.status).toBe(200);
    expect(logos.pinPrimaryLogo).toHaveBeenCalledWith(admin);
    expect(logos.pinPrimaryLogo.mock.invocationCallOrder[0]).toBeLessThan(storage.storeBrandLogo.mock.invocationCallOrder[0]!);
    expect(await res.json()).toEqual({
      logo: expect.objectContaining({ id: "logo_new", isPrimary: false, title: "Logo (white).png" }),
      primaryId: "logo_primary",
    });
  });

  it("with the header options off, ignores keepPrimary and answers as before", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const res = await POST(req({ keepPrimary: "1" }));
    expect(res.status).toBe(200);
    expect(logos.pinPrimaryLogo).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ logo: expect.objectContaining({ id: "logo_new", isPrimary: false }) });
  });

  it("uploads nothing when the primary can't be kept in place", async () => {
    logos.pinPrimaryLogo.mockRejectedValue(new Error("firestore down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(req({ keepPrimary: "1" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "pin_failed", message: "Couldn't keep your primary logo in place — try again." });
    expect(storage.storeBrandLogo).not.toHaveBeenCalled();
    expect(logos.recordLogo).not.toHaveBeenCalled();
  });

  it("the first logo is the primary itself, so there's nothing to keep", async () => {
    logos.countLogosUpTo.mockResolvedValue(0);
    const res = await POST(req({ keepPrimary: "1" }));
    expect(logos.pinPrimaryLogo).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ logo: expect.objectContaining({ isPrimary: true }) });
  });

  it("keeps nothing when the logo can't be added anyway", async () => {
    logos.countLogosUpTo.mockResolvedValue(60);
    expect((await POST(req({ keepPrimary: "1" }))).status).toBe(409);
    expect(logos.pinPrimaryLogo).not.toHaveBeenCalled();
  });
});

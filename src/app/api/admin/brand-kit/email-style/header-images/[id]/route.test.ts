import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deleting an email header image: admin-only, with the header options on; the saved style
// goes back to its header colour first, then the row, then the style is cleared again (for a
// Save that raced the delete), then the bytes.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const assets = vi.hoisted(() => ({ getBrandAsset: vi.fn(), deleteBrandAsset: vi.fn(async () => {}) }));
vi.mock("@/lib/admin/brandAssets", () => assets);
const store = vi.hoisted(() => ({ deleteBrandAssetBytes: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/brandAssetStore", () => store);
const control = vi.hoisted(() => ({ clearTenantEmailStyleHeaderImage: vi.fn(async () => true) }));
vi.mock("@/lib/tenant/control", () => control);

const { DELETE } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const row = (category: string) => ({
  id: "hdr_1",
  tenantId: "ten_A",
  category,
  filename: FILE,
  mimeType: "image/jpeg",
  title: "Spring banner",
  byteSize: 1000,
  width: 1200,
  height: 300,
  createdAt: "2026-09-01T00:00:00.000Z",
});
const params = { params: Promise.resolve({ id: "hdr_1" }) };
const req = () =>
  new Request("http://localhost/api/admin/brand-kit/email-style/header-images/hdr_1", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  assets.getBrandAsset.mockResolvedValue(row("header"));
  control.clearTenantEmailStyleHeaderImage.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

/** Nothing was cleared or deleted. */
function expectNothingDeleted() {
  expect(control.clearTenantEmailStyleHeaderImage).not.toHaveBeenCalled();
  expect(assets.deleteBrandAsset).not.toHaveBeenCalled();
  expect(store.deleteBrandAssetBytes).not.toHaveBeenCalled();
}

describe("DELETE /api/admin/brand-kit/email-style/header-images/[id]", () => {
  it("503s with the Email style or the header options off", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const res = await DELETE(req(), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "header_options_disabled" });

    vi.stubEnv("EMAIL_STYLE_ENABLED", "");
    expect((await DELETE(req(), params)).status).toBe(503);
    expectNothingDeleted();
  });

  it("401s signed out and 403s for a member, even for an image the style doesn't use", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await DELETE(req(), params)).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await DELETE(req(), params)).status).toBe(403);
    expect(assets.getBrandAsset).not.toHaveBeenCalled();
    expectNothingDeleted();
  });

  it("404s an icon or graphic row, and an unknown id", async () => {
    for (const found of [row("icon"), row("graphic"), null]) {
      assets.getBrandAsset.mockResolvedValue(found);
      const res = await DELETE(req(), params);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(assets.getBrandAsset).toHaveBeenCalledWith(admin, "hdr_1");
    expectNothingDeleted();
  });

  it("clears the style first, then deletes the row, clears again, then the bytes, and says whether it cleared", async () => {
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(control.clearTenantEmailStyleHeaderImage).toHaveBeenCalledTimes(2);
    expect(control.clearTenantEmailStyleHeaderImage).toHaveBeenNthCalledWith(1, "ten_A", FILE);
    expect(control.clearTenantEmailStyleHeaderImage).toHaveBeenNthCalledWith(2, "ten_A", FILE);
    expect(assets.deleteBrandAsset).toHaveBeenCalledWith(admin, "hdr_1");
    expect(store.deleteBrandAssetBytes).toHaveBeenCalledWith("ten_A", "header", FILE);
    const order = [
      control.clearTenantEmailStyleHeaderImage.mock.invocationCallOrder[0]!,
      assets.deleteBrandAsset.mock.invocationCallOrder[0]!,
      control.clearTenantEmailStyleHeaderImage.mock.invocationCallOrder[1]!,
      store.deleteBrandAssetBytes.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));

    control.clearTenantEmailStyleHeaderImage.mockResolvedValue(false);
    expect(await (await DELETE(req(), params)).json()).toEqual({ ok: true, cleared: false });
  });

  it("clears a Save that wrote the image after the first clear but before the row went", async () => {
    // The first clear finds nothing (the Save hadn't written yet); by the second, it has.
    control.clearTenantEmailStyleHeaderImage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await DELETE(req(), params);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(control.clearTenantEmailStyleHeaderImage).toHaveBeenCalledTimes(2);
    expect(store.deleteBrandAssetBytes).toHaveBeenCalledWith("ten_A", "header", FILE);
  });

  it("deletes nothing else when clearing the style fails", async () => {
    control.clearTenantEmailStyleHeaderImage.mockRejectedValue(new Error("firestore down"));
    await expect(DELETE(req(), params)).rejects.toThrow("firestore down");
    expect(assets.deleteBrandAsset).not.toHaveBeenCalled();
    expect(store.deleteBrandAssetBytes).not.toHaveBeenCalled();
  });

  it("keeps the bytes when the second clear fails, so a raced style still shows its banner", async () => {
    control.clearTenantEmailStyleHeaderImage
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("firestore down"));
    await expect(DELETE(req(), params)).rejects.toThrow("firestore down");
    expect(assets.deleteBrandAsset).toHaveBeenCalledWith(admin, "hdr_1");
    expect(store.deleteBrandAssetBytes).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Icons and graphics only: an email header image belongs to Email style, whose own admin route
// takes it off the saved style before deleting it, so this route acts as if it isn't there.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const assets = vi.hoisted(() => ({
  getBrandAsset: vi.fn(),
  updateBrandAsset: vi.fn(),
  deleteBrandAsset: vi.fn(async () => {}),
}));
vi.mock("@/lib/admin/brandAssets", () => assets);
const store = vi.hoisted(() => ({ deleteBrandAssetBytes: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant/brandAssetStore", () => store);

const { PATCH, DELETE } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const member = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_member", role: "member" };
const row = (category: string) => ({
  id: "asset_1",
  tenantId: "ten_A",
  category,
  filename: FILE,
  mimeType: "image/png",
  title: "Spring banner",
  byteSize: 1000,
  createdAt: "2026-09-01T00:00:00.000Z",
});
const params = { params: Promise.resolve({ id: "asset_1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/assets/asset_1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_ASSETS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(member);
  assets.getBrandAsset.mockResolvedValue(row("icon"));
  assets.updateBrandAsset.mockImplementation(async (_ctx: unknown, _id: string, patch: object) => ({ ...row("icon"), ...patch }));
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/admin/brand-kit/assets/[id]", () => {
  it("renames an icon, as before", async () => {
    const res = await PATCH(req("PATCH", { title: "  Leaf  " }), params);
    expect(res.status).toBe(200);
    expect(assets.updateBrandAsset).toHaveBeenCalledWith(member, "asset_1", { title: "Leaf" });
    expect(await res.json()).toEqual({ asset: expect.objectContaining({ category: "icon", title: "Leaf" }) });
  });

  it("404s a header image, and an unknown id, writing nothing", async () => {
    assets.getBrandAsset.mockResolvedValue(row("header"));
    const res = await PATCH(req("PATCH", { title: "Renamed" }), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(assets.getBrandAsset).toHaveBeenCalledWith(member, "asset_1");

    assets.getBrandAsset.mockResolvedValue(null);
    expect((await PATCH(req("PATCH", { title: "Renamed" }), params)).status).toBe(404);
    expect(assets.updateBrandAsset).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/brand-kit/assets/[id]", () => {
  it("deletes a graphic's row and bytes, as before", async () => {
    assets.getBrandAsset.mockResolvedValue(row("graphic"));
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(assets.deleteBrandAsset).toHaveBeenCalledWith(member, "asset_1");
    expect(store.deleteBrandAssetBytes).toHaveBeenCalledWith("ten_A", "graphic", FILE);
  });

  it("404s a header image, deleting nothing (even for a member, the banner emails use stays)", async () => {
    assets.getBrandAsset.mockResolvedValue(row("header"));
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(assets.deleteBrandAsset).not.toHaveBeenCalled();
    expect(store.deleteBrandAssetBytes).not.toHaveBeenCalled();
  });
});

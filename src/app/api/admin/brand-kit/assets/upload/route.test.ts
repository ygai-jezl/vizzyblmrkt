import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Brand › Screenshots uploads: only with the image style on, PNG/JPEG only (sniffed), stored
// without metadata and with their pixel size. Icons and graphics are as before.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({
  storeBrandAsset: vi.fn(async (_t: string, _c: string, bytes: Buffer, mime: string) => ({ ok: true, filename: "f.png", mimeType: mime, size: bytes.length })),
  MAX_ASSET_BYTES: 8 * 1024 * 1024,
}));
vi.mock("@/lib/tenant/brandAssetStore", () => store);
const assets = vi.hoisted(() => ({
  recordBrandAsset: vi.fn(async (_s: unknown, row: Record<string, unknown>) => ({ id: "a1", ...row })),
  countBrandAssetsUpTo: vi.fn(async () => 0),
  MAX_ASSETS_PER_CATEGORY: 100,
}));
vi.mock("@/lib/admin/brandAssets", () => assets);

const { POST } = await import("./route");

// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
function req(category: string, bytes: Buffer, type: string): Request {
  const fd = new FormData();
  fd.append("category", category);
  fd.append("file", new File([new Uint8Array(bytes)], "screen.png", { type }));
  return new Request("http://localhost/api/admin/brand-kit/assets/upload", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_ASSETS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST brand asset upload: screenshots", () => {
  it("refuses screenshots while the image style is off", async () => {
    const res = await POST(req("screenshot", PNG, "image/png"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_category" });
    expect(store.storeBrandAsset).not.toHaveBeenCalled();
  });

  it("takes a PNG, recording its pixel size", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    const res = await POST(req("screenshot", PNG, "image/png"));
    expect(res.status).toBe(200);
    expect(assets.recordBrandAsset.mock.calls[0]![1]).toMatchObject({ category: "screenshot", width: 1, height: 1 });
  });

  it("refuses WebP, and a file that only claims to be a PNG", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect((await POST(req("screenshot", PNG, "image/webp"))).status).toBe(400);
    expect((await POST(req("screenshot", Buffer.from("not an image at all"), "image/png"))).status).toBe(400);
    expect(store.storeBrandAsset).not.toHaveBeenCalled();
  });

  it("graphics are as before (no pixel size)", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req("graphic", PNG, "image/png"));
    expect(assets.recordBrandAsset.mock.calls[0]![1]).not.toHaveProperty("width");
  });
});

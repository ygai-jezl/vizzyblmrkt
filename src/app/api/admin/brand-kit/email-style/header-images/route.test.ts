import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Uploading an email header image: Email style's admin gate, then the header-options flag;
// PNG/JPEG only (declared and sniffed), at most 1 MB and 1200 × 2400 read from the file itself,
// at most 20; stored without its metadata and recorded under `header` with that size.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const assets = vi.hoisted(() => ({ countBrandAssetsUpTo: vi.fn(), recordBrandAsset: vi.fn() }));
vi.mock("@/lib/admin/brandAssets", () => assets);
const store = vi.hoisted(() => ({ storeBrandAsset: vi.fn() }));
vi.mock("@/lib/tenant/brandAssetStore", () => store);

const { POST } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A PNG chunk: length, type, data and a made-up CRC (it isn't checked). */
const chunk = (type: string, data: number[] = []) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number, ...extra: number[][]) =>
  new Uint8Array([
    ...PNG_SIG,
    ...chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...extra.flat(),
    ...chunk("IDAT", [0x78, 0x9c]),
    ...chunk("IEND"),
  ]);
const SOF0 = (w: number, h: number) => [0xff, 0xc0, ...be16(11), 8, ...be16(h), ...be16(w), 1, 1, 0x11, 0];
const jpeg = (w: number, h: number, ...extra: number[][]) =>
  new Uint8Array([0xff, 0xd8, ...extra.flat(), ...SOF0(w, h), 0xff, 0xd9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

function req(file: Uint8Array | null, name = "Spring banner.png", type = "image/png") {
  const fd = new FormData();
  if (file) fd.append("file", new File([new Uint8Array(file)], name, { type }));
  return new Request("http://localhost/api/admin/brand-kit/email-style/header-images", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_STYLE_ENABLED", "true");
  vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  assets.countBrandAssetsUpTo.mockResolvedValue(3);
  assets.recordBrandAsset.mockImplementation(async (scope: { tenantId: string }, input: Record<string, unknown>) => ({
    id: "hdr_1",
    tenantId: scope.tenantId,
    createdAt: "2026-09-28T00:00:00.000Z",
    ...input,
  }));
  store.storeBrandAsset.mockImplementation(async (_t: string, _k: string, _b: Buffer, mimeType: string) => ({
    ok: true,
    filename: mimeType === "image/jpeg" ? FILE.replace(".png", ".jpg") : FILE,
    mimeType,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Nothing reached the store or the registry. */
function expectNothingStored() {
  expect(store.storeBrandAsset).not.toHaveBeenCalled();
  expect(assets.recordBrandAsset).not.toHaveBeenCalled();
}

describe("POST /api/admin/brand-kit/email-style/header-images", () => {
  it("503s with the Email style off, before sign-in", async () => {
    vi.stubEnv("EMAIL_STYLE_ENABLED", "");
    const res = await POST(req(png(1200, 300)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "email_style_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expectNothingStored();
  });

  it("503s with the header options off", async () => {
    vi.stubEnv("EMAIL_HEADER_OPTIONS_ENABLED", "false");
    const res = await POST(req(png(1200, 300)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "header_options_disabled" });
    expectNothingStored();
  });

  it("401s signed out and 403s for a member (uploading is admin-only)", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req(png(1200, 300)))).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    expect((await POST(req(png(1200, 300)))).status).toBe(403);
    expectNothingStored();
  });

  it("400s with no file or an empty one", async () => {
    expect((await POST(req(null))).status).toBe(400);
    expect((await POST(req(new Uint8Array()))).status).toBe(400);
    expectNothingStored();
  });

  it("413s over 1 MB", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(png(1200, 300));
    const res = await POST(req(big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "too_large",
      message: "The image is over 1 MB — try a smaller or simpler image.",
    });
    expectNothingStored();
  });

  it("400s a declared WebP or SVG, and a PNG whose bytes are WebP", async () => {
    for (const [bytes, name, type] of [
      [WEBP, "banner.webp", "image/webp"],
      [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "banner.svg", "image/svg+xml"],
      [WEBP, "banner.png", "image/png"],
    ] as const) {
      const res = await POST(req(bytes, name, type));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_type", message: "Upload a PNG or JPG — Outlook can't show WebP or SVG" });
    }
    expectNothingStored();
  });

  it("400s bad_type for a PNG whose header can't be read", async () => {
    const res = await POST(req(png(1200, 300).slice(0, 20)));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "bad_type",
      message: "We couldn't read this image — save it again as a PNG or JPG",
    });
    expectNothingStored();
  });

  it("400s bad_size for a small file declaring more than 1200 × 2400", async () => {
    for (const bytes of [png(1201, 10), png(10, 2401), jpeg(1201, 10)]) {
      const res = await POST(req(bytes));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "bad_size",
        message: "Header images can be at most 1200px wide and 2400px tall",
      });
    }
    expectNothingStored();
  });

  it("409s at 20 header images", async () => {
    assets.countBrandAssetsUpTo.mockResolvedValue(20);
    const res = await POST(req(png(1200, 300)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "limit_reached",
      message: "You can keep up to 20 header images. Delete one to add another.",
    });
    expect(assets.countBrandAssetsUpTo).toHaveBeenCalledWith(admin, "header", 21);
    expectNothingStored();
  });

  it("503s with no bucket, 502s when storing or recording fails", async () => {
    store.storeBrandAsset.mockResolvedValue({ ok: false, reason: "no_asset_bucket" });
    expect((await POST(req(png(1200, 300)))).status).toBe(503);
    store.storeBrandAsset.mockResolvedValue({ ok: false, reason: "store_failed" });
    expect((await POST(req(png(1200, 300)))).status).toBe(502);
    expect(assets.recordBrandAsset).not.toHaveBeenCalled();

    store.storeBrandAsset.mockResolvedValue({ ok: true, filename: FILE, mimeType: "image/png" });
    assets.recordBrandAsset.mockRejectedValue(new Error("firestore down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await POST(req(png(1200, 300)))).status).toBe(502);
  });

  it("stores and records under header, with the size read from the file and the name without its extension", async () => {
    const bytes = jpeg(1200, 300);
    const res = await POST(req(bytes, "C:\\banners\\Spring banner.jpg", "image/jpeg"));
    expect(res.status).toBe(200);

    expect(store.storeBrandAsset).toHaveBeenCalledWith("ten_A", "header", Buffer.from(bytes), "image/jpeg");
    const jpg = FILE.replace(".png", ".jpg");
    expect(assets.recordBrandAsset).toHaveBeenCalledWith(
      { tenantId: "ten_A", region: "us" },
      {
        category: "header",
        filename: jpg,
        mimeType: "image/jpeg",
        title: "Spring banner",
        byteSize: bytes.length,
        width: 1200,
        height: 300,
      },
    );
    expect(await res.json()).toEqual({
      image: {
        id: "hdr_1",
        title: "Spring banner",
        filename: jpg,
        mimeType: "image/jpeg",
        byteSize: bytes.length,
        width: 1200,
        height: 300,
        createdAt: "2026-09-28T00:00:00.000Z",
      },
    });
  });

  it("stores the image without its metadata, and records the size of what's stored", async () => {
    const exif = [...ascii("Exif"), 0, 0, ...ascii("MM GPS 51.5N")];
    const dirtyPng = png(
      1200,
      300,
      chunk("eXIf", ascii("MM GPS 51.5N")),
      chunk("tEXt", ascii("Author\0A. Person")),
      chunk("iTXt", ascii("XML:com.adobe.xmp\0<x:xmpmeta/>")),
    );
    const dirtyJpeg = jpeg(
      1200,
      300,
      [0xff, 0xe1, ...be16(exif.length + 2), ...exif],
      [0xff, 0xfe, ...be16(9), ...ascii("A phone")],
    );
    for (const [dirty, clean, name, type] of [
      [dirtyPng, png(1200, 300), "Spring banner.png", "image/png"],
      [dirtyJpeg, jpeg(1200, 300), "Spring banner.jpg", "image/jpeg"],
    ] as const) {
      vi.clearAllMocks();
      const res = await POST(req(dirty, name, type));
      expect(res.status).toBe(200);
      const stored = store.storeBrandAsset.mock.calls[0]![2] as Buffer;
      expect(stored).toEqual(Buffer.from(clean));
      for (const s of ["Exif", "eXIf", "GPS", "tEXt", "Author", "xmpmeta", "A phone"]) {
        expect(stored.includes(s)).toBe(false);
      }
      expect(assets.recordBrandAsset.mock.calls[0]![1]).toMatchObject({ byteSize: clean.length, width: 1200, height: 300 });
      expect((await res.json()).image).toMatchObject({ byteSize: clean.length });
    }
  });

  it("400s bad_type for a file that isn't a whole PNG or JPEG, so nothing is stored with metadata left in", async () => {
    // No IEND / EOI: the metadata can't be told from the image, so it isn't taken.
    for (const [bytes, type] of [
      [png(1200, 300).slice(0, -12), "image/png"],
      [jpeg(1200, 300).slice(0, -2), "image/jpeg"],
    ] as const) {
      const res = await POST(req(bytes, "banner", type));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "bad_type",
        message: "We couldn't read this image — save it again as a PNG or JPG",
      });
    }
    expectNothingStored();
  });

  it("names an upload with nothing left after the extension \"Header image\"", async () => {
    await POST(req(png(1200, 2400), ".png"));
    expect(assets.recordBrandAsset.mock.calls[0]![1]).toMatchObject({ title: "Header image", width: 1200, height: 2400 });
    await POST(req(png(600, 200), "  .png"));
    expect(assets.recordBrandAsset.mock.calls[1]![1]).toMatchObject({ title: "Header image" });
  });

  it("uploads anyway when the count can't be read (the cap is skipped)", async () => {
    assets.countBrandAssetsUpTo.mockRejectedValue(new Error("unavailable"));
    expect((await POST(req(png(1200, 300)))).status).toBe(200);
    expect(store.storeBrandAsset).toHaveBeenCalled();
  });
});

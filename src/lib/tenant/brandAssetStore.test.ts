import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store behind the public /api/brand-asset route: the key it builds and the filename check
// (no `/`, no `..`, image extensions only) are what keep that route on its own tenant's assets.
const gcs = vi.hoisted(() => {
  const download = vi.fn();
  const save = vi.fn();
  const remove = vi.fn();
  const file = vi.fn(() => ({ download, save, delete: remove }));
  const bucket = vi.fn(() => ({ file }));
  return { download, save, remove, file, bucket };
});
vi.mock("firebase-admin/app", () => ({
  // Non-empty → adminApp() returns the existing app and skips initializeApp.
  getApps: () => [{}],
  initializeApp: () => ({}),
  applicationDefault: () => ({}),
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket: gcs.bucket }) }));

const { readBrandAsset, deleteBrandAssetBytes, storeBrandAsset } = await import("./brandAssetStore");

const BUCKET = "example-email-assets";
const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const BAD_FILENAMES = ["../x.png", "a/b.png", "x.svg", "", ".png", `${FILE}/../y.png`];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_ASSET_BUCKET", BUCKET);
  gcs.download.mockResolvedValue([PNG]);
  gcs.save.mockResolvedValue(undefined);
  gcs.remove.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readBrandAsset", () => {
  it("reads brand/{tenant}/{category}s/{file} from the asset bucket, typed by extension", async () => {
    expect(await readBrandAsset("ten_A", "icon", FILE)).toEqual({ bytes: PNG, contentType: "image/png" });
    expect(gcs.bucket).toHaveBeenLastCalledWith(BUCKET);
    expect(gcs.file).toHaveBeenLastCalledWith(`brand/ten_A/icons/${FILE}`);

    const jpg = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
    expect(await readBrandAsset("ten_A", "graphic", jpg)).toEqual({ bytes: PNG, contentType: "image/jpeg" });
    expect(gcs.file).toHaveBeenLastCalledWith(`brand/ten_A/graphics/${jpg}`);
  });

  it("returns null for a filename that could leave the prefix or isn't an image, without touching storage", async () => {
    for (const filename of BAD_FILENAMES) {
      expect(await readBrandAsset("ten_A", "icon", filename)).toBeNull();
    }
    expect(gcs.bucket).not.toHaveBeenCalled();
    expect(gcs.file).not.toHaveBeenCalled();
    expect(gcs.download).not.toHaveBeenCalled();
  });

  it("returns null with no bucket, or when the download fails", async () => {
    vi.stubEnv("EMAIL_ASSET_BUCKET", "");
    expect(await readBrandAsset("ten_A", "icon", FILE)).toBeNull();
    expect(gcs.download).not.toHaveBeenCalled();

    vi.stubEnv("EMAIL_ASSET_BUCKET", BUCKET);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gcs.download.mockRejectedValueOnce(new Error("No such object"));
    expect(await readBrandAsset("ten_A", "icon", FILE)).toBeNull();
    warn.mockRestore();
  });
});

describe("deleteBrandAssetBytes", () => {
  it("deletes brand/{tenant}/{category}s/{file}", async () => {
    await deleteBrandAssetBytes("ten_A", "graphic", FILE);
    expect(gcs.bucket).toHaveBeenLastCalledWith(BUCKET);
    expect(gcs.file).toHaveBeenLastCalledWith(`brand/ten_A/graphics/${FILE}`);
    expect(gcs.remove).toHaveBeenCalledTimes(1);
  });

  it("refuses the same filenames, without touching storage", async () => {
    for (const filename of BAD_FILENAMES) {
      await deleteBrandAssetBytes("ten_A", "icon", filename);
    }
    expect(gcs.file).not.toHaveBeenCalled();
    expect(gcs.remove).not.toHaveBeenCalled();
  });
});

describe("storeBrandAsset", () => {
  it("saves under brand/{tenant}/{category}s/ with a uuid filename, the sniffed type and the immutable cache header", async () => {
    const res = await storeBrandAsset("ten_A", "icon", PNG, "image/png");

    expect(res).toEqual({ ok: true, filename: expect.stringMatching(/^[0-9a-f-]{36}\.png$/), mimeType: "image/png" });
    const { filename } = res as { filename: string };
    expect(gcs.file).toHaveBeenLastCalledWith(`brand/ten_A/icons/${filename}`);
    expect(gcs.save).toHaveBeenCalledWith(PNG, {
      contentType: "image/png",
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
  });
});

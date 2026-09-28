import { beforeEach, describe, expect, it, vi } from "vitest";

// The public, unauthenticated brand-asset route: the uuid filename is the credential.
const store = vi.hoisted(() => ({ readBrandAsset: vi.fn() }));
vi.mock("@/lib/tenant/brandAssetStore", () => store);

const { GET } = await import("./route");

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const get = (category: string, path: string[]) =>
  GET(new Request(`https://app.example.com/api/brand-asset/${category}/${path.join("/")}`), {
    params: Promise.resolve({ category, path }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  store.readBrandAsset.mockResolvedValue({ bytes: BYTES, contentType: "image/png" });
});

describe("GET /api/brand-asset/[category]/[...path]", () => {
  it("serves an icon or a graphic with its type, cached for a year and never sniffed", async () => {
    for (const category of ["icon", "graphic"]) {
      const res = await get(category, ["ten_A", FILE]);
      expect(res.status).toBe(200);
      expect(store.readBrandAsset).toHaveBeenLastCalledWith("ten_A", category, FILE);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Content-Length")).toBe(String(BYTES.length));
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    }
  });

  it("404s an unknown category, the wrong number of segments or a bad tenant segment, without reading", async () => {
    const cases: [string, string[]][] = [
      ["logo", ["ten_A", FILE]],
      ["icons", ["ten_A", FILE]],
      ["icon", [FILE]],
      ["icon", ["ten_A", "icons", FILE]],
      ["icon", ["", FILE]],
      ["icon", ["ten_A", ""]],
      ["icon", ["ten.A", FILE]],
      ["icon", ["..", FILE]],
    ];
    for (const [category, path] of cases) {
      expect((await get(category, path)).status).toBe(404);
    }
    expect(store.readBrandAsset).not.toHaveBeenCalled();
  });

  it("404s a file that isn't there", async () => {
    store.readBrandAsset.mockResolvedValue(null);
    expect((await get("graphic", ["ten_A", FILE])).status).toBe(404);
  });

  // Pinned: header images aren't a brand-asset category yet.
  it("404s header today, without reading", async () => {
    expect((await get("header", ["ten_A", FILE])).status).toBe(404);
    expect(store.readBrandAsset).not.toHaveBeenCalled();
  });
});

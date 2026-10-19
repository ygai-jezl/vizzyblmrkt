import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The TTF copy of a WOFF2 is stored beside it under the same uuid, and only real TTF/OTF bytes.
const saved = vi.hoisted(() => ({ keys: [] as string[], fail: false }));
vi.mock("firebase-admin/app", () => ({ getApps: () => [{}], initializeApp: vi.fn(), applicationDefault: vi.fn() }));
vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (key: string) => ({
        save: async () => {
          if (saved.fail) throw new Error("down");
          saved.keys.push(key);
        },
      }),
    }),
  }),
}));

const { storeDerivedBrandFont } = await import("./brandFontStore");
const TTF = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(16)]);

beforeEach(() => {
  saved.keys = [];
  saved.fail = false;
  vi.stubEnv("EMAIL_ASSET_BUCKET", "bucket");
});
afterEach(() => vi.unstubAllEnvs());

describe("storeDerivedBrandFont", () => {
  it("stores the TTF beside the WOFF2 under the same uuid", async () => {
    expect(await storeDerivedBrandFont("ten_A", "a1b2.woff2", TTF)).toBe("a1b2.ttf");
    expect(saved.keys).toEqual(["brand/ten_A/fonts/a1b2.ttf"]);
  });

  it("refuses bytes that aren't TTF/OTF, a bad source name, and reports a failed save", async () => {
    expect(await storeDerivedBrandFont("ten_A", "a1b2.woff2", Buffer.from("wOF2xxxxxxxx"))).toBeNull();
    expect(await storeDerivedBrandFont("ten_A", "../x.woff2", TTF)).toBeNull();
    saved.fail = true;
    expect(await storeDerivedBrandFont("ten_A", "a1b2.woff2", TTF)).toBeNull();
    expect(saved.keys).toEqual([]);
  });
});

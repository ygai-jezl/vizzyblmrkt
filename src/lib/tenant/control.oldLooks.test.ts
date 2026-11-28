import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { clearOldLooks } from "./control";

/** Clearing a forgotten look's old copy on the brand record (learning loops step 4, Forget). */

function seeded(): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_hearth", {
    tenantName: "Hearth Bakery",
    rootDomain: "hearth.example.com",
    status: "active",
    region: "us",
    allowedOrigins: [],
    ownerId: "usr_maya",
    brandKit: { logoUrl: "https://cdn.example.com/logo.png", learnedImageStyle: "Warm light.", learnedImageStyleUpdatedAt: "2026-12-01T09:00:00.000Z", learnedImageStyleSampleCount: 4 },
    imageStyle: {
      defaultStyleId: "natural_photo",
      learned: {
        natural_photo: { directive: "Overhead daylight.", sampleCount: 3, updatedAt: "2026-12-02T09:00:00.000Z" },
        soft_3d: { directive: "Pastel clay.", sampleCount: 3, updatedAt: "2026-12-20T09:00:00.000Z" },
      },
    },
  });
  return db;
}

describe("clearOldLooks", () => {
  it("clears the brand look and the named styles written before the Forget, and nothing else", async () => {
    const db = seeded();
    expect(await clearOldLooks("ten_hearth", { brand: true, styleKeys: ["natural_photo", "soft_3d"], writtenBy: "2026-12-10T09:00:00.000Z" }, db)).toBe(2);
    const t = db.raw("tenants", "ten_hearth") as { brandKit: Record<string, unknown>; imageStyle: { defaultStyleId: string; learned: Record<string, unknown> } };
    expect(t.brandKit).toEqual({ logoUrl: "https://cdn.example.com/logo.png" });
    // Soft 3D's look was written after the Forget, so it stays.
    expect(Object.keys(t.imageStyle.learned)).toEqual(["soft_3d"]);
    expect(t.imageStyle.defaultStyleId).toBe("natural_photo");
    // Nothing left to clear: no write.
    expect(await clearOldLooks("ten_hearth", { brand: true, styleKeys: ["natural_photo"], writtenBy: "2026-12-10T09:00:00.000Z" }, db)).toBe(0);
    expect(await clearOldLooks("ten_missing", { brand: true, writtenBy: "2026-12-10T09:00:00.000Z" }, db)).toBe(0);
  });
});

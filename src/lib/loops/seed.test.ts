import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBrandPointers, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandPointers } from "@/lib/types/loopDay";
import type { Tenant } from "@/lib/types/tenant";
import { learnedFor } from "./read";
import { legacyLooksOf, seedBrand } from "./seed";

/** The seed (learning loops step 4, 3.7 of the plan for steps 4 and 5). */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "system" };
const NOW = new Date("2026-12-01T09:00:00.000Z");
const BRAND = "Warm natural light, rustic wood and linen, honest close ups of bread.";
const NATURAL = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";

const tenant = (over: Partial<Tenant> = {}) =>
  ({
    brandKit: { learnedImageStyle: BRAND },
    imageStyle: {
      defaultStyleId: "natural_photo",
      learned: {
        natural_photo: { directive: NATURAL, sampleCount: 5, updatedAt: "2026-11-20T09:00:00.000Z" },
        // A drawn style never learns, so whatever is stored under it is never carried.
        headline_card: { directive: "Bold type.", sampleCount: 2, updatedAt: "2026-11-20T09:00:00.000Z" },
        soft_3d: { directive: "See https://example.com for the look.", sampleCount: 3, updatedAt: "2026-11-20T09:00:00.000Z" },
      },
    },
    ...over,
  }) as unknown as Tenant;

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}
beforeEach(versionsOn);
afterEach(() => vi.unstubAllEnvs());

describe("legacyLooksOf", () => {
  it("reads the brand look and each painted style's look by scope, and nothing for a drawn style", () => {
    expect(legacyLooksOf(tenant())).toEqual({
      "image_style.brand": BRAND,
      "image_style.natural_photo": NATURAL,
      "image_style.soft_3d": "See https://example.com for the look.",
    });
    expect(legacyLooksOf(null)).toEqual({});
    expect(legacyLooksOf(tenant({ brandKit: { learnedImageStyle: "  " } as Tenant["brandKit"], imageStyle: undefined }))).toEqual({});
  });
});

describe("seedBrand", () => {
  it("copies each look into version 1 of its scope with seededAt, in the brand's own region, once", async () => {
    const db = new FakeFirestore();
    const r = await seedBrand(hearth, tenant(), { db, now: NOW });
    expect(r).toEqual({ ok: true, seeded: true, scopes: ["image_style.natural_photo", "image_style.brand"], refused: ["image_style.soft_3d"] });

    const pointers = await readBrandPointers(hearth, db);
    expect(pointers.seededAt).toBe(NOW.toISOString());
    expect(pointers.scopes).toEqual({
      "image_style.natural_photo": { v: 1, setBy: "seeded", adoptedAt: NOW.toISOString() },
      "image_style.brand": { v: 1, setBy: "seeded", adoptedAt: NOW.toISOString() },
    });
    const v1 = await getPatternVersion(hearth, "image_style.natural_photo", 1, db);
    expect(v1).toMatchObject({ createdBy: "seed", setBy: "seeded", loop: "image_style", items: [{ id: "look1", type: "rule", text: NATURAL, from: "seed" }] });
    // A look the text check refuses is never carried over.
    expect(await getPatternVersion(hearth, "image_style.soft_3d", 1, db)).toBeNull();

    // A second seed writes nothing.
    expect(await seedBrand(hearth, tenant({ brandKit: { learnedImageStyle: "Something else." } as Tenant["brandKit"] }), { db, now: NOW })).toEqual({
      ok: true,
      seeded: false,
      why: "already",
    });
    expect((await getPatternVersion(hearth, "image_style.brand", 1, db))?.items?.[0]?.text).toBe(BRAND);
  });

  it("seeds a brand with nothing to carry over, so learning can start", async () => {
    const db = new FakeFirestore();
    expect(await seedBrand(lumen, null, { db, now: NOW })).toMatchObject({ ok: true, seeded: true, scopes: [] });
    expect(await readBrandPointers(lumen, db)).toMatchObject({ scopes: {}, seededAt: NOW.toISOString() });
  });

  it("does nothing with image style versions off", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    const db = new FakeFirestore();
    expect(await seedBrand(hearth, tenant(), { db, now: NOW })).toEqual({ ok: true, seeded: false, why: "switch" });
    expect((await readBrandPointers(hearth, db)).seededAt).toBeUndefined();
  });

  it("keeps a pause and the opt out already on the pointers", async () => {
    const db = new FakeFirestore();
    await runLoopsTransaction(
      hearth,
      async (txn) => writeBrandPointersTx(txn, hearth, { scopes: {}, fleetOptOut: { at: "2026-11-30T09:00:00.000Z" } } as BrandPointers, db),
      db,
    );
    await seedBrand(hearth, tenant(), { db, now: NOW });
    expect(await readBrandPointers(hearth, db)).toMatchObject({ fleetOptOut: { at: "2026-11-30T09:00:00.000Z" }, seededAt: NOW.toISOString() });
  });

  it("is what learnedFor reads from then on: the seeded look, no longer the old field", async () => {
    const db = new FakeFirestore();
    const before = await learnedFor(hearth, "post_image", { scope: "image_style.natural_photo", legacy: "the old field" }, { db, now: NOW });
    expect(before.block.look).toBe("the old field");
    expect(before.stamp).toMatchObject({ arm: "none", sources: ["legacy"] });
    await seedBrand(hearth, tenant(), { db, now: NOW });
    const after = await learnedFor(hearth, "post_image", { scope: "image_style.natural_photo", legacy: "the old field" }, { db, now: NOW });
    expect(after.block.look).toBe(NATURAL);
    expect(after.stamp).toMatchObject({ scope: "image_style.natural_photo", v: 1, arm: "learned" });
  });
});

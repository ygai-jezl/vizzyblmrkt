import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiUsage, usageThisMonth, usedThisMonth } from "@/lib/plans/meter";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { LoopStamp } from "@/lib/types/loopStamp";
import type { Tenant } from "@/lib/types/tenant";
import { REMAKE_HOLD_MS, readRemake, recordRemake, withinOutcomeDays } from "./remake";
import { sumWeek } from "./testing/sumWeek";

/**
 * Remakes and the allowance rule (src/lib/loops/remake.ts, learning loops step 4, decisions 3 and
 * 12 of the plan for steps 4 and 5). Hearth Bakery makes a post image again in the same place.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const MADE = "2027-01-08T10:00:00.000Z";
const NATURAL = "image_style.natural_photo";

const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`it touched the database (${String(p)})`); } }) as FirestoreLike;

const stampOn = (arm: "learned" | "holdback"): LoopStamp => ({
  made: `m1.image_style.natural_photo.1.${arm === "learned" ? "l" : "h"}`,
  kind: "post_image",
  scope: NATURAL,
  v: 1,
  arm,
  items: arm === "learned" ? ["look1"] : [],
  prompt: null,
  tokens: { rules: arm === "learned" ? 24 : 0, examples: 0 },
  at: MADE,
});

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

function withImage(over: Partial<ImageAsset> = {}) {
  const db = new FakeFirestore();
  const doc: Omit<ImageAsset, "id"> = {
    tenantId: "ten_hearth",
    workspaceId: "ws_hearth",
    filename: "loaf.png",
    mimeType: "image/png",
    kind: "social",
    style: "natural_photo",
    createdAt: MADE,
    made: stampOn("learned"),
    ...over,
  };
  db.seed("image_assets", "img_loaf", doc);
  // Another brand's image under the same filename is never read.
  db.seed("image_assets", "img_theirs", { ...doc, tenantId: "ten_lumen" });
  return db;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("with versions off", () => {
  it("is never a remake, with no read, and the new image is metered under its own kind", async () => {
    expect(await readRemake(hearth, "post_image", "loaf.png", { db: untouchable, now: NOW })).toEqual({ kind: "post_image", earlier: null, counts: false, purpose: "post_image" });
  });
});

describe("with versions on", () => {
  beforeEach(versionsOn);

  it("reads the earlier image by filename, and counts its first remake within 14 days once", async () => {
    const db = withImage();
    const remake = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    expect([remake.earlier?.id, remake.counts, remake.purpose]).toEqual(["img_loaf", true, "post_image"]);

    expect(await recordRemake(hearth, remake, "img_loaf2", { db, now: NOW })).toBe(true);
    expect(db.raw("image_assets", "img_loaf")).toMatchObject({ remadeAt: NOW.toISOString(), remadeBy: "img_loaf2" });
    expect(sumWeek(db, "ten_hearth", "2027-W02")).toEqual({ c: { [NATURAL]: { post_image: { v1: { learned: { remade: 1 } } } } } });

    // The same remake told twice, or a later one, counts nothing more.
    expect(await recordRemake(hearth, remake, "img_loaf3", { db, now: NOW })).toBe(false);
    const again = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    expect([again.counts, again.purpose]).toEqual([false, "post_image"]);
    expect(await recordRemake(hearth, again, "img_loaf3", { db, now: NOW })).toBe(false);
    expect(sumWeek(db, "ten_hearth", "2027-W02")).toEqual({ c: { [NATURAL]: { post_image: { v1: { learned: { remade: 1 } } } } } });
    expect(db.raw("image_assets", "img_theirs")?.remadeAt).toBeUndefined();
  });

  it("counts no remake after 14 days, of no earlier image, or of a kind that never counts one", async () => {
    const db = withImage();
    const late = await readRemake(hearth, "post_image", "loaf.png", { db, now: new Date("2027-01-23T10:00:01.000Z") });
    expect([late.earlier?.id, late.counts]).toEqual(["img_loaf", false]);
    expect(await recordRemake(hearth, late, "img_loaf2", { db })).toBe(false);
    expect(db.raw("image_assets", "img_loaf")?.remadeAt).toBeUndefined();

    expect((await readRemake(hearth, "blog_hero", "hero.png", { db, now: NOW })).earlier).toBeNull();
    expect((await readRemake(hearth, "blog_hero", null, { db: untouchable, now: NOW })).earlier).toBeNull();
    // Email images, email heroes and carousels never count remakes.
    expect(await readRemake(hearth, "email_hero" as never, "loaf.png", { db: untouchable, now: NOW })).toMatchObject({ earlier: null, counts: false });

    expect(withinOutcomeDays(MADE, new Date("2027-01-22T10:00:00.000Z"))).toBe(true);
    expect(withinOutcomeDays(MADE, new Date("2027-01-07T10:00:00.000Z"))).toBe(false);
    expect(withinOutcomeDays("not a date", NOW)).toBe(false);
  });

  it("lets only one of two remakes at once count", async () => {
    const db = withImage();
    const remake = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    const results = await Promise.all([recordRemake(hearth, remake, "img_a", { db, now: NOW }), recordRemake(hearth, remake, "img_b", { db, now: NOW })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sumWeek(db, "ten_hearth", "2027-W02")).toEqual({ c: { [NATURAL]: { post_image: { v1: { learned: { remade: 1 } } } } } });
  });

  it("never fails the image it was asked about", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    expect(await readRemake(hearth, "post_image", "loaf.png", { db: broken, now: NOW })).toMatchObject({ earlier: null, purpose: "post_image" });
    const db = withImage();
    const remake = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    expect(await recordRemake(hearth, remake, "img_loaf2", { db: broken, now: NOW })).toBe(false);
  });
});

describe("the allowance rule (decision 3)", () => {
  beforeEach(() => {
    versionsOn();
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("meters the first remake of a held back image under loop_learn, off the image allowance; a second remake counts as usual", async () => {
    const db = withImage({ made: stampOn("holdback") });
    const capped = { id: "ten_hearth", featureLimits: { images: 3 } } as unknown as Tenant;
    const deps = { db, now: () => NOW, tenant: capped };
    await aiUsage(hearth, "post_image", deps).recordImages(1);
    await aiUsage(hearth, "post_image", deps).recordImages(1);
    await aiUsage(hearth, "post_image", deps).recordImages(1);
    expect(await usedThisMonth(hearth, "images", deps)).toBe(3);

    // Hearth is at its cap of 3, and remakes the held back image: it is made, and not counted against the cap.
    const first = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    expect(first.purpose).toBe("loop_learn");
    const usage = aiUsage(hearth, first.purpose, deps);
    expect(await usage.check("images")).toBeNull();
    await usage.recordImages(1);
    expect(await recordRemake(hearth, first, "img_loaf2", { db, now: NOW })).toBe(true);
    expect(await usedThisMonth(hearth, "images", deps)).toBe(3);
    expect((await usageThisMonth(hearth, deps)).images).toMatchObject({ total: 4, byPurpose: { post_image: 3, loop_learn: 1 } });
    expect(sumWeek(db, "ten_hearth", "2027-W02")).toEqual({ c: { [NATURAL]: { post_image: { v1: { holdback: { remade: 1 } } } } } });

    // Made again in the same place: the image was remade already, so this one is the brand's own.
    const second = await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW });
    expect(second.purpose).toBe("post_image");
    expect(await aiUsage(hearth, second.purpose, deps).check("images")).toEqual({ limited: true, used: 3, limit: 3 });
  });

  it("makes only one of several remakes at once of a held back image free, and lets the free one go after a while when its image failed", async () => {
    const db = withImage({ made: stampOn("holdback") });
    const at = await Promise.all([1, 2, 3].map(() => readRemake(hearth, "post_image", "loaf.png", { db, now: NOW })));
    expect(at.map((r) => r.purpose).sort()).toEqual(["loop_learn", "post_image", "post_image"]);
    expect(at.every((r) => r.counts)).toBe(true);
    // The one that reserved it failed and never recorded: a minute on it is still held, later it is free again.
    expect((await readRemake(hearth, "post_image", "loaf.png", { db, now: new Date(NOW.getTime() + 60_000) })).purpose).toBe("post_image");
    const after = new Date(NOW.getTime() + REMAKE_HOLD_MS + 1);
    const again = await readRemake(hearth, "post_image", "loaf.png", { db, now: after });
    expect(again.purpose).toBe("loop_learn");
    // Recorded: the image is remade once, and the reservation goes.
    expect(await recordRemake(hearth, again, "img_loaf2", { db, now: after })).toBe(true);
    expect(db.raw("image_assets", "img_loaf")).toMatchObject({ remadeAt: after.toISOString(), remadeBy: "img_loaf2", remakeClaimAt: null });
    expect((await readRemake(hearth, "post_image", "loaf.png", { db, now: after })).purpose).toBe("post_image");
  });

  it("meters a remake of an image on the learned look, or of a held back one after 14 days, as usual", async () => {
    expect((await readRemake(hearth, "post_image", "loaf.png", { db: withImage(), now: NOW })).purpose).toBe("post_image");
    const late = await readRemake(hearth, "post_image", "loaf.png", { db: withImage({ made: stampOn("holdback") }), now: new Date("2027-02-01T10:00:00.000Z") });
    expect(late.purpose).toBe("post_image");
  });
});

describe("the earlier image's row", () => {
  it("is read only through the brand's own collection", async () => {
    versionsOn();
    const db = new FakeFirestore();
    db.seed("image_assets", "img_theirs", { tenantId: "ten_lumen", workspaceId: "ws", filename: "loaf.png", mimeType: "image/png", kind: "social", createdAt: MADE });
    expect((await readRemake(hearth, "post_image", "loaf.png", { db, now: NOW })).earlier).toBeNull();
    expect(await forTenant(hearth, db).imageAssets.getById("img_theirs")).toBeNull();
  });
});

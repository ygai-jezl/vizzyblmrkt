import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { Tenant } from "@/lib/types/tenant";
import { updateBlogHero } from "@/lib/tenant/workspaceContent";
import { isHeldBack } from "@/lib/loops/read";
import { seedBrand } from "@/lib/loops/seed";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { samplePlan } from "./testing/samplePlan";

// The blog hero with image style versions on (learning loops step 4, 3.6): it reads what was
// learned for its style, is held back about 1 in 20, stamps its row and counts it where it is
// saved, and Make again marks the hero before it remade.
const ids = vi.hoisted(() => ({ next: "hero-0" }));
vi.mock("@/lib/admin/brandKit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/brandKit")>()),
  newImageAssetId: () => ids.next,
}));

const { makeBlogHero } = await import("./hero");
type HeroDeps = import("./hero").HeroDeps;

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken", userId: "u_maya", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const T0 = Date.parse("2027-01-15T10:00:00.000Z");
const WEEK = "2027-W02";
const NATURAL = "image_style.natural_photo";
const LOOK = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";
const tenant = { id: "ten_hearth", tenantName: "Hearth Bakery", imageStyle: { defaultStyleId: "natural_photo", learned: { natural_photo: { directive: LOOK, sampleCount: 5, updatedAt: "t" } } } } as unknown as Tenant;

/** Ids the holdback's hash keeps or holds back for Natural photo. */
const kept = Array.from({ length: 60 }, (_, i) => `hero-${i}`).filter((id) => !isHeldBack(NATURAL, id));
const heldBack = Array.from({ length: 200 }, (_, i) => `hero-${i}`).find((id) => isHeldBack(NATURAL, id))!;

function setup(over: Partial<HeroDeps> = {}) {
  const db = new FakeFirestore();
  db.seed(PLANS, "plan_1", samplePlan({ tenantId: "ten_hearth" }));
  let clock = T0;
  let stored = 0;
  const deps: HeroDeps = {
    now: () => clock,
    render: vi.fn(async (r) => ({ png: Buffer.from(`${r.template}:${r.size}`), width: 1600, height: 900 })),
    brief: vi.fn(async () => "Loaves on a floured board at dawn"),
    paint: vi.fn(async () => ({ bytes: Buffer.from("art"), mimeType: "image/png" })),
    alt: vi.fn(async () => "Loaves on a floured board"),
    store: vi.fn(async () => ({ ok: true as const, filename: `f${++stored}.png` })),
    // The library row, kept in the fake database so a later Make again can find it.
    record: vi.fn(async (scope, input) => {
      const row = { ...input, tenantId: scope.tenantId, createdAt: new Date(clock).toISOString() };
      delete (row as { id?: string }).id;
      await forTenant({ ...scope, source: "system" }, db).imageAssets.create(input.id!, row as Omit<ImageAsset, "id" | "tenantId">);
      return { id: input.id } as ImageAsset;
    }),
    update: (c, w, p, n, next) => updateBlogHero(c, w, p, n, next, db),
    chart: vi.fn(async () => null),
    scene: vi.fn(async () => ({ bytes: Buffer.from("scene"), mimeType: "image/png" })),
    db,
    ...over,
  };
  return { db, deps, tick: (ms: number) => (clock += ms) };
}

const input = (over: Record<string, unknown> = {}) => ({
  ctx: hearth,
  tenant,
  workspaceId: "ws1",
  planId: "plan_1",
  nodeId: "hub",
  budgetMs: 140_000,
  retry: true,
  brandContextFor: (learned: string | null | undefined) => `brand context; look: ${learned ?? "none"}`,
  ...over,
});
const recordedMade = (deps: HeroDeps) => vi.mocked(deps.record).mock.calls.at(-1)![1].made;

beforeEach(() => {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("makeBlogHero with image style versions on", () => {
  it("before the seed, uses the old look, stamped legacy", async () => {
    const { deps } = setup();
    ids.next = kept[0]!;
    await makeBlogHero(input(), deps);
    expect(vi.mocked(deps.brief).mock.calls[0]![0]).toContain(`look: ${LOOK}`);
    expect(recordedMade(deps)).toMatchObject({ kind: "blog_hero", scope: NATURAL, v: 0, arm: "none", sources: ["legacy"] });
  });

  it("reads its style's look from versions, stamps its row learned and counts it made", async () => {
    const { db, deps } = setup();
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    ids.next = kept[0]!;
    const r = await makeBlogHero(input(), deps);
    expect(r.ok).toBe(true);
    expect(vi.mocked(deps.brief).mock.calls[0]![0]).toContain(`look: ${LOOK}`);
    expect(vi.mocked(deps.record).mock.calls[0]![1]).toMatchObject({ id: kept[0], made: { scope: NATURAL, v: 1, arm: "learned", items: ["look1"] } });
    expect(sumWeek(db, "ten_hearth", WEEK)).toMatchObject({ c: { [NATURAL]: { blog_hero: { v1: { learned: { made: 1 } } } } }, t: { image_asset: { made: 1 } } });
  });

  it("counts its stamp lost when the image row can't be written but the hero still goes on the article", async () => {
    const { db, deps } = setup({ record: vi.fn(async () => Promise.reject(new Error("down"))) });
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    ids.next = kept[0]!;
    const r = await makeBlogHero(input(), deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.hero).toMatchObject({ assetId: null, heroRef: expect.any(String) });
    expect(sumWeek(db, "ten_hearth", WEEK)).toMatchObject({
      c: { [NATURAL]: { blog_hero: { v1: { learned: { made: 1 } } } } },
      u: { blog_hero: { stamp_lost: 1 } },
    });
  });

  it("held back: the look stays out of the brief and the row says so", async () => {
    const { db, deps } = setup();
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    ids.next = heldBack;
    await makeBlogHero(input(), deps);
    expect(vi.mocked(deps.brief).mock.calls[0]![0]).toContain("look: none");
    expect(recordedMade(deps)).toMatchObject({ scope: NATURAL, v: 1, arm: "holdback", items: [] });
  });

  it("the title card after painting failed is arm none with fallback_drawn", async () => {
    const { db, deps } = setup({ paint: vi.fn(async () => null) });
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    ids.next = kept[0]!;
    await makeBlogHero(input(), deps);
    expect(recordedMade(deps)).toMatchObject({ arm: "none", sources: ["fallback_drawn"] });
  });

  it("Make again within 14 days marks the hero before it remade, once", async () => {
    const { db, deps, tick } = setup();
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    ids.next = kept[0]!;
    await makeBlogHero(input(), deps);
    tick(200_000);
    ids.next = kept[1]!;
    await makeBlogHero(input(), deps);
    expect(db.raw("image_assets", kept[0]!)).toMatchObject({ remadeBy: kept[1] });
    tick(200_000);
    ids.next = kept[2]!;
    await makeBlogHero(input(), deps);
    expect(db.raw("image_assets", kept[1]!)).toMatchObject({ remadeBy: kept[2] });
    expect(sumWeek(db, "ten_hearth", WEEK)).toMatchObject({ c: { [NATURAL]: { blog_hero: { v1: { learned: { made: 3, remade: 2 } } } } } });
  });

  it("a format draws a card and never learns: arm none, and never held back", async () => {
    const { db, deps } = setup();
    await seedBrand(hearth, tenant, { db, now: new Date(T0) });
    vi.stubEnv("IMAGE_FORMATS_ENABLED", "true");
    ids.next = heldBack;
    await makeBlogHero(input({ format: "report_cover" }), deps);
    expect(vi.mocked(deps.scene).mock.calls[0]![0].brandContext).toContain(`look: ${LOOK}`);
    expect(recordedMade(deps)).toMatchObject({ arm: "none", made: "m1.image_style.natural_photo.1.n" });
  });
});

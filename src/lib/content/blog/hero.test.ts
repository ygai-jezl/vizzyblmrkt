import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { BlogArticleMetaSchema, ContentPlanSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { updateBlogHero, updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { cleanAlt, heroFromUpload, heroTitle, makeBlogHero, setHeroAlt, type HeroDeps } from "./hero";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const ids = { workspaceId: "ws1", planId: "plan_1", nodeId: "hub" };
const T0 = Date.parse("2026-10-19T10:00:00.000Z");
const png = (tag: string) => ({ png: Buffer.from(tag), width: 1600, height: 900 });

function setup(over: Partial<HeroDeps> = {}, plan: ContentPlan = samplePlan()) {
  const db = new FakeFirestore();
  db.seed(PLANS, plan.id, plan);
  let clock = T0;
  let stored = 0;
  const deps: HeroDeps = {
    now: () => clock,
    render: vi.fn(async (r) => png(`${r.template}:${r.size}`)),
    brief: vi.fn(async () => "A lighthouse over a calm sea"),
    paint: vi.fn(async () => ({ bytes: Buffer.from("art"), mimeType: "image/png" })),
    alt: vi.fn(async () => "A lighthouse beam crossing a dark sea — at dusk."),
    store: vi.fn(async () => ({ ok: true as const, filename: `f${++stored}.png` })),
    record: vi.fn(async () => ({ id: "asset_1" }) as never),
    update: (c, w, p, n, next) => updateBlogHero(c, w, p, n, next, db),
    ...over,
  };
  const tick = (ms: number) => (clock += ms);
  const hero = () => ContentPlanSchema.parse(db.raw(PLANS, "plan_1")).graph.nodes[0]!.blog?.hero;
  return { db, deps, tick, hero };
}

const tenant = (imageStyle?: Tenant["imageStyle"]) => ({ id: "ten_A", tenantName: "Acme", rootDomain: "acme.example", imageStyle }) as Tenant;
const input = (t: Tenant | null, over: Record<string, unknown> = {}) => ({ ctx, tenant: t, ...ids, budgetMs: 140_000, retry: true, ...over });

beforeEach(() => {
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("makeBlogHero", () => {
  it("before the brand picks, draws a Headline card hero and share card", async () => {
    const { deps, hero } = setup();
    const r = await makeBlogHero(input(tenant()), deps);
    expect(r.ok).toBe(true);
    expect((deps.render as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[0].template}:${c[0].size}`)).toEqual(["headline_card:hero", "headline_card:share"]);
    expect(deps.paint).not.toHaveBeenCalled();
    expect(hero()).toMatchObject({
      status: "ready",
      styleId: "headline_card",
      heroRef: "f1.png",
      shareRef: "f2.png",
      alt: heroTitle(sampleHub()),
      forTitle: heroTitle(sampleHub()),
      assetId: "asset_1",
    });
  });

  it("a painted style: picture brief, Nano Banana, art cropped to the hero, title over the share card", async () => {
    const { deps, hero } = setup();
    await makeBlogHero(input(tenant({ defaultStyleId: "soft_3d" })), deps);
    expect(deps.paint).toHaveBeenCalledWith("A lighthouse over a calm sea", 40_000);
    const calls = (deps.render as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ template: "art_overlay", size: "hero", showHeadline: false, showLogo: false });
    expect(calls[1]).toMatchObject({ template: "art_overlay", size: "share", headline: heroTitle(sampleHub()) });
    expect(hero()).toMatchObject({ status: "ready", styleId: "soft_3d", prompt: "A lighthouse over a calm sea", attempts: 1, alt: "A lighthouse beam crossing a dark sea, at dusk." });
  });

  it("the article's own pick wins, is kept for next time, and \"brand\" (null) clears it", async () => {
    const { deps, hero, tick } = setup();
    await makeBlogHero(input(tenant({ defaultStyleId: "soft_3d" }), { styleOverride: "headline_card" }), deps);
    expect(hero()).toMatchObject({ styleId: "headline_card", styleOverride: "headline_card" });
    tick(200_000);
    await makeBlogHero(input(tenant({ defaultStyleId: "soft_3d" })), deps);
    expect(hero()).toMatchObject({ styleId: "headline_card" });
    tick(200_000);
    await makeBlogHero(input(tenant({ defaultStyleId: "soft_3d" }), { styleOverride: null }), deps);
    expect(hero()).toMatchObject({ styleId: "soft_3d", styleOverride: null });
  });

  it("tries the model twice, then falls back to the title card", async () => {
    const { deps, hero } = setup({ paint: vi.fn(async () => null) });
    const r = await makeBlogHero(input(tenant({ defaultStyleId: "natural_photo" })), deps);
    expect(r.ok).toBe(true);
    expect(deps.paint).toHaveBeenCalledTimes(2);
    expect(hero()).toMatchObject({ status: "fallback", styleId: "title_card", attempts: 2, heroRef: "f1.png" });
  });

  it("no retry when it isn't allowed, or when the time left is too short", async () => {
    const a = setup({ paint: vi.fn(async () => null) });
    await makeBlogHero(input(tenant({ defaultStyleId: "natural_photo" }), { retry: false }), a.deps);
    expect(a.deps.paint).toHaveBeenCalledTimes(1);
    const b = setup({ paint: vi.fn(async () => null) });
    await makeBlogHero(input(tenant({ defaultStyleId: "natural_photo" }), { budgetMs: 18_000 }), b.deps);
    expect(b.deps.paint).not.toHaveBeenCalled();
    expect(b.hero()).toMatchObject({ status: "fallback" });
  });

  it("one run at a time: a second within 150 s is told it's running; an old lease is taken over", async () => {
    const { deps } = setup();
    let second: Awaited<ReturnType<typeof makeBlogHero>> | null = null;
    const slow: HeroDeps = {
      ...deps,
      render: vi.fn(async (r) => {
        if (!second) second = await makeBlogHero(input(tenant()), deps);
        return png(`${r.template}`);
      }),
    };
    await makeBlogHero(input(tenant()), slow);
    expect(second).toEqual({ ok: false, status: 409, error: "hero_running" });

    // A run that died mid-way leaves a pending hero; after the lease it can be made again.
    const d = setup();
    await d.deps.update(ctx, "ws1", "plan_1", "hub", () => ({ status: "pending", startedAt: new Date(T0).toISOString() }) as never);
    expect(await makeBlogHero(input(tenant()), d.deps)).toMatchObject({ ok: false, error: "hero_running" });
    d.tick(151_000);
    expect(await makeBlogHero(input(tenant()), d.deps)).toMatchObject({ ok: true });
  });

  it("a storage failure is `failed`, and the last good image stays", async () => {
    const { deps, hero, tick } = setup();
    await makeBlogHero(input(tenant()), deps);
    tick(200_000);
    const broken: HeroDeps = { ...deps, store: vi.fn(async () => ({ ok: false as const, reason: "store_failed" as const })) };
    await makeBlogHero(input(tenant()), broken);
    expect(hero()).toMatchObject({ status: "failed", error: "store_failed", heroRef: "f1.png", shareRef: "f2.png" });
  });

  it("only a blog article with copy gets a hero", async () => {
    const empty = setup({}, samplePlan({}, sampleHub({ body: "" })));
    expect(await makeBlogHero(input(tenant()), empty.deps)).toEqual({ ok: false, status: 400, error: "no_article" });
    const none = setup();
    expect(await makeBlogHero({ ...input(tenant()), nodeId: "nope" }, none.deps)).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});

describe("nothing else can wipe the hero", () => {
  it("survives a fact check or rewrite (a whole-meta write) and a canvas save", async () => {
    const { db, deps, hero } = setup();
    const before = ContentPlanSchema.parse(db.raw(PLANS, "plan_1"));
    await makeBlogHero(input(tenant()), deps);
    const made = hero();
    // The fact check saves the whole meta it read before the hero was made.
    await updateContentPlanNode(ctx, "ws1", "plan_1", "hub", { blog: BlogArticleMetaSchema.parse({ metaTitle: "Checked" }) }, db);
    expect(hero()).toEqual(made);
    // A canvas save sends its own stale copy of the graph.
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: before.graph }, db);
    expect(hero()).toEqual(made);
    // Nor can a client send one in.
    const forged = { ...before.graph, nodes: [{ ...before.graph.nodes[0]!, blog: { ...BlogArticleMetaSchema.parse({}), hero: { ...made!, heroRef: "evil.png" } } }] };
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: forged }, db);
    expect(hero()!.heroRef).toBe(made!.heroRef);
  });

  it("a person's alt text is saved, cleaned", async () => {
    const { db, deps, hero } = setup();
    await makeBlogHero(input(tenant()), deps);
    await setHeroAlt(ctx, ids, "  A chart — rising  ", (c, w, p, n, next) => updateBlogHero(c, w, p, n, next, db));
    expect(hero()!.alt).toBe("A chart, rising");
  });
});

describe("an uploaded hero", () => {
  it("is cropped to the hero, given a share card, and wins over a run in progress", async () => {
    const { deps, hero } = setup();
    await deps.update(ctx, "ws1", "plan_1", "hub", () => ({ status: "pending", startedAt: new Date(T0).toISOString() }) as never);
    const r = await heroFromUpload({ ctx, tenant: tenant(), ...ids }, { bytes: Buffer.from("mine"), mimeType: "image/jpeg" }, deps);
    expect(r.ok).toBe(true);
    expect(hero()).toMatchObject({ status: "ready", styleId: "upload", heroRef: "f1.png", shareRef: "f2.png" });
  });
});

describe("helpers", () => {
  it("cleans alt text: one line, no quotes, no dashes, at most 250", () => {
    expect(cleanAlt('"A desk — with a laptop"\nmore', "x")).toBe("A desk, with a laptop");
    expect(cleanAlt(null, "The title")).toBe("The title");
    expect(cleanAlt("a".repeat(400), "x")).toHaveLength(250);
  });
});

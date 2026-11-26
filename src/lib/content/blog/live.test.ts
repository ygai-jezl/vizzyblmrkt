import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BlogArticleMetaSchema, BlogHeroSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { updateBlogHero, updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { checkLive, setArticleLive, titlesMatch } from "./live";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const now = () => new Date("2026-10-15T10:00:00.000Z");
const TITLE = "What is AI search visibility monitoring?";
const page = (title: string, refused = false) => async () => ({ title, refused });

function seed(db: FakeFirestore, plan: ContentPlan = samplePlan()): ContentPlan {
  db.seed(PLANS, plan.id, plan);
  return plan;
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("is the article live?", () => {
  it("knows the article's title on its page, with the site's name added or a long one cut short", () => {
    expect(titlesMatch("What is AI search visibility monitoring? | Acme", [TITLE])).toBe(true);
    expect(titlesMatch("What Is AI Search Visibility Monitoring — Acme Blog", [TITLE])).toBe(true);
    expect(titlesMatch("What is AI search visibility…", [TITLE])).toBe(true);
    // A site answering every address with its own name is not the article.
    expect(titlesMatch("Acme AI visibility", ["Acme AI visibility platform for growing brands"])).toBe(false);
    expect(titlesMatch("Acme AI visibility platform for growing", ["Acme AI visibility platform for growing brands"])).toBe(true);
    expect(titlesMatch("Acme Blog", [TITLE])).toBe(false);
    expect(titlesMatch("", [TITLE])).toBe(false);
    expect(titlesMatch("Pricing | Acme", ["", "Pricing"])).toBe(true);
  });

  it("says what a check found", async () => {
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], page(`${TITLE} | Acme`))).toEqual({ reachable: true, refused: false, title: `${TITLE} | Acme`, matched: true });
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], page("", true))).toMatchObject({ reachable: true, refused: true, matched: false });
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], async () => null)).toMatchObject({ reachable: false, matched: false });
  });

  it("marks it live when the check finds the article at its address, and its row with it", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: page(`${TITLE} | Acme`) });
    expect(r.ok && r.node.blog?.live).toEqual({
      url: "https://acme.example/blog/visibility",
      at: "2026-10-15T10:00:00.000Z",
      by: "check",
      titleMatched: true,
      checkedAt: "2026-10-15T10:00:00.000Z",
    });
    expect(db.raw("brand_map_pages", "p_plan_1")).toMatchObject({ state: "live", liveAt: "2026-10-15T10:00:00.000Z" });
  });

  it("leaves it as it was when the check does not find it, and says why", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: page("Acme Blog") });
    expect(r).toMatchObject({ ok: true, check: { reachable: true, matched: false, title: "Acme Blog" } });
    expect(db.writeCountFor(PLANS, "plan_1")).toBe(0);
  });

  it("takes a person's word that it is live, or that it is not", async () => {
    const db = new FakeFirestore();
    let plan = seed(db);
    const marked = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now });
    expect(marked.ok && marked.node.blog?.live).toMatchObject({ by: "operator", titleMatched: false });
    plan = { ...plan, graph: { ...plan.graph, nodes: [marked.ok ? marked.node : sampleHub()] } };
    const cleared = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "clear" }, { db, now });
    expect(cleared.ok && cleared.node.blog?.live).toBeNull();
    expect(db.raw("brand_map_pages", "p_plan_1")).toMatchObject({ state: "draft", liveAt: null });
  });

  it("keeps the day it was first seen live when checked again, and nothing else can take the mark away", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark" }, { db, now: () => new Date("2026-01-10T00:00:00.000Z") });
    const later = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now: () => new Date("2026-10-15T00:00:00.000Z"), fetchPage: page(`${TITLE} | Acme`) });
    expect(later.ok && later.node.blog?.live).toEqual({
      url: "https://acme.example/blog/visibility",
      at: "2026-01-10T00:00:00.000Z",
      by: "check",
      titleMatched: true,
      checkedAt: "2026-10-15T00:00:00.000Z",
    });
    type Stored = { graph: { nodes: Array<{ body: string; blog: { metaTitle: string; live?: { at: string } } }> } };
    const hub = () => (db.raw(PLANS, "plan_1") as Stored).graph.nodes[0]!;
    // A fact check or a rewrite writes the node's meta afresh: the mark stays.
    await updateContentPlanNode(ctx, "ws1", "plan_1", "hub", { blog: BlogArticleMetaSchema.parse({ metaTitle: "New title" }), made: { unstamped: "nothing_made" } }, db);
    expect(hub()).toMatchObject({ blog: { metaTitle: "New title", live: { at: "2026-01-10T00:00:00.000Z" } } });
    // A canvas save sends the whole graph, its own copy of the meta without the mark: the mark stays.
    const stale = samplePlan({}, sampleHub({ status: "approved", body: "edited" }));
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: stale.graph }, db);
    expect(hub()).toMatchObject({ body: "edited", blog: { live: { at: "2026-01-10T00:00:00.000Z" } } });
    // Taken away by the person, it stays away whatever a stale canvas sends back.
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "clear" }, { db });
    const withMark = samplePlan({}, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), live: { url: "https://acme.example/blog/visibility", at: "2026-01-10T00:00:00.000Z", by: "operator", titleMatched: false } } }));
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: withMark.graph }, db);
    expect((db.raw(PLANS, "plan_1") as { graph: { nodes: Array<{ blog: { live: unknown } }> } }).graph.nodes[0]!.blog.live).toBeNull();
  });

  it("needs a blog article with an address", async () => {
    const db = new FakeFirestore();
    const none = samplePlan({ strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null, sequenceType: null } });
    expect(await setArticleLive(ctx, { workspaceId: "ws1", plan: none, nodeId: "hub", action: "check" }, { db })).toMatchObject({ status: 409, error: "no_address" });
    const home = samplePlan({ strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/", subscriberCount: null, sequenceType: null } });
    expect(await setArticleLive(ctx, { workspaceId: "ws1", plan: home, nodeId: "hub", action: "mark" }, { db })).toMatchObject({ error: "no_address" });
    expect(await setArticleLive(ctx, { workspaceId: "ws1", plan: samplePlan(), nodeId: "nope", action: "mark" }, { db })).toMatchObject({ status: 404 });
    const letter = samplePlan({ topology: { hubChannel: "newsletter", spokeChannels: [] } });
    expect(await setArticleLive(ctx, { workspaceId: "ws1", plan: letter, nodeId: "hub", action: "mark" }, { db })).toMatchObject({ status: 409, error: "not_a_blog_plan" });
  });

  it("with the blog hero on, the check also says whether the page has a share image", async () => {
    const withImage = async () => ({ title: `${TITLE} | Acme`, ogImage: "https://acme.example/og.png" });
    const without = async () => ({ title: `${TITLE} | Acme` });
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], withImage)).not.toHaveProperty("shareImage");
    expect(await checkLive("https://acme.example/blog/visibility", [TITLE], withImage, { shareImage: true })).toMatchObject({ shareImage: true });

    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("BLOG_HERO_ENABLED", "true");
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    const r = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check" }, { db, now, fetchPage: without });
    expect(r.ok && r.node.blog?.live).toMatchObject({ by: "check", shareImage: false });
  });
});

describe("true dates with the live mark (BLOG_DATES_ENABLED)", () => {
  type Stored = { graph: { nodes: Array<{ body: string; blog: { metaTitle: string; dates?: unknown; live?: unknown } }> } };
  const hub = (db: FakeFirestore) => (db.raw(PLANS, "plan_1") as Stored).graph.nodes[0]!;
  const dated = (title: string, dates: { published: string | null; modified: string | null }) => async () => ({ title, dates });

  beforeEach(() => vi.stubEnv("BLOG_DATES_ENABLED", "true"));

  it("takes Published and Updated from the page a check finds, and writes nothing with the switch off", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    const r = await setArticleLive(
      ctx,
      { workspaceId: "ws1", plan, nodeId: "hub", action: "check" },
      { db, now, fetchPage: dated(`${TITLE} | Acme`, { published: "2026-10-01T09:00:00+01:00", modified: "2026-10-12" }) },
    );
    expect(r.ok && r.node.blog?.dates).toEqual({
      published: { at: "2026-10-01T08:00:00.000Z", source: "page" },
      updated: { at: "2026-10-12", source: "page" },
      page: { published: "2026-10-01T09:00:00+01:00", modified: "2026-10-12", readAt: "2026-10-15T10:00:00.000Z" },
    });

    vi.stubEnv("BLOG_DATES_ENABLED", "");
    const off = new FakeFirestore();
    const plain = seed(off);
    const o = await setArticleLive(ctx, { workspaceId: "ws1", plan: plain, nodeId: "hub", action: "check" }, { db: off, now, fetchPage: dated(TITLE, { published: "2026-10-01", modified: null }) });
    expect(o.ok && o.node.blog?.dates).toBeUndefined();
  });

  it("takes the day a person gives with It's live, never one still to come, and when first seen without one", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    for (const day of ["2026-10-30", "15/10/2026", "2026-02-30"]) {
      expect(await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark", day }, { db, now })).toEqual({ ok: false, status: 400, error: "invalid_day" });
    }
    expect(await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "check", day: "2026-10-01" }, { db, now })).toEqual({ ok: false, status: 400, error: "invalid_day" });
    const marked = await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark", day: "2026-10-03" }, { db, now });
    expect(marked.ok && marked.node.blog?.dates).toEqual({ published: { at: "2026-10-03", source: "person" } });

    const other = new FakeFirestore();
    const p2 = seed(other);
    const seen = await setArticleLive(ctx, { workspaceId: "ws1", plan: p2, nodeId: "hub", action: "check" }, { db: other, now, fetchPage: page(TITLE) });
    // A page read with no dates of its own is recorded as carrying none.
    expect(seen.ok && seen.node.blog?.dates).toEqual({
      published: { at: "2026-10-15T10:00:00.000Z", source: "found" },
      page: { published: null, modified: null, readAt: "2026-10-15T10:00:00.000Z" },
    });
  });

  it("keeps the dates through a rewrite, a canvas save and a hero, and Not live takes them away for good", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, samplePlan({}, sampleHub({ status: "approved" })));
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "mark", day: "2026-10-03" }, { db, now });
    const want = { published: { at: "2026-10-03", source: "person" as const } };
    // A fact check or a rewrite writes the meta afresh.
    await updateContentPlanNode(ctx, "ws1", "plan_1", "hub", { blog: BlogArticleMetaSchema.parse({ metaTitle: "New title" }), made: { unstamped: "nothing_made" } }, db);
    expect(hub(db)).toMatchObject({ blog: { metaTitle: "New title", dates: want } });
    // A canvas save sends its own copy of the meta, without them.
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: samplePlan({}, sampleHub({ status: "approved", body: "edited" })).graph }, db);
    expect(hub(db)).toMatchObject({ body: "edited", blog: { dates: want } });
    // The hero's own write.
    await updateBlogHero(ctx, "ws1", "plan_1", "hub", () => BlogHeroSchema.parse({ status: "pending", startedAt: now().toISOString() }), db);
    expect(hub(db).blog.dates).toEqual(want);
    // Not live: gone, and a stale canvas carrying them can't bring them back.
    await setArticleLive(ctx, { workspaceId: "ws1", plan, nodeId: "hub", action: "clear" }, { db, now });
    expect(hub(db).blog.dates).toBeUndefined();
    const stale = samplePlan({}, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), dates: want } }));
    await updateContentPlan(ctx, "ws1", "plan_1", { graph: stale.graph }, db);
    expect(hub(db).blog.dates).toBeUndefined();
  });
});


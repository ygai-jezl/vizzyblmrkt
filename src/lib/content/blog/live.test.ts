import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BlogArticleMetaSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { updateContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
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
    await updateContentPlanNode(ctx, "ws1", "plan_1", "hub", { blog: BlogArticleMetaSchema.parse({ metaTitle: "New title" }) }, db);
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
});

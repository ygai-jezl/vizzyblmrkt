import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: tenants.getTenantById };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema, ContentPlanSchema, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { checkPlanBlogFacts, isCitableBlogPlan, matchPlanSeen, researchPlanBlog } from "./hubActions";
import { forTenant } from "@/lib/tenant";
import { createNote } from "@/lib/brandNotes/store";
import type { KnowledgeCollectionLike } from "@/lib/tenant/types";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";
import { readBrandMap, saveBrandMap } from "@/lib/brandMap/store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const ws = { id: "ws1", name: "Acme programme", audience: null };
const KEY = "workspaces/ws1/content_plans";

const hub = (over: Partial<ContentNode> = {}): ContentNode =>
  ({
    id: "hub",
    type: "hub",
    channel: "blog",
    role: "Hub",
    position: { x: 0, y: 0 },
    brief: "Explain it.",
    body: SAMPLE_ARTICLE.replace("Acme Visibility is an alternative to Rivalco.", "Acme Visibility is an alternative to Rivalco, which has 900 staff."),
    placeholderValues: {},
    status: "generated",
    warnings: ["unsupported_figures", "some_other_warning"],
    subjectVariants: [],
    ...over,
  }) as ContentNode;

function seed(db: FakeFirestore, over: Partial<ContentPlan> = {}, node: ContentNode = hub()): ContentPlan {
  const plan = ContentPlanSchema.parse({
    id: "p1",
    tenantId: "ten_A",
    workspaceId: "ws1",
    name: "Visibility guide",
    status: "generating",
    strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility" },
    scope: { topics: [], spark: "Buyers ask AI assistants for shortlists." },
    knowledge: {},
    topology: { hubChannel: "blog", spokeChannels: [] },
    graph: { nodes: [node], edges: [] },
    blog: SAMPLE_BRIEF,
    createdAt: "2026-10-07T08:00:00.000Z",
    updatedAt: "2026-10-07T08:00:00.000Z",
    ...over,
  });
  db.seed(KEY, plan.id, plan);
  return plan;
}

const retrieve = (async () => ({ formatted: "Harbor's share of voice rose from 6% to 21%.", chunks: [] })) as never;
const now = () => new Date("2026-10-07T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
  tenants.getTenantById.mockResolvedValue({ tenantName: "Acme Ltd" });
});
afterEach(() => vi.unstubAllEnvs());

describe("blog hub actions", () => {
  it("knows which plans have a CITABLE blog hub", () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    expect(isCitableBlogPlan(plan)).toBe(true);
    expect(isCitableBlogPlan({ ...plan, topology: { hubChannel: "newsletter", spokeChannels: [] } })).toBe(false);
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "false");
    expect(isCitableBlogPlan(plan)).toBe(false);
  });

  it("researches a blog plan and saves the brief on it", async () => {
    const db = new FakeFirestore();
    const plan = seed(db, { blog: BlogBriefSchema.parse({ buyerQuestions: "Which engines?" }) });
    const r = await researchPlanBlog(
      ctx,
      { workspace: ws, plan },
      {
        db,
        now,
        grounded: (async () => ({ text: "PRIMARY: How do I track my brand?\nQ: What does it cost? | pricing", model: "m", sources: [], supports: [] })) as never,
        retrieve,
        sitePages: async () => ({ pages: [{ url: "https://acme.example/pricing", title: "Pricing" }], repoPaths: [] }),
      },
    );
    expect(r).toMatchObject({ ok: true, searched: true, found: { questions: 1, links: 1 } });
    const saved = db.raw(KEY, "p1")!.blog as ContentPlan["blog"];
    expect(saved).toMatchObject({
      primaryQuestion: "How do I track my brand?",
      buyerQuestions: "Which engines?",
      publisherName: "Acme Ltd", // the tenant's own name, not the programme's
      researchedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(saved!.links[0]).toMatchObject({ url: "https://acme.example/pricing", intent: "convert" });
  });

  it("with a saved brand map, keeps to its names and suggests the new ones for it", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "true");
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: { identity: { name: "Acme", category: "AI visibility tracking" } } }, { db });
    const plan = seed(db, { blog: BlogBriefSchema.parse({}) });
    const r = await researchPlanBlog(
      ctx,
      { workspace: ws, plan },
      {
        db,
        now,
        grounded: (async () => ({
          text: "PRIMARY: How do I track my brand?\nENTITY: Rivalco | alternative\nENTITY: AI search monitoring | category",
          model: "m",
          sources: [],
          supports: [],
        })) as never,
        retrieve,
        sitePages: async () => ({ pages: [], repoPaths: [] }),
      },
    );
    expect(r).toMatchObject({ ok: true, map: { respelled: 1, suggested: 1 } });
    const saved = db.raw(KEY, "p1")!.blog as ContentPlan["blog"];
    expect(saved!.entities.map((e) => e.name)).toEqual(["Acme", "AI visibility tracking", "Rivalco"]);
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.suggestions.map((s) => [s.key, s.from, s.ref?.planId])).toEqual([["name:rivalco", "article", "p1"]]);
  });

  it("without the switch, ignores a saved map", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: { identity: { name: "Acme" } } }, { db });
    const plan = seed(db, { blog: BlogBriefSchema.parse({}) });
    const r = await researchPlanBlog(
      ctx,
      { workspace: ws, plan },
      { db, now, grounded: (async () => ({ text: "ENTITY: Rivalco | alternative", model: "m", sources: [], supports: [] })) as never, retrieve, sitePages: async () => ({ pages: [], repoPaths: [] }) },
    );
    expect(r).not.toHaveProperty("map");
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.suggestions).toEqual([]);
  });

  it("tells research which domains the tenant owns, so an article published elsewhere still links to the brand's site", async () => {
    tenants.getTenantById.mockResolvedValue({
      tenantName: "Acme Ltd",
      rootDomain: "acme.example",
      allowedOrigins: ["https://app.acme-labs.example"],
      emailSenderConfig: {
        domains: [
          { domain: "mail.acme-mail.example", status: "verified" },
          { domain: "not-ours-yet.example", status: "pending" },
        ],
      },
    });
    const db = new FakeFirestore();
    // The article goes on a blogging platform, not on the brand's own site.
    const plan = seed(db, {
      blog: BlogBriefSchema.parse({}),
      strategy: { objective: "brand_visibility", hubUrl: "https://acme-example.substack.com/p/visibility" },
    } as Partial<ContentPlan>);
    const r = await researchPlanBlog(
      ctx,
      { workspace: ws, plan },
      {
        db,
        now,
        grounded: (async () => null) as never,
        retrieve,
        robots: async () => null,
        sitePages: async () => ({
          pages: [
            { url: "https://acme.example/pricing", title: "Pricing" },
            { url: "https://app.acme-labs.example/demo", title: "Book a demo" },
            { url: "https://help.acme-mail.example/features", title: "Features" },
            { url: "https://not-ours-yet.example/pricing", title: "Pricing" },
            { url: "https://rival-example.substack.com/p/pricing", title: "Pricing" },
          ],
          repoPaths: [],
        }),
      },
    );
    expect(r.ok && r.brief.links.map((l) => l.url)).toEqual([
      "https://acme.example/pricing",
      "https://app.acme-labs.example/demo",
      "https://help.acme-mail.example/features",
    ]);
  });

  it("refuses research when switched off or when the hub is not a blog", async () => {
    const db = new FakeFirestore();
    const newsletter = seed(db, { topology: { hubChannel: "newsletter", spokeChannels: [] } });
    expect(await researchPlanBlog(ctx, { workspace: ws, plan: newsletter }, { db })).toMatchObject({ ok: false, status: 409 });
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "false");
    expect(await researchPlanBlog(ctx, { workspace: ws, plan: seed(db) }, { db })).toMatchObject({ ok: false, status: 503 });
  });

  it("fact-checks the hub, saves the corrected copy and refreshes only its own warnings", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    const generate = vi.fn(async (_prompt: string) =>
      ["OLD: Acme Visibility is an alternative to Rivalco, which has 900 staff.", "NEW: Acme Visibility is an alternative to Rivalco.", "WHY: staff count not given"].join("\n"),
    );
    const r = await checkPlanBlogFacts(ctx, { workspace: ws, plan, nodeId: "hub" }, { db, generate, retrieve, now });
    expect(r).toMatchObject({ ok: true, corrected: 1, checked: true });
    const saved = (db.raw(KEY, "p1")!.graph as ContentPlan["graph"]).nodes[0]!;
    expect(saved.body).not.toContain("900 staff");
    expect(saved.blog).toMatchObject({ checkedAt: "2026-10-07T10:00:00.000Z", unsupportedFigures: [] });
    expect(saved.blog!.corrections).toEqual([
      { before: "Acme Visibility is an alternative to Rivalco, which has 900 staff.", after: "Acme Visibility is an alternative to Rivalco.", reason: "staff count not given" },
    ]);
    // The figure warning is cleared; a warning the checks don't own is left alone.
    expect(saved.warnings).toEqual(["some_other_warning"]);
    expect(saved.status).toBe("generated");
  });

  it("never rewrites approved, scheduled or empty copy, and says so when the checker is down", async () => {
    const check = (node: ContentNode, generate: () => Promise<string | null> = async () => "OK") => {
      const db = new FakeFirestore();
      return checkPlanBlogFacts(ctx, { workspace: ws, plan: seed(db, {}, node), nodeId: node.id }, { db, generate, retrieve, now });
    };
    expect(await check(hub({ status: "approved" }))).toMatchObject({ ok: false, status: 409, error: "node_locked" });
    expect(await check(hub({ scheduledAt: "2026-10-08T09:00:00.000Z" }))).toMatchObject({ ok: false, error: "node_locked" });
    expect(await check(hub({ body: "" }))).toMatchObject({ ok: false, status: 409, error: "nothing_to_check" });
    expect(await check(hub({ type: "spoke" }))).toMatchObject({ ok: false, status: 409, error: "not_a_blog_hub" });
    expect(await check(hub(), async () => null)).toMatchObject({ ok: false, status: 502, error: "check_unavailable" });
    const db = new FakeFirestore();
    expect(await checkPlanBlogFacts(ctx, { workspace: ws, plan: seed(db), nodeId: "nope" }, { db })).toMatchObject({ ok: false, status: 404 });
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "false");
    expect(await check(hub())).toMatchObject({ ok: false, status: 503 });
  });

  it("matches the article's notes with the brand's own rest setting, and saves the resting ones on its brief", async () => {
    for (const v of ["CREATE_BLOG_EDITORIAL_ENABLED", "BRAND_NOTES_ENABLED", "BRAND_NOTES_QUESTIONS_ENABLED", "BRAND_NOTES_REST_ENABLED"]) vi.stubEnv(v, "true");
    const db = new FakeFirestore();
    const plan = seed(db);
    const made = await createNote(ctx, { text: "A client's visibility jumped after a rival's page went offline.", kind: "customer_story", subjectIds: [], canName: false }, { source: "typed" }, { db, embed: async () => [] });
    if (!made.ok) throw new Error("not made");
    const at = new Date(Date.now() - 6 * 86_400_000).toISOString();
    await forTenant(ctx, db).brandNotes.update(made.value.id, { usedBy: ["ws1/other"], uses: [{ ref: "ws1/other", title: "Another article", at, written: true }] });
    const row = { tenantId: "ten_A", kind: "note", ref: made.value.id, status: "kept", _distance: 0.1 };
    const vectors: KnowledgeCollectionLike = { where: () => vectors, findNearest: () => ({ get: async () => ({ empty: false, size: 1, docs: [{ id: "v0", data: () => row }] }) }) };
    const generate = vi.fn(async (prompt: string) => (prompt.includes("ASK:") ? "ASK: When did a result change what you published?" : "[1]: STRONG"));
    const deps = { db, vectors, generate, query: async () => [1], embed: async () => [] };

    const resting = await matchPlanSeen(ctx, { workspace: ws, plan }, deps);
    expect(resting).toMatchObject({ ok: true, seen: { notes: [], resting: [{ id: made.value.id, reason: "recent", byTitle: "Another article" }] } });
    expect((db.raw(KEY, "p1")!.blog as { seen: { resting: unknown[] } }).seen.resting).toHaveLength(1);

    tenants.getTenantById.mockResolvedValue({ tenantName: "Acme Ltd", brandNotesRest: { restDays: 3, maxUses: 3 } });
    const ready = await matchPlanSeen(ctx, { workspace: ws, plan }, deps);
    expect(ready).toMatchObject({ ok: true, seen: { notes: [{ id: made.value.id, usedIn: 1 }], resting: [] } });
  });
});

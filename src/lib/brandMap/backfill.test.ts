import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { samplePlan } from "@/lib/content/blog/testing/samplePlan";
import { sitePageId } from "@/lib/content/blog/pageRow";
import { readExistingPages, type BackfillCursor, type BackfillDeps, type BackfillStep, type SiteListing } from "./backfill";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const PAGES = "brand_map_pages";
const now = () => new Date("2026-10-15T10:00:00.000Z");

function seedPlans(db: FakeFirestore, ws: string, ids: string[]) {
  for (const id of ids) db.seed(`workspaces/${ws}/content_plans`, id, samplePlan({ id, workspaceId: ws }));
}

async function runAll(deps: BackfillDeps): Promise<BackfillStep[]> {
  const steps: BackfillStep[] = [];
  let cursor: BackfillCursor | null = null;
  for (let i = 0; i < 30; i += 1) {
    const step = await readExistingPages(ctx, cursor, deps);
    steps.push(step);
    if (step.done) break;
    cursor = step.next;
  }
  return steps;
}

const PAGES_READ = [
  { url: "https://acme.example/pricing", title: "Pricing" },
  { url: "https://acme.example/pricing?utm_source=mail", title: "Pricing again" },
  { url: "https://acme.example/blog/visibility", title: "An article written here" },
  { url: "https://elsewhere.example/x", title: "Someone else's" },
  { url: "https://acme.example/about", title: "About  us", links: ["https://acme.example/pricing", "https://elsewhere.example/y"] },
];
const listing = (pages = PAGES_READ, over: Partial<SiteListing> = {}): SiteListing => ({
  sources: [{ workspaceId: "ws1", ticketId: "tkt_site", pages }],
  tickets: new Map([["ws1", new Set(["tkt_site"])]]),
  ...over,
});
const siteRow = (url: string, over: Record<string, unknown> = {}) => ({
  tenantId: "ten_A",
  kind: "site",
  url,
  title: url,
  state: "live",
  workspaceId: "ws1",
  sourceId: "tkt_site",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("reading what's already there", () => {
  function setup(site: SiteListing = listing()) {
    const db = new FakeFirestore();
    seedPlans(db, "ws1", Array.from({ length: 27 }, (_, i) => `plan_${String(i).padStart(2, "0")}`));
    seedPlans(db, "ws2", ["plan_zz"]);
    db.seed("workspaces/ws1/content_plans", "letter", samplePlan({ id: "letter", topology: { hubChannel: "newsletter", spokeChannels: [] } }));
    // Left behind by a programme deleted while the switch was off.
    db.seed(PAGES, "p_old", { tenantId: "ten_A", kind: "article", workspaceId: "ws_gone", planId: "old", state: "draft" });
    const deps: BackfillDeps = {
      db,
      now,
      workspaces: async () => [{ id: "ws1" }, { id: "ws2" }, { id: "ws3", archivedAt: "2026-01-01T00:00:00.000Z" }],
      ownSites: async () => ["https://acme.example"],
      siteListing: async () => site,
    };
    return { db, deps };
  }

  it("puts every blog article on the map 25 at a time, then the pages already on the site, with where each was read", async () => {
    const { db, deps } = setup();
    const steps = await runAll(deps);
    expect(steps.map((s) => s.articles)).toEqual([25, 2, 1, 0, 0, 0, 0]);
    expect(steps.map((s) => s.removed)).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(steps.at(-1)).toMatchObject({ done: true, sitePages: 2 });

    const rows = db.dump(PAGES);
    expect(rows.filter((r) => r.kind === "article")).toHaveLength(28);
    expect(rows.filter((r) => r.kind === "site").map((r) => [r.url, r.title, r.links, r.linksKnown, r.workspaceId, r.sourceId])).toEqual([
      ["https://acme.example/pricing", "Pricing", [], false, "ws1", "tkt_site"],
      ["https://acme.example/about", "About us", ["https://acme.example/pricing"], true, "ws1", "tkt_site"],
    ]);
    expect(db.raw(PAGES, "p_old")).toBeUndefined();
  });

  it("rewrites nothing when run again", async () => {
    const { db, deps } = setup();
    await runAll(deps);
    await runAll(deps);
    expect(db.writeCountFor(PAGES, "p_plan_00")).toBe(1);
    expect(db.writeCountFor(PAGES, sitePageId("ten_A", "https://acme.example/pricing"))).toBe(1);
  });

  it("takes a page away only when its source was read again without it, or was removed", async () => {
    const { db, deps } = setup();
    await runAll(deps);
    const pricing = sitePageId("ten_A", "https://acme.example/pricing");
    const about = sitePageId("ten_A", "https://acme.example/about");
    // Read again, the source no longer has the pricing page.
    await runAll({ ...deps, siteListing: async () => listing(PAGES_READ.filter((p) => !p.url.includes("/pricing"))) });
    expect(db.raw(PAGES, pricing)).toBeUndefined();
    expect(db.raw(PAGES, about)).toBeDefined();
    // The source itself was removed from the programme.
    await runAll({ ...deps, siteListing: async () => ({ sources: [], tickets: new Map([["ws1", new Set<string>()]]) }) });
    expect(db.raw(PAGES, about)).toBeUndefined();
  });

  it("never takes a page away because a read failed or a source was not read this time", async () => {
    const { db, deps } = setup();
    await runAll(deps);
    // The programme's sources couldn't be listed, or the source fell out of what is read.
    for (const site of [{ sources: [], tickets: new Map() }, { sources: [], tickets: new Map([["ws1", new Set(["tkt_site"])]]) }]) {
      await runAll({ ...deps, siteListing: async () => site });
      expect(db.dump(PAGES).filter((r) => r.kind === "site")).toHaveLength(2);
    }
    // A row from before rows knew their source is left as it is.
    db.seed(PAGES, "s_legacy", siteRow("https://acme.example/legacy", { sourceId: null, workspaceId: null }));
    await runAll({ ...deps, siteListing: async () => listing([]) });
    expect(db.raw(PAGES, "s_legacy")).toBeDefined();
  });

  it("takes a page on the site away once it is an article written here", async () => {
    const { db, deps } = setup();
    db.seed(PAGES, "s_now_article", siteRow("https://acme.example/blog/visibility"));
    await runAll(deps);
    expect(db.raw(PAGES, "s_now_article")).toBeUndefined();
  });

  it("skips an address or a link too long to keep, and carries on", async () => {
    const long = `https://acme.example/${"x".repeat(2100)}`;
    const { db, deps } = setup(listing([{ url: long, title: "Too long" }, { url: "https://acme.example/ok", title: "OK", links: [long] }]));
    const steps = await runAll(deps);
    expect(steps.at(-1)).toMatchObject({ done: true, sitePages: 1 });
    expect(db.dump(PAGES).filter((r) => r.kind === "site").map((r) => [r.url, r.links])).toEqual([["https://acme.example/ok", []]]);
  });

  it("keeps the articles of a programme past the first 200 it lists", async () => {
    const { db, deps } = setup();
    db.seed("workspaces", "ws_far", { tenantId: "ten_A", name: "Far", createdAt: "2026-01-01T00:00:00.000Z" });
    db.seed(PAGES, "p_far", { tenantId: "ten_A", kind: "article", workspaceId: "ws_far", planId: "far", state: "draft" });
    seedPlans(db, "ws_far", ["far"]);
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `ws_${String(i).padStart(3, "0")}`, archivedAt: "2026-01-01T00:00:00.000Z" }));
    await runAll({ ...deps, workspaces: async () => many });
    expect(db.raw(PAGES, "p_far")).toBeDefined();
  });

  it("reads the articles but no pages on the site when the brand has no site", async () => {
    const { db, deps } = setup();
    db.seed(PAGES, "s_kept", siteRow("https://acme.example/kept"));
    const steps = await runAll({ ...deps, ownSites: async () => [] });
    expect(steps.at(-1)).toMatchObject({ done: true, noSite: true, sitePages: 0 });
    expect(db.raw(PAGES, "s_kept")).toBeDefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { samplePlan } from "@/lib/content/blog/testing/samplePlan";
import { readExistingPages, type BackfillCursor, type BackfillDeps, type BackfillStep } from "./backfill";

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

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("reading what's already there", () => {
  function setup() {
    const db = new FakeFirestore();
    seedPlans(db, "ws1", Array.from({ length: 27 }, (_, i) => `plan_${String(i).padStart(2, "0")}`));
    seedPlans(db, "ws2", ["plan_zz"]);
    db.seed("workspaces/ws1/content_plans", "letter", samplePlan({ id: "letter", topology: { hubChannel: "newsletter", spokeChannels: [] } }));
    // Left behind by a programme deleted while the switch was off, and a page the crawl no longer has.
    db.seed(PAGES, "p_old", { tenantId: "ten_A", kind: "article", workspaceId: "ws_gone", planId: "old", state: "draft" });
    db.seed(PAGES, "s_stale", { tenantId: "ten_A", kind: "site", url: "https://acme.example/gone", state: "live" });
    const deps: BackfillDeps = {
      db,
      now,
      workspaces: async () => [{ id: "ws1" }, { id: "ws2" }, { id: "ws3", archivedAt: "2026-01-01T00:00:00.000Z" }],
      ownSites: async () => ["https://acme.example"],
      sitePages: async () => [
        { url: "https://acme.example/pricing", title: "Pricing" },
        { url: "https://acme.example/pricing?utm_source=mail", title: "Pricing again" },
        { url: "https://acme.example/blog/visibility", title: "An article written here" },
        { url: "https://elsewhere.example/x", title: "Someone else's" },
        { url: "https://acme.example/about", title: "About  us", links: ["https://acme.example/pricing", "https://elsewhere.example/y"] },
      ],
    };
    return { db, deps };
  }

  it("puts every blog article on the map 25 at a time, then the pages already on the site", async () => {
    const { db, deps } = setup();
    const steps = await runAll(deps);
    expect(steps.map((s) => s.articles)).toEqual([25, 2, 1, 0, 0, 0, 0]);
    expect(steps.map((s) => s.removed)).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(steps.at(-1)).toMatchObject({ done: true, sitePages: 2 });

    const rows = db.dump(PAGES);
    expect(rows.filter((r) => r.kind === "article")).toHaveLength(28);
    expect(rows.filter((r) => r.kind === "site").map((r) => [r.url, r.title, r.links, r.linksKnown])).toEqual([
      ["https://acme.example/pricing", "Pricing", [], false],
      ["https://acme.example/about", "About us", ["https://acme.example/pricing"], true],
    ]);
    expect(db.raw(PAGES, "p_old")).toBeUndefined();
    expect(db.raw(PAGES, "s_stale")).toBeUndefined();
  });

  it("rewrites nothing when run again", async () => {
    const { db, deps } = setup();
    await runAll(deps);
    await runAll(deps);
    expect(db.writeCountFor(PAGES, "p_plan_00")).toBe(1);
  });

  it("reads the articles but no pages on the site when the brand has no site", async () => {
    const { db, deps } = setup();
    const steps = await runAll({ ...deps, ownSites: async () => [] });
    expect(steps.at(-1)).toMatchObject({ done: true, noSite: true, sitePages: 0 });
    expect(db.dump(PAGES).filter((r) => r.kind === "site")).toHaveLength(1); // the old one is left as it was
  });
});

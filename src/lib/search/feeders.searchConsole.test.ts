import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthyAt } from "@/lib/connectors/health";
import { rolledId } from "@/lib/connectors/keys";
import { putSnapshot } from "@/lib/connectors/snapshots";
import { createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { freshCollect } from "@/lib/types/dataConnection";
import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { SEARCH_TEXT_TOP, searchConsoleSource, searchConsoleStub, searchConsoleStubs, searchLine, siteName } from "./feeders";
import { MemorySearchIndex } from "./memoryStore";
import { sweepBrand } from "./sweep";

// Search Console's searches in brand search (CONNECTORS_SEARCH_TEXT_ENABLED, ADR-0013). Every site,
// search and number is made up.
vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own store");
  },
}));

const A: TenantContext = { tenantId: "ten_fernleaf", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const ID = "dcn_ffffffffffffffffffff";
const OTHER = "dcn_gggggggggggggggggggg";
const SITE = "sc-domain:fernleaf.example";
const WINDOW = { from: "2026-10-24", to: "2026-11-20" };
const AT = "2026-11-22T10:00:00.000Z";

const row = (key: string, clicks: number, impressions: number, position: number): SnapshotRow => ({
  key,
  m: { searchClicks: clicks, searchImpressions: impressions, searchCtr: impressions ? clicks / impressions : 0, searchPosition: position },
});

let db: FakeFirestore;

async function seed(ctx: TenantContext, id: string, over: Partial<NewDataConnection> = {}) {
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: "search-console",
      method: "share_access",
      label: "Google Search Console",
      account: SITE,
      ownerUid: "usr_admin",
      grants: [],
      secrets: {},
      health: healthyAt(new Date(AT)),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: AT,
      updatedAt: AT,
      disconnectedAt: null,
      collect: { ...freshCollect(null, 1), lastDay: "2026-11-20", finalThrough: "2026-11-20", backfilledTo: "2026-08-23", filled: true, rolledOn: "2026-11-22" },
      ...over,
    },
    [{ kind: "connected", by: "usr_admin", at: AT }],
    db,
  );
}

/** The rolled 28 day searches doc of a generation. */
async function rolled(ctx: TenantContext, id: string, gen: number, rows: SnapshotRow[]) {
  await putSnapshot(
    ctx,
    rolledId(id, gen, "search_performance", "topic", "r28"),
    {
      connectionId: id,
      gen,
      account: SITE,
      connectorId: "search-console",
      stream: "search_performance",
      by: "topic",
      day: null,
      window: WINDOW,
      days: 28,
      timeZone: "America/Los_Angeles",
      final: true,
      totals: null,
      rows,
      rowsSeen: rows.length,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: AT,
      ttlAt: new Date("2027-02-18T00:00:00.000Z"),
    },
    { db },
  );
}

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "true");
  vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("a site as people read it", () => {
  it("is the domain of a domain property, and a URL prefix without its scheme or last slash", () => {
    expect(siteName("sc-domain:fernleaf.example")).toBe("fernleaf.example");
    expect(siteName("https://www.fernleaf.example/")).toBe("www.fernleaf.example");
    expect(siteName("https://fernleaf.example/blog/")).toBe("fernleaf.example/blog");
  });
});

describe("one search's line", () => {
  it("gives its impressions, clicks and position, and the days they cover", () => {
    expect(searchLine(row("pet safe hanging plants", 9, 300, 7.94), WINDOW)).toBe("pet safe hanging plants: 300 impressions, 9 clicks, position 7.9 in the 28 days to 20 Nov");
    expect(searchLine(row("repot a fig", 1, 1200, 8.2), WINDOW)).toBe("repot a fig: 1,200 impressions, 1 click, position 8.2 in the 28 days to 20 Nov");
    expect(searchLine(row("repot a fig", 0, 1, 12), { from: "2026-11-20", to: "2026-11-20" })).toBe("repot a fig: 1 impression, 0 clicks, position 12.0 on 20 Nov");
    expect(searchLine({ key: "  repot\n a   fig ", m: {} }, WINDOW)).toBe("repot a fig");
    expect(searchLine({ key: "   ", m: {} }, WINDOW)).toBeNull();
  });
});

describe("searchConsoleSource", () => {
  it("is one research source of the top 200 searches, by clicks then impressions, never a page", () => {
    const rows = [row("water a monstera", 4, 90, 9.1), row("pet safe hanging plants", 9, 300, 7.9), row("repot a fig", 9, 500, 6.4)];
    for (let i = 0; i < 250; i++) rows.push(row(`fern care ${i}`, 0, 10 + i, 30));
    const src = searchConsoleSource({ id: ID, account: SITE }, { rows, window: WINDOW })!;
    expect(src).toMatchObject({ kind: "research", ref: `gsc:${ID}`, title: "Google searches: fernleaf.example", body: "", url: `/admin/account/connections/connected?c=${ID}` });
    expect(src.parts).toHaveLength(SEARCH_TEXT_TOP);
    expect(src.parts!.slice(0, 3).map((p) => p.text.split(":")[0])).toEqual(["repot a fig", "pet safe hanging plants", "water a monstera"]);
    expect(src.parts![3]!.text).toBe("fern care 249: 259 impressions, 0 clicks, position 30.0 in the 28 days to 20 Nov");
    expect(src.parts!.every((p) => p.title === "Google searches: fernleaf.example" && p.url === `/admin/account/connections/connected?c=${ID}`)).toBe(true);
    expect(src.parts!.some((p) => p.text.includes("/"))).toBe(false);
  });

  it("keeps each search once, and gives nothing when there are none", () => {
    const src = searchConsoleSource({ id: ID, account: SITE }, { rows: [row("Repot a Fig", 9, 500, 6.4), row("repot a fig", 2, 40, 9), row(" ", 1, 1, 1)], window: WINDOW })!;
    expect(src.parts!.map((p) => p.text)).toEqual(["Repot a Fig: 500 impressions, 9 clicks, position 6.4 in the 28 days to 20 Nov"]);
    expect(searchConsoleSource({ id: ID, account: SITE }, { rows: [], window: WINDOW })).toBeNull();
    expect(searchConsoleSource({ id: ID, account: SITE }, { rows: [row("repot a fig", 9, 500, 6.4)], window: null })).toBeNull();
  });
});

describe("searchConsoleStub", () => {
  const conn = async (over: Partial<NewDataConnection> = {}) => {
    await seed(A, ID, over);
    const { forTenant } = await import("@/lib/tenant");
    return (await forTenant(A, db).dataConnections.getById(ID))!;
  };

  it("is read once a week: its version is the ISO week of the last collected day", async () => {
    const c = await conn();
    expect(searchConsoleStub(A, c, { db })).toMatchObject({ kind: "research", ref: `gsc:${ID}`, version: "2026-W47" });
    const sameWeek = { ...c, collect: { ...c.collect!, lastDay: "2026-11-22" } };
    expect(searchConsoleStub(A, sameWeek, { db })?.version).toBe("2026-W47");
    const nextWeek = { ...c, collect: { ...c.collect!, lastDay: "2026-11-23" } };
    expect(searchConsoleStub(A, nextWeek, { db })?.version).toBe("2026-W48");
  });

  it("loads the current generation's 28 days, never an old site's", async () => {
    const c = await conn();
    await rolled(A, ID, 0, [row("old site search", 50, 900, 3)]);
    expect(await searchConsoleStub(A, c, { db })!.load()).toBeNull();
    await rolled(A, ID, 1, [row("repot a fig", 9, 500, 6.4)]);
    expect((await searchConsoleStub(A, c, { db })!.load())?.parts?.map((p) => p.text)).toEqual(["repot a fig: 500 impressions, 9 clicks, position 6.4 in the 28 days to 20 Nov"]);
  });

  it("waits for 28 days or all the site has, and lists only a connected Search Console site", async () => {
    const c = await conn();
    const collect = c.collect!;
    expect(searchConsoleStub(A, { ...c, collect: { ...collect, filled: false, backfilledTo: "2026-11-10" } }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, collect: { ...collect, filled: false, backfilledTo: "2026-10-24" } }, { db })).not.toBeNull();
    expect(searchConsoleStub(A, { ...c, collect: { ...collect, filled: true, backfilledTo: "2026-11-10" } }, { db })).not.toBeNull();
    expect(searchConsoleStub(A, { ...c, collect: { ...collect, rolledOn: null } }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, collect: { ...collect, lastDay: null } }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, collect: undefined }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, status: "disconnected" }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, account: "" }, { db })).toBeNull();
    expect(searchConsoleStub(A, { ...c, connectorId: "ga4" }, { db })).toBeNull();
  });
});

describe("searchConsoleStubs", () => {
  it("lists this brand's Search Console connections only, and none while the switch or collecting is off", async () => {
    await seed(A, ID);
    await seed(B, OTHER);
    await seed(A, "dcn_hhhhhhhhhhhhhhhhhhhh", { connectorId: "cloudflare", method: "token_fields", label: "Cloudflare", account: "0123456789abcdef0123456789abcdef" });
    expect((await searchConsoleStubs(A, { db })).map((s) => s.ref)).toEqual([`gsc:${ID}`]);
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "false");
    expect(await searchConsoleStubs(A, { db })).toEqual([]);
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect(await searchConsoleStubs(A, { db })).toEqual([]);
  });
});

describe("the scheduled check with Search Console's searches", () => {
  const embed = vi.fn(async (items: unknown[]) => items.map(() => [1, 0, 0]));
  const read = async () => ({ stubs: await searchConsoleStubs(A, { db }), complete: new Set(["research"] as const) });

  it("indexes them, leaves them until the week turns, and removes them once the switch is off", async () => {
    await seed(A, ID);
    await rolled(A, ID, 1, [row("repot a fig", 9, 500, 6.4), row("pet safe hanging plants", 9, 300, 7.9)]);
    const index = new MemorySearchIndex();
    const store = index.storeFor(A);
    expect(await sweepBrand(A, {}, { store, embed, read })).toMatchObject({ records: 1, changed: 1, indexed: 1 });
    const found = await store.words("repot", { limit: 5, kinds: ["research"] });
    expect(found.map((h) => [h.ref, h.title, h.url])).toEqual([[`gsc:${ID}`, "Google searches: fernleaf.example", `/admin/account/connections/connected?c=${ID}`]]);
    expect(found[0]!.text).toBe("repot a fig: 500 impressions, 9 clicks, position 6.4 in the 28 days to 20 Nov");
    // New numbers in the same week aren't read or embedded again.
    await rolled(A, ID, 1, [row("repot a fig", 12, 640, 6.1)]);
    embed.mockClear();
    expect(await sweepBrand(A, {}, { store, embed, read })).toMatchObject({ changed: 0, indexed: 0 });
    expect(embed).not.toHaveBeenCalled();
    vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "false");
    expect(await sweepBrand(A, {}, { store, embed, read })).toMatchObject({ records: 0, removed: 1 });
    expect(await store.listManifests()).toEqual([]);
  });
});

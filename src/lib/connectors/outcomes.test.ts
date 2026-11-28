import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { articlePageKey } from "@/lib/content/blog/freshnessPages";
import { freshCollect, type ConnectionGrant } from "@/lib/types/dataConnection";
import type { LiveAnswer } from "./live";
import { allConnectors } from "./catalog";
import { healthyAt } from "./health";
import { hostOfAccount, liveCoverage, pageJoiner, readOutcomes, type OutcomeDeps } from "./outcomes";
import { PLANNING } from "./testing/signals";

// How it went's reads (STRATEGY_RESULTS_ENABLED): the real readByUse over made-up connections, with
// the live read stubbed, so no provider is ever called. Sites and numbers are made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const NOW = new Date("2026-12-02T10:00:00.000Z");
const PAGES = ["https://acme.example/blog/desk-back-pain", "https://acme.example/blog/running-knee", "https://blog.acme.example/guides/heel-pain"].map((url) => ({ url, key: articlePageKey(url)! }));

let db: FakeFirestore;
async function seed(ctx: TenantContext, id: string, connectorId: string, over: { grants?: ConnectionGrant[]; account?: string; createdAt?: string } = {}) {
  const at = over.createdAt ?? "2026-11-01T10:00:00.000Z";
  await createDataConnection(
    ctx,
    {
      id,
      connectorId,
      method: "token_fields",
      label: connectorId,
      account: over.account ?? "acme.example",
      ownerUid: "usr_admin",
      grants: over.grants ?? PLANNING,
      secrets: {},
      health: healthyAt(new Date(at)),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: null,
      collect: freshCollect(at),
    },
    [{ kind: "connected", by: "usr_admin", at }],
    db,
  );
}

const answer = (stream: string, rows: LiveAnswer["rows"], more = false): LiveAnswer => ({
  connectorId: "x",
  connector: "x",
  stream,
  by: "page",
  period: { from: "2026-11-03", to: "2026-11-30", timeZone: "UTC", finalThrough: "2026-11-30", words: "3 to 30 Nov 2026" },
  rows,
  totals: null,
  more,
  meanings: {},
  notes: [],
  asOf: NOW.toISOString(),
});

type Live = NonNullable<OutcomeDeps["live"]>;
function deps(rows: Record<string, { rows: LiveAnswer["rows"]; more?: boolean } | "fail">): { live: ReturnType<typeof vi.fn>; d: OutcomeDeps } {
  const live = vi.fn<Live>(async (_ctx, _actor, id) => {
    const r = rows[id];
    if (!r || r === "fail") return { ok: false as const, status: 502, error: "provider_error" };
    return { ok: true as const, status: 200 as const, value: answer("s", r.rows, r.more) };
  });
  return { live, d: { db, live, catalog: allConnectors, now: NOW } };
}

beforeEach(() => {
  db = new FakeFirestore();
});

describe("joining a connection's rows to the brand's articles", () => {
  const join = pageJoiner(PAGES);
  it("matches by host and path when the row or its account knows the host", () => {
    expect(join({ keys: { page: "/blog/desk-back-pain?utm=x" } }, "sc-domain:acme.example")).toBe("acme.example/blog/desk-back-pain");
    expect(join({ keys: { page: "/blog/running-knee", host: "www.acme.example" } }, "")).toBe("acme.example/blog/running-knee");
    expect(join({ keys: { page: "https://acme.example/blog/running-knee" } }, "")).toBe("acme.example/blog/running-knee");
    // Another site's page with the same path is never the brand's.
    expect(join({ keys: { page: "/blog/running-knee", host: "rival.example" } }, "")).toBeNull();
    expect(join({ keys: { page: "https://rival.example/blog/running-knee" } }, "acme.example")).toBeNull();
  });

  it("matches by path alone only when one article has it, on the account's site or its subdomains", () => {
    // A domain property covers the blog subdomain.
    expect(join({ keys: { page: "/guides/heel-pain" } }, "sc-domain:acme.example")).toBe("blog.acme.example/guides/heel-pain");
    // An Analytics property names no host: the path alone.
    expect(join({ keys: { page: "/guides/heel-pain" } }, "properties/123456")).toBe("blog.acme.example/guides/heel-pain");
    expect(join({ keys: { page: "/guides/heel-pain" } }, "rival.example")).toBeNull();
    expect(join({ keys: { page: "" } }, "acme.example")).toBeNull();
    const twice = pageJoiner([...PAGES, { url: "https://shop.acme.example/blog/running-knee", key: "shop.acme.example/blog/running-knee" }]);
    expect(twice({ keys: { page: "/blog/running-knee" } }, "properties/1")).toBeNull();
    expect(hostOfAccount("properties/1")).toBeNull();
    expect(hostOfAccount("https://www.acme.example/blog/")).toBe("acme.example");
  });
});

describe("a trailing slash never tells two pages apart", () => {
  const slashed = [
    { url: "https://acme.example/blog/post/", key: articlePageKey("https://acme.example/blog/post/")! },
    { url: "https://acme.example/guides/heel", key: articlePageKey("https://acme.example/guides/heel")! },
    { url: "https://acme.example/", key: articlePageKey("https://acme.example/")! },
  ];
  const join = pageJoiner(slashed);
  it("for Search Console rows, Analytics landing pages and full addresses, either way round", () => {
    // Search Console: the article has the slash, the row doesn't.
    expect(join({ keys: { page: "/blog/post" } }, "sc-domain:acme.example")).toBe("acme.example/blog/post/");
    expect(join({ keys: { page: "/blog/post", host: "acme.example" } }, "")).toBe("acme.example/blog/post/");
    // Analytics: a path alone, with the slash where the article has none.
    expect(join({ keys: { page: "/guides/heel/" } }, "properties/123456")).toBe("acme.example/guides/heel");
    expect(join({ keys: { page: "/blog/post" } }, "properties/123456")).toBe("acme.example/blog/post/");
    // An AI answers tool's full addresses.
    expect(join({ keys: { page: "https://acme.example/guides/heel/" } }, "acme.example")).toBe("acme.example/guides/heel");
    expect(join({ keys: { page: "https://acme.example/blog/post" } }, "acme.example")).toBe("acme.example/blog/post/");
    // The home page stays the home page.
    expect(join({ keys: { page: "/" } }, "acme.example")).toBe("acme.example/");
  });
});

describe("readOutcomes", () => {
  it("ranks only the connections actually read for a kind, and is failed only when none was", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example", createdAt: "2026-01-01T00:00:00.000Z" });
    await seed(A, "dcn_cccccccccccccccccccc", "search-console", { account: "sc-domain:acme.example", createdAt: "2026-02-01T00:00:00.000Z" });
    const row = { keys: { page: "/blog/running-knee" }, m: { searchClicks: 5, searchImpressions: 50 } };
    const readOf = (connectionId: string) => ({ connectionId, connectorId: "search-console", connector: "Google Search Console", stream: "search_performance", from: "live" as const, period: null, rows: [row], more: false, notes: [], meanings: {} });
    // The older connection gave no read and no failure this time: the newer one, which was read, counts.
    const one: OutcomeDeps = { db, catalog: allConnectors, now: NOW, read: vi.fn(async () => ({ reads: [readOf("dcn_cccccccccccccccccccc")], failed: [] })) };
    const r = await readOutcomes(A, PAGES, one);
    expect(r.coverage.find((c) => c.kind === "search")).toMatchObject({ state: "measured", connectionId: "dcn_cccccccccccccccccccc", alsoConnected: [{ connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" }] });
    expect(r.byPage["acme.example/blog/running-knee"]).toEqual({ searchClicks: 5, searchImpressions: 50 });
    // Neither was read: failed.
    const none: OutcomeDeps = { ...one, read: vi.fn(async () => ({ reads: [], failed: [] })) };
    expect((await readOutcomes(A, PAGES, none)).coverage.find((c) => c.kind === "search")).toMatchObject({ state: "failed" });
  });

  it("reads each kind from one connection by page over 28 days, joined to the brand's live articles", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example" });
    await seed(A, "dcn_bbbbbbbbbbbbbbbbbbbb", "google-analytics", { account: "properties/123456" });
    const { live, d } = deps({
      dcn_aaaaaaaaaaaaaaaaaaaa: {
        rows: [
          { page: "/blog/desk-back-pain", searchClicks: 30, searchImpressions: 900 },
          { page: "/blog/desk-back-pain?ref=x", searchClicks: 2, searchImpressions: 10 },
          { page: "/pricing", searchClicks: 400, searchImpressions: 9000 },
        ],
      },
      dcn_bbbbbbbbbbbbbbbbbbbb: { rows: [{ landing: "/guides/heel-pain", ga4Sessions: 12, ga4KeyEvents: 3 }] },
    });
    const r = await readOutcomes(A, PAGES, d);
    expect(r.byPage).toEqual({
      "acme.example/blog/desk-back-pain": { searchClicks: 32, searchImpressions: 910 },
      "blog.acme.example/guides/heel-pain": { ga4Sessions: 12, ga4KeyEvents: 3 },
    });
    expect(r.coverage.map((c) => [c.kind, c.state])).toEqual([
      ["search", "measured"],
      ["visits", "measured"],
      ["key_actions", "measured"],
      ["ai_answers", "not_connected"],
    ]);
    expect(r.periods.search).toEqual({ from: "2026-11-03", to: "2026-11-30" });
    expect(r.more).toEqual([]);
    // Read as the brand's monthly job, for the last 28 days, by landing page for Analytics.
    expect(live.mock.calls.every((c) => (c[1] as { job: string }).job === "strategy_month")).toBe(true);
    expect(live.mock.calls.map((c) => c[3])).toEqual(
      expect.arrayContaining([
        { stream: "search_performance", period: "last_28_days", by: "page", limit: 100 },
        { stream: "site_traffic", period: "last_28_days", by: "landing", limit: 100 },
      ]),
    );
  });

  it("says when a read was capped, so its numbers may be low", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example" });
    const { d } = deps({ dcn_aaaaaaaaaaaaaaaaaaaa: { rows: [{ page: "/blog/running-knee", searchClicks: 4, searchImpressions: 40 }], more: true } });
    const r = await readOutcomes(A, PAGES, d);
    expect(r.more).toEqual(["search"]);
    expect(r.byPage["acme.example/blog/running-knee"]).toEqual({ searchClicks: 4, searchImpressions: 40 });
  });

  it("counts each kind from one connection only, the one matching the most articles", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example", createdAt: "2026-01-01T00:00:00.000Z" });
    await seed(A, "dcn_cccccccccccccccccccc", "search-console", { account: "https://blog.acme.example/", createdAt: "2026-02-01T00:00:00.000Z" });
    const { d } = deps({
      dcn_aaaaaaaaaaaaaaaaaaaa: { rows: [{ page: "/blog/running-knee", searchClicks: 1, searchImpressions: 5 }] },
      dcn_cccccccccccccccccccc: {
        rows: [
          { page: "/guides/heel-pain", searchClicks: 7, searchImpressions: 70 },
          { page: "/blog/running-knee", searchClicks: 9, searchImpressions: 90 },
        ],
      },
    });
    const r = await readOutcomes(A, [...PAGES, { url: "https://blog.acme.example/blog/running-knee", key: "blog.acme.example/blog/running-knee" }], d);
    const search = r.coverage.find((c) => c.kind === "search");
    expect(search).toMatchObject({ state: "measured", connectionId: "dcn_cccccccccccccccccccc", alsoConnected: [{ connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" }] });
    // Only the chosen connection's numbers: nothing counted twice.
    expect(r.byPage).toEqual({ "blog.acme.example/guides/heel-pain": { searchClicks: 7, searchImpressions: 70 }, "blog.acme.example/blog/running-knee": { searchClicks: 9, searchImpressions: 90 } });
  });

  it("keeps a whole site source as a site total, never split by page", async () => {
    await seed(A, "dcn_dddddddddddddddddddd", "cloudflare", { account: "0123456789abcdef0123456789abcdef" });
    const { d } = deps({ dcn_dddddddddddddddddddd: { rows: [{ day: "2026-11-01", cfVisits: 40 }, { day: "2026-11-02", cfVisits: 2 }] } });
    const r = await readOutcomes(A, PAGES, d);
    expect(r.site).toEqual({ cfVisits: 42 });
    expect(r.byPage).toEqual({});
    expect(r.coverage.find((c) => c.kind === "visits")).toMatchObject({ state: "measured", siteOnly: true, measure: "cfVisits" });
  });

  it("leaves a kind whose read failed out with its code, and reads the rest", async () => {
    await seed(A, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example" });
    await seed(A, "dcn_eeeeeeeeeeeeeeeeeeee", "vizzybl", { account: "acme.example" });
    const { d } = deps({ dcn_aaaaaaaaaaaaaaaaaaaa: "fail", dcn_eeeeeeeeeeeeeeeeeeee: { rows: [{ page: "/blog/running-knee", url: "https://acme.example/blog/running-knee", domain: "acme.example", aiCitations: 5 }] } });
    const r = await readOutcomes(A, PAGES, d);
    expect(r.coverage.find((c) => c.kind === "search")).toMatchObject({ state: "failed", connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" });
    expect(r.failed).toEqual([{ kind: "search", connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", code: "provider_error" }]);
    expect(r.coverage.find((c) => c.kind === "ai_answers")).toMatchObject({ state: "measured", connectorId: "vizzybl" });
  });

  it("never reads another brand's connections, nor one not shared with the team and Vizzy", async () => {
    await seed(B, "dcn_aaaaaaaaaaaaaaaaaaaa", "search-console", { account: "sc-domain:acme.example" });
    await seed(A, "dcn_ffffffffffffffffffff", "google-analytics", { account: "properties/1", grants: [{ to: "members", can: "read" }] });
    const { live, d } = deps({ dcn_aaaaaaaaaaaaaaaaaaaa: { rows: [{ page: "/blog/running-knee", searchClicks: 9, searchImpressions: 9 }] } });
    const r = await readOutcomes(A, PAGES, d);
    expect(live).not.toHaveBeenCalled();
    expect(r.byPage).toEqual({});
    expect(r.coverage.find((c) => c.kind === "search")!.state).toBe("not_connected");
    expect(r.coverage.find((c) => c.kind === "key_actions")).toMatchObject({ state: "not_shared", connectionId: "dcn_ffffffffffffffffffff" });
    expect((await liveCoverage(B, { db, catalog: allConnectors })).find((c) => c.kind === "search")).toMatchObject({ state: "measured", connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" });
  });
});

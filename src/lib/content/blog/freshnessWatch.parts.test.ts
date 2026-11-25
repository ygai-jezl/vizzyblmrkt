import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rolledId } from "@/lib/connectors/keys";
import { addDays } from "@/lib/connectors/period";
import { putSnapshot, ttlFor } from "@/lib/connectors/snapshots";
import { OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedPart, seedSource, seedTenant, US_BRAND, USE_US, type OrgWorld } from "@/lib/connectors/testing/organisation";
import { LAST_DAY, seedSuggestion } from "@/lib/connectors/testing/signals";
import { changeOrganisationConnection, type TenantContext } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { freshCollect } from "@/lib/types/dataConnection";
import type { Tenant } from "@/lib/types/tenant";
import { sweepBrand } from "./freshnessWatch";
import { FRESH, seedLiveArticle } from "./testing/freshness";

// Article freshness reads a brand's part (Connectors 3) only while partLive honours it, with the
// watch's own Search Console reads, nothing stubbed but link checks: Fernhill Group's Search
// Console gives Fernhill US its site. The organisation's connection is kept in Fernhill US's own
// region here, because the watch reads through one database (in production each read finds its own
// region). Every page, search and number is made up.
const CTX: TenantContext = { ...US_BRAND, source: "system" };
const SITE = "sc-domain:fernhill.example";
const PAGE = "/care/fiddle-leaf-fig";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const DAY = 86_400_000;
const TENANT = { id: US_BRAND.tenantId, region: US_BRAND.region, status: "active" } as Tenant;

let w: OrgWorld;

beforeEach(async () => {
  for (const name of ["CONNECTORS_ENABLED", "PLANS_ENABLED", "CONNECTORS_SHARING_ENABLED", "CONNECTORS_COLLECT_ENABLED", "CONNECTOR_SIGNALS_ENABLED", "CONNECTOR_SEARCH_CONSOLE_ENABLED"]) {
    vi.stubEnv(name, "true");
  }
  for (const name of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED"]) vi.stubEnv(name, "true");
  w = orgWorld();
  seedFernhill(w);
  const source = await seedSource(w, {
    region: "us",
    connectedFromTenantId: US_BRAND.tenantId,
    connectorId: "search-console",
    method: "share_access",
    label: "Search Console",
    serviceAccount: { email: "ygc-aaaaaaaaaaaaaaaaaaaa@made-up-identities.iam.gserviceaccount.com", uniqueId: "1001", createdAt: "2026-11-01T00:00:00.000Z", deletedAt: null },
  });
  await seedPart(w, source, US_BRAND, {
    useId: USE_US,
    account: SITE,
    connectorId: "search-console",
    method: "share_access",
    collect: { ...freshCollect(null, 0), lastDay: LAST_DAY, finalThrough: LAST_DAY, backfilledTo: addDays(LAST_DAY, -89), filled: true, timeZone: "America/Los_Angeles", rolledOn: "2026-11-23" },
  });
  seedLiveArticle(CTX, w.us, { body: "# How often should I water a fiddle leaf fig?\n\nWater it when the top few centimetres of soil are dry." });
  // The part's last 28 days of pages, at its collect generation: the article's page sits just off page one.
  await putSnapshot(
    CTX,
    rolledId(USE_US, 0, "search_performance", "page", "r28"),
    {
      connectionId: USE_US,
      gen: 0,
      account: SITE,
      connectorId: "search-console",
      stream: "search_performance",
      by: "page",
      day: null,
      window: { from: addDays(LAST_DAY, -27), to: LAST_DAY },
      days: 28,
      timeZone: "America/Los_Angeles",
      final: true,
      totals: null,
      rows: [{ key: PAGE, host: "fernhill.example", m: { searchPosition: 9.4, searchImpressions: 1900, searchClicks: 40 } }],
      rowsSeen: 1,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: "2026-11-23T09:00:00.000Z",
      ttlAt: ttlFor(LAST_DAY, 90),
    },
    { db: w.us },
  );
  // And the part's open "losing clicks" suggestion about the same page, still waiting in Review.
  await seedSuggestion(CTX, w.us, USE_US, "losing", { account: SITE, now: new Date() });
});
afterEach(() => vi.unstubAllEnvs());

const sweepOn = (day: number) => sweepBrand(CTX, TENANT, { db: w.us, now: () => new Date(NOW.getTime() + day * DAY), rand: () => 0, checkLink: async () => "ok" });
const reasons = async () => ((await getContentPlan(CTX, FRESH.workspaceId, FRESH.planId, w.us))!.graph.nodes[0]!.blog!.freshness?.reasons ?? []).map((r) => r.kind);
const FROM_PART = ["losing_clicks", "within_reach"];
const setParts = (state: "pending" | "active") =>
  changeOrganisationConnection(ORG, OCN, "us", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state })) }, activity: [] }), { regionDb: w.regionDb });

describe("article freshness and a brand's part", () => {
  it("weighs a live part's numbers, and on a later look none once the part reads nothing", async () => {
    const first = await sweepOn(0);
    expect(await reasons()).toEqual(expect.arrayContaining(FROM_PART));
    expect(first.due[0]!.reasons.find((r) => r.kind === "within_reach")?.detail).toBe("Search Console: position 9 on average, 1,900 impressions in 28 days. A refresh could lift it onto page one.");

    // Sharing turned off in this copy: the next day's look reads nothing from the part.
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    const off = await sweepOn(1);
    expect((await reasons()).filter((k) => FROM_PART.includes(k))).toEqual([]);
    expect(off.due.flatMap((d) => d.reasons.map((r) => r.kind)).filter((k) => FROM_PART.includes(k))).toEqual([]);
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    await sweepOn(2);
    expect(await reasons()).toEqual(expect.arrayContaining(FROM_PART));

    // The give not finished (pending): nothing.
    await setParts("pending");
    await sweepOn(3);
    expect((await reasons()).filter((k) => FROM_PART.includes(k))).toEqual([]);
    await setParts("active");
    await sweepOn(4);
    expect(await reasons()).toEqual(expect.arrayContaining(FROM_PART));

    // Fernhill US leaves Fernhill Group: nothing, before the lane has even ended the part.
    seedTenant(w, US_BRAND, OTHER_ORG);
    const left = await sweepOn(5);
    expect((await reasons()).filter((k) => FROM_PART.includes(k))).toEqual([]);
    expect(left.due.flatMap((d) => d.reasons.map((r) => r.kind)).filter((k) => FROM_PART.includes(k))).toEqual([]);
  });
});

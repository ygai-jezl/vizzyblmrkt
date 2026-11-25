import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrganisationConnection, type SourceRef, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { freshCollect, type DataConnection } from "@/lib/types/dataConnection";
import type { PartFacts } from "@/lib/connectors/sources";
import { brandDeps, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedOrganisation, seedPart, seedSource, seedTenant, T0, US_BRAND, USE_US, type OrgWorld } from "@/lib/connectors/testing/organisation";
import { connectedHref, dataSourceItem, dataSourceItems, loadReview, ORGANISATION_HREF, partSourceItem, resetReviewCountCache } from "./summary";

// Review's data source item for a brand's part (Connectors 3, group 3): Fernhill US [made up], kept
// in the United States, reads Google Analytics 4 through Fernhill Group's Google sign in, kept in
// Europe. Priya owns Fernhill Group; Leo is Fernhill US's admin and not an owner.
const NOW = new Date("2026-11-24T12:00:00.000Z");
const PROPERTY = "properties/987654321";
const priya: TenantContext = { ...US_BRAND, source: "idtoken", userId: "usr_priya", role: "admin" };
const leo: TenantContext = { ...priya, userId: "usr_leo" };
const sam: TenantContext = { ...priya, userId: "usr_sam", role: "member" };
const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

const facts = (over: Partial<PartFacts> = {}): PartFacts => ({ reads: "live", live: true, since: null, organisation: "Fernhill Group", brand: "Fernhill US", ...over });
const record = (over: Partial<DataConnection> = {}): DataConnection => ({
  id: USE_US,
  tenantId: US_BRAND.tenantId,
  connectorId: "google-analytics",
  method: "oauth_pkce",
  label: "Fernhill US web",
  account: PROPERTY,
  ownerUid: "usr_priya",
  grants: [],
  secrets: {},
  health,
  pausedAt: null,
  pausedBy: null,
  recent: [],
  status: "connected",
  createdAt: T0,
  updatedAt: T0,
  disconnectedAt: null,
  source: { organisationId: ORG, connectionId: OCN, region: "eu" },
  ...over,
});

beforeEach(() => {
  resetReviewCountCache();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
  // A way to connect ready on this copy, so the connector is offered.
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("a part's data source item", () => {
  it("names the organisation when its sign in needs attention: Fix for an owner, See it for anyone else", () => {
    const source = facts({ reads: "source", since: "2026-11-21T07:00:00.000Z" });
    expect(partSourceItem(record(), { facts: source, owner: true }, NOW)).toEqual({
      id: `data_source:${USE_US}`,
      kind: "data_source",
      title: "Google Analytics 4 from Fernhill Group can't be read since 21 Nov",
      detail: "An owner of Fernhill Group can fix it.",
      href: ORGANISATION_HREF,
      action: "Fix",
    });
    expect(partSourceItem(record(), { facts: source, owner: false }, NOW)).toMatchObject({ href: connectedHref(USE_US), action: "See it" });
  });

  it("names it when its own part can't be read, from when that began, and Search Console as people name it", () => {
    const lost = record({ connectorId: "search-console", method: "share_access", account: "sc-domain:fernhill-us.example", health: { ...health, state: "broken", lastErrorCode: "share_access_lost", failures: 2, since: "2026-11-22T06:00:00.000Z" } });
    vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
    expect(partSourceItem(lost, { facts: facts(), owner: false }, NOW)).toMatchObject({ title: "Search Console from Fernhill Group can't be read since 22 Nov", detail: "An owner of Fernhill Group can fix it.", action: "See it" });
  });

  it("never asks a brand admin to sign in again, and skips a part that reads nothing on purpose", () => {
    const broken = record({ health: { ...health, state: "broken", lastErrorCode: "signin_refused", failures: 3, since: "2026-11-21T07:00:00.000Z" } });
    // Without its check a part is skipped, never given today's "Reconnect it by signing in with Google again".
    expect(dataSourceItem(broken, NOW)).toBeNull();
    for (const reads of ["off", "pending", "ended", "unknown"] as const) {
      expect(partSourceItem(broken, { facts: facts({ reads, live: false }), owner: true }, NOW), reads).toBeNull();
    }
    // Its owners paused it on purpose: nothing for the brand to do.
    const failing = record({ collect: { ...freshCollect(), failedSince: "2026-11-18T09:00:00.000Z" } });
    expect(partSourceItem(failing, { facts: facts({ reads: "paused" }), owner: true }, NOW)).toBeNull();
  });

  it("lists one failing 3 days or paused by its admins a week, as any connection, in a part's words", () => {
    const failing = record({ collect: { ...freshCollect(), failedSince: "2026-11-20T09:00:00.000Z" } });
    expect(partSourceItem(failing, { facts: facts(), owner: true }, NOW)).toMatchObject({ title: "Google Analytics 4 from Fernhill Group needs you", href: connectedHref(USE_US), action: "Fix" });
    const paused = record({ pausedAt: "2026-11-15T09:00:00.000Z", pausedBy: "usr_leo" });
    expect(partSourceItem(paused, { facts: facts(), owner: false }, NOW)).toMatchObject({
      title: "Google Analytics 4 from Fernhill Group is paused",
      detail: "Paused since 15 Nov, so no new numbers are collected. Resume it, or stop using it if you no longer need it.",
    });
    expect(partSourceItem(record(), { facts: facts(), owner: true }, NOW)).toBeNull();
  });
});

describe("Review's data sources, read across regions", () => {
  let w: OrgWorld;
  let source: SourceRef;
  const deps = () => ({ ...brandDeps(w, US_BRAND), now: NOW });
  const breakSignIn = () =>
    changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { health: { ...health, state: "broken", lastErrorCode: "signin_refused", failures: 3, since: "2026-11-21T07:00:00.000Z" } }, activity: [] }), { regionDb: w.regionDb });

  beforeEach(async () => {
    w = orgWorld();
    seedFernhill(w);
    source = await seedSource(w, { connectorId: "google-analytics", method: "oauth_pkce", label: "Google Analytics 4", signerUid: "usr_priya" });
    await seedPart(w, source, US_BRAND, { useId: USE_US, account: PROPERTY, connectorId: "google-analytics", method: "oauth_pkce" });
  });

  it("finds the part's sign in broken in Europe for a brand kept in the United States, with Fix for its owner", async () => {
    await breakSignIn();
    expect(await dataSourceItems(priya, deps())).toEqual([expect.objectContaining({ title: "Google Analytics 4 from Fernhill Group can't be read since 21 Nov", action: "Fix", href: ORGANISATION_HREF })]);
    expect(await dataSourceItems(leo, deps())).toEqual([expect.objectContaining({ action: "See it", href: connectedHref(USE_US) })]);
    expect(await dataSourceItems(priya, { ...deps(), now: NOW })).toHaveLength(1);
  });

  it("lists nothing for a working part, with sharing or plans off, or once the brand left", async () => {
    expect(await dataSourceItems(priya, deps())).toEqual([]);
    await breakSignIn();
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    expect(await dataSourceItems(priya, deps())).toEqual([]);
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    vi.stubEnv("PLANS_ENABLED", "false");
    expect(await dataSourceItems(priya, deps())).toEqual([]);
    vi.stubEnv("PLANS_ENABLED", "true");
    seedTenant(w, US_BRAND, OTHER_ORG);
    seedOrganisation(w, OTHER_ORG, [US_BRAND.tenantId], ["usr_priya"], "Other Group");
    expect(await dataSourceItems(priya, deps())).toEqual([]);
  });

  it("says See it to an owner of another organisation, who can't fix this one", async () => {
    await breakSignIn();
    seedOrganisation(w, ORG, [US_BRAND.tenantId, "ten_fernhill"], ["usr_someone_else"]);
    expect(await dataSourceItems(priya, deps())).toEqual([expect.objectContaining({ action: "See it" })]);
  });

  it("reads the same from databases that keep dates as Firestore does", async () => {
    await breakSignIn();
    const us = timestampFirestore(w.us);
    const eu = timestampFirestore(w.eu);
    const regionDb = (r: string) => (r === "eu" ? eu : us);
    expect(await dataSourceItems(priya, { db: us, controlDb: us, regionDb: regionDb as never, now: NOW })).toEqual([expect.objectContaining({ title: "Google Analytics 4 from Fernhill Group can't be read since 21 Nov" })]);
  });

  it("goes into Review's list for admins only", async () => {
    // One database for every region, as loadReview takes in tests.
    const db = new FakeFirestore();
    const one: OrgWorld = { us: db, eu: db, asia: db, regionDb: () => db };
    seedFernhill(one);
    const src = await seedSource(one, { connectorId: "google-analytics", method: "oauth_pkce", label: "Google Analytics 4", signerUid: "usr_priya" });
    await seedPart(one, src, US_BRAND, { useId: USE_US, account: PROPERTY, connectorId: "google-analytics", method: "oauth_pkce" });
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { health: { ...health, state: "broken", lastErrorCode: "signin_refused", failures: 3, since: "2026-11-21T07:00:00.000Z" } }, activity: [] }), { regionDb: () => db });
    expect((await loadReview(priya, { lifecycle: false, includeContent: false }, db)).items.map((i) => [i.title, i.action])).toEqual([["Google Analytics 4 from Fernhill Group can't be read since 21 Nov", "Fix"]]);
    expect((await loadReview(sam, { lifecycle: false, includeContent: false }, db)).items).toEqual([]);
  });
});

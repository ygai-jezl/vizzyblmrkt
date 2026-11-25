import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrganisationConnection, forTenant, getOrganisationConnection, listOrganisationConnections, type SourceRef, type TenantContext } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { Region, Tenant } from "@/lib/types/tenant";
import { LANE, runConnectorsLane } from "./collect/tick";
import { clearOrganisationIdForReuse, disconnectEmptiedOrganisation, disconnectOrganisationConnection, endBrandParts, partHousekeeping, sweepOrganisationConnections, sweepStart } from "./organisation";
import { checkPart, PartCache } from "./sources";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, sealConnectorSecret } from "./vault";
import { EU_BRAND, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedOrganisation, seedPart, seedSource, seedTenant, T0, US_BRAND, USE_EU, USE_US, type OrgWorld } from "./testing/organisation";

vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// How shared connections end (Connectors 3): Disconnect at the organisation, moves, reused ids, the
// lane's sweep and repairs, and the brand side of housekeeping. Fernhill Group's Cloudflare token,
// kept in Europe, serves Fernhill Plants (Europe) and Fernhill US (United States). Made-up data only.
const ZONE_US = "0123456789abcdef0123456789abcd01";
const ZONE_EU = "0123456789abcdef0123456789abcd02";
const NOW = new Date("2026-11-24T12:00:00.000Z");

let w: OrgWorld;
let source: SourceRef;
const deps = (over: Record<string, unknown> = {}) => ({ controlDb: w.us, regionDb: w.regionDb, now: NOW, ...over });
const record = async (brand: { tenantId: string; region: Region }, id: string) => (await forTenant({ ...brand, source: "system" }, w.regionDb(brand.region)).dataConnections.getById(id)) as DataConnection | null;
const orgRecord = async (id = OCN, region: "eu" | "us" = "eu") => getOrganisationConnection(ORG, id, region, { regionDb: w.regionDb });
const snapshot = (brand: { tenantId: string; region: Region }, id: string) =>
  w.regionDb(brand.region).seed("metric_snapshots", `${id}_0_zone_day_2026-11-20`, { tenantId: brand.tenantId, connectionId: id, gen: 0, stream: "zone_traffic", by: "day", day: "2026-11-20" });

beforeEach(async () => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", "housekeeping-vault-root-0123456789abcdef");
  w = orgWorld();
  seedFernhill(w);
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE_US });
  await seedPart(w, source, EU_BRAND, { useId: USE_EU, account: ZONE_EU });
  snapshot(US_BRAND, USE_US);
  snapshot(EU_BRAND, USE_EU);
});
afterEach(() => vi.unstubAllEnvs());

describe("Disconnect at the organisation", () => {
  it("ends every brand's part in its own region, erases what each collected, and empties the secrets", async () => {
    const r = await disconnectOrganisationConnection(source, "usr_priya", deps());
    expect(r).toMatchObject({ found: true, disconnected: true, ended: 2, revoked: false, addressDeleted: null });
    expect(await orgRecord()).toMatchObject({ status: "disconnected", secrets: {}, parts: [] });
    for (const [brand, id] of [[US_BRAND, USE_US], [EU_BRAND, USE_EU]] as const) {
      expect(await record(brand, id)).toMatchObject({ status: "disconnected", secrets: {} });
      expect(w.regionDb(brand.region).dump("metric_snapshots").filter((d) => d.connectionId === id)).toEqual([]);
    }
  });

  it("revokes a Google sign in only with its switch, and deletes an organisation's address", async () => {
    const G = "ocn_gggggggggggggggggggg";
    const g = await seedSource(w, {
      id: G,
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Search Console",
      signerUid: "usr_priya",
      secrets: { [ACCESS_SLOT]: sealConnectorSecret(ORG, G, ACCESS_SLOT, "made-up-access"), [REFRESH_SLOT]: sealConnectorSecret(ORG, G, REFRESH_SLOT, "made-up-refresh") },
    });
    const transport = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    expect((await disconnectOrganisationConnection(g, "usr_priya", deps({ transport }), { revoke: true })).revoked).toBe(false);
    expect(transport).not.toHaveBeenCalled();

    const H = "ocn_hhhhhhhhhhhhhhhhhhhh";
    const h = await seedSource(w, { id: H, connectorId: "search-console", method: "oauth_pkce", label: "Search Console", signerUid: "usr_priya", secrets: { [REFRESH_SLOT]: sealConnectorSecret(ORG, H, REFRESH_SLOT, "made-up-refresh-2") } });
    vi.stubEnv("CONNECTOR_GOOGLE_REVOKE_ENABLED", "true");
    expect((await disconnectOrganisationConnection(h, "usr_priya", deps({ transport }), { revoke: true })).revoked).toBe(true);
    expect(String(transport.mock.calls[0]![0])).toContain("oauth2.googleapis.com/revoke");

    const S = "ocn_ssssssssssssssssssss";
    const sa = { email: "ygc-aaaaaaaaaaaaaaaaaaaa@made-up-identities.iam.gserviceaccount.com", uniqueId: "1001", createdAt: T0, deletedAt: null };
    const shared = await seedSource(w, { id: S, connectorId: "search-console", method: "share_access", label: "Search Console", serviceAccount: sa });
    const iam = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    expect((await disconnectOrganisationConnection(shared, "usr_priya", deps({ transport: iam, appToken: async () => "made-up-app-token" }))).addressDeleted).toBe(true);
    expect(String(iam.mock.calls[0]![0])).toBe("https://iam.googleapis.com/v1/projects/made-up-identities/serviceAccounts/1001");
    expect((await orgRecord(S))!.serviceAccount?.deletedAt).toBe(NOW.toISOString());
  });
});

describe("moves never leave a sign in behind", () => {
  it("ends a leaving brand's parts, and keeps the connection for the brands left, wherever they are", async () => {
    // Fernhill Plants, the brand it was connected from, moves out: its sign in stays in Europe for Fernhill US.
    seedTenant(w, EU_BRAND, OTHER_ORG);
    seedOrganisation(w, ORG, [US_BRAND.tenantId]);
    expect(await endBrandParts(EU_BRAND, { fromOrganisationId: ORG, by: "script:ops" }, deps())).toBe(1);
    expect(await record(EU_BRAND, USE_EU)).toMatchObject({ status: "disconnected" });
    expect((await record(EU_BRAND, USE_EU))!.recent[0]).toMatchObject({ kind: "disconnected", code: "left" });
    expect(await disconnectEmptiedOrganisation(ORG, "script:ops", deps())).toBe(0);
    expect(await orgRecord()).toMatchObject({ status: "connected" });
    expect((await orgRecord())!.parts.map((p) => p.tenantId)).toEqual([US_BRAND.tenantId]);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "connected" });
  });

  it("disconnects every connection, in every region, of an organisation a move leaves with no brands", async () => {
    const U = "ocn_uuuuuuuuuuuuuuuuuuuu";
    await seedSource(w, { id: U, region: "us", connectedFromTenantId: US_BRAND.tenantId, secrets: { token: sealConnectorSecret(ORG, U, "token", "made-up") } });
    seedOrganisation(w, ORG, []);
    expect(await disconnectEmptiedOrganisation(ORG, "script:ops", deps())).toBe(2);
    expect((await listOrganisationConnections(ORG, {}, { regionDb: w.regionDb })).map((c) => [c.id, c.status, Object.keys(c.secrets).length])).toEqual(
      expect.arrayContaining([
        [OCN, "disconnected", 0],
        [U, "disconnected", 0],
      ]),
    );
  });

  it("never revokes a Google sign in for a disconnect nobody asked for, even with revoke on", async () => {
    vi.stubEnv("CONNECTOR_GOOGLE_REVOKE_ENABLED", "true");
    const G = "ocn_gggggggggggggggggggg";
    await seedSource(w, { id: G, connectorId: "search-console", method: "oauth_pkce", label: "Search Console", signerUid: "usr_priya", secrets: { [REFRESH_SLOT]: sealConnectorSecret(ORG, G, REFRESH_SLOT, "made-up-refresh") } });
    seedOrganisation(w, ORG, []);
    const transport = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    // A move that empties the organisation, an id taken up again, and the lane's sweep: secrets emptied, nothing revoked.
    expect(await disconnectEmptiedOrganisation(ORG, "script:ops", deps({ transport }))).toBe(2);
    expect(transport).not.toHaveBeenCalled();
    expect((await orgRecord(G))!.secrets).toEqual({});
  });

  it("an emptied organisation taken up again has no live connection and no secret that opens", async () => {
    seedOrganisation(w, ORG, []);
    expect(await clearOrganisationIdForReuse(ORG, "script:ops", deps())).toBe(1);
    const c = (await orgRecord())!;
    expect(c.status).toBe("disconnected");
    expect(c.secrets).toEqual({});
    // Whoever takes the id up finds nothing to open.
    expect(() => openConnectorSecret(ORG, OCN, "token", c.secrets.token!)).toThrow();
  });
});

describe("the brand side of housekeeping", () => {
  const ctx = (b: { tenantId: string; region: Region }): TenantContext => ({ ...b, source: "system" });
  const conns = async (b: { tenantId: string; region: Region }) => forTenant(ctx(b), w.regionDb(b.region)).dataConnections.find();

  it("ends a part on positive evidence (the brand points elsewhere), erasing it, whatever the switches say", async () => {
    seedTenant(w, US_BRAND, OTHER_ORG);
    expect(await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).toEqual({ ended: 1, dropped: 0 });
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
    expect(w.us.dump("metric_snapshots").filter((d) => d.connectionId === USE_US)).toEqual([]);
    expect((await orgRecord())!.parts.map((p) => p.tenantId)).toEqual([EU_BRAND.tenantId]);
  });

  it("ends nothing for a switch, a suspended brand, a pending give or a read error", async () => {
    for (const name of ["CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED", "CONNECTORS_ENABLED"]) vi.stubEnv(name, "false");
    expect(await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).toEqual({ ended: 0, dropped: 0 });
    seedTenant(w, US_BRAND, ORG, { status: "suspended" });
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).ended).toBe(0);
    seedTenant(w, US_BRAND, ORG);
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: "pending" as const })) }, activity: [] }), { regionDb: w.regionDb });
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).ended).toBe(0);
    const down = failingFirestore(w.eu, { collections: ["organisation_connections"] });
    seedTenant(w, US_BRAND, OTHER_ORG);
    seedTenant(w, US_BRAND, ORG);
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps({ regionDb: (r: string) => (r === "eu" ? down : w.regionDb(r as never)) }))).ended).toBe(0);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "connected" });
  });

  it("never ends a part on a stale cache: a part given while the lane ran survives", async () => {
    // The lane's run wide cache read the record when only Fernhill Plants had a part.
    const { endPart } = await import("@/lib/tenant");
    await endPart({ source, brand: US_BRAND, useId: USE_US, by: "usr_priya", at: T0, code: "part_ended" }, { regionDb: w.regionDb });
    const cache = new PartCache();
    expect((await checkPart(ctx(EU_BRAND), (await record(EU_BRAND, USE_EU))!, { ...deps(), partCache: cache })).live).toBe(true);
    // Meanwhile an owner gives Fernhill US a part, all three steps.
    const NEW_US = "dcn_nnnnnnnnnnnnnnnnnnnn";
    await seedPart(w, source, US_BRAND, { useId: NEW_US, account: ZONE_US });
    expect(await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps({ partCache: cache }))).toEqual({ ended: 0, dropped: 0 });
    expect(await record(US_BRAND, NEW_US)).toMatchObject({ status: "connected" });
    expect((await orgRecord())!.parts.find((p) => p.tenantId === US_BRAND.tenantId)).toMatchObject({ useId: NEW_US, state: "active" });
  });

  it("never ends a part on a stale read: a part changed while the lane ran survives, and a real difference still ends", async () => {
    const NEW_ZONE = "0123456789abcdef0123456789abcd03";
    const cache = new PartCache();
    const stale = await conns(US_BRAND);
    expect((await checkPart(ctx(US_BRAND), stale.find((c) => c.id === USE_US)!, { ...deps(), partCache: cache })).live).toBe(true);
    // An owner changes Fernhill US's zone: the brand record and the entry both read the new one, just now.
    w.us.seed("data_connections", USE_US, { ...w.us.raw("data_connections", USE_US)!, account: NEW_ZONE });
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => (p.useId === USE_US ? { ...p, account: NEW_ZONE, stateSince: NOW.toISOString() } : p)) }, activity: [] }), { regionDb: w.regionDb });
    expect((await partHousekeeping(ctx(US_BRAND), stale, deps({ partCache: cache }))).ended).toBe(0);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "connected", account: NEW_ZONE });
    // An entry that names another zone than the brand record reads, for longer than 10 minutes, is evidence.
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => (p.useId === USE_US ? { ...p, account: ZONE_US, stateSince: T0 } : p)) }, activity: [] }), { regionDb: w.regionDb });
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).ended).toBe(1);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
  });

  it("ends a suspended brand's part when its organisation disconnected it, and nothing else of it", async () => {
    seedTenant(w, US_BRAND, ORG, { status: "suspended" });
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).ended).toBe(0);
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { status: "disconnected" }, activity: [] }), { regionDb: w.regionDb });
    expect((await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).ended).toBe(1);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
  });

  it("drops the stale entry of a part whose brand record was disconnected another way", async () => {
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(ctx(US_BRAND), USE_US, () => ({ patch: { status: "disconnected" }, activity: [] }), w.us);
    expect(await partHousekeeping(ctx(US_BRAND), await conns(US_BRAND), deps())).toEqual({ ended: 0, dropped: 1 });
    expect((await orgRecord())!.parts.map((p) => p.tenantId)).toEqual([EU_BRAND.tenantId]);
  });
});

describe("the lane's sweep", () => {
  it("disconnects the connections of an organisation an older build's move left with no brands", async () => {
    // An older build moved both brands out without ending anything.
    seedTenant(w, US_BRAND, OTHER_ORG);
    seedTenant(w, EU_BRAND, OTHER_ORG);
    seedOrganisation(w, ORG, []);
    expect(await sweepOrganisationConnections({ deadlineMs: NOW.getTime() + 25_000, clock: () => NOW.getTime() }, deps())).toEqual({ disconnected: 1, repaired: 0 });
    expect(await orgRecord()).toMatchObject({ status: "disconnected", parts: [] });
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
  });

  it("repairs a half done give, and leaves an organisation with brands connected", async () => {
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => (p.tenantId === US_BRAND.tenantId ? { ...p, state: "pending" as const, stateSince: T0 } : p)) }, activity: [] }), { regionDb: w.regionDb });
    expect(await sweepOrganisationConnections({ deadlineMs: NOW.getTime() + 25_000, clock: () => NOW.getTime() }, deps())).toEqual({ disconnected: 0, repaired: 1 });
    expect((await orgRecord())!.parts.find((p) => p.tenantId === US_BRAND.tenantId)!.state).toBe("active");
    expect((await orgRecord())!.status).toBe("connected");
  });

  it("starts somewhere new each run and wraps round, so every record is reached", async () => {
    expect(sweepStart(0)).toBe("ocn_2");
    expect(sweepStart(30 * 60_000)).toBe("ocn_3");
    expect(new Set(Array.from({ length: 32 }, (_, i) => sweepStart(i * 30 * 60_000))).size).toBe(32);
    // Two emptied organisations' records either side of where this run starts: both are swept.
    const clock = () => NOW.getTime();
    const start = sweepStart(clock());
    const before = `ocn_2${"a".repeat(19)}`;
    const after = `ocn_z${"a".repeat(19)}`;
    expect(before < start && after > start).toBe(true);
    seedOrganisation(w, "org_ten_gone", [], [], "Gone Co");
    for (const id of [before, after]) await seedSource(w, { id, organisationId: "org_ten_gone", connectedFromTenantId: "ten_gone" });
    expect((await sweepOrganisationConnections({ deadlineMs: clock() + 25_000, clock }, deps())).disconnected).toBe(2);
    for (const id of [before, after]) expect((await getOrganisationConnection("org_ten_gone", id, "eu", { regionDb: w.regionDb }))!.status).toBe("disconnected");
  });

  it("decides nothing when the organisation can't be read", async () => {
    const control = failingFirestore(w.us, { collections: ["organisations"] });
    expect(await sweepOrganisationConnections({ deadlineMs: NOW.getTime() + 25_000, clock: () => NOW.getTime() }, deps({ controlDb: control }))).toEqual({ disconnected: 0, repaired: 0 });
    expect((await orgRecord())!.status).toBe("connected");
  });
});

describe("the lane with shared connections", () => {
  const LANE_TICK = 7 * LANE.TICK_MS;
  const tenants = (): Promise<Tenant[]> =>
    Promise.resolve([
      { id: US_BRAND.tenantId, region: "us", status: "active", organisationId: ORG } as Tenant,
      { id: EU_BRAND.tenantId, region: "eu", status: "active", organisationId: ORG } as Tenant,
    ]);
  const lane = (over: Record<string, unknown> = {}) =>
    runConnectorsLane({ deadlineMs: LANE_TICK + 25_000 }, { ...deps(), clock: () => LANE_TICK, listTenants: tenants, collect: vi.fn(async () => ({ status: "nothing" as const, days: 0 })), log: () => {}, ...over });

  it("skips parts quietly while sharing or plans are off, and turning them back on leaves every part as it was", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
    for (const off of ["CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED"]) {
      vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
      vi.stubEnv("PLANS_ENABLED", "true");
      vi.stubEnv(off, "false");
      const collect = vi.fn(async () => ({ status: "nothing" as const, days: 0 }));
      const r = await lane({ collect });
      expect(collect).not.toHaveBeenCalled();
      expect(r).toMatchObject({ brands: 2, failed: 0, partsEnded: 0 });
    }
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    vi.stubEnv("PLANS_ENABLED", "true");
    const collect = vi.fn(async () => ({ status: "nothing" as const, days: 0 }));
    await lane({ collect });
    expect(collect).toHaveBeenCalledTimes(2);
    expect((await orgRecord())!.parts.map((p) => p.state)).toEqual(["active", "active"]);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "connected" });
  });

  it("never puts a Google Analytics part's numbers in a Search Console suggestion while the part reads nothing", async () => {
    for (const on of ["CONNECTORS_ENABLED", "CONNECTORS_COLLECT_ENABLED", "CONNECTOR_SIGNALS_ENABLED", "PLANS_ENABLED"]) vi.stubEnv(on, "true");
    const { createDataConnection } = await import("@/lib/tenant");
    const { freshCollect } = await import("@/lib/types/dataConnection");
    const G = "ocn_gggggggggggggggggggg";
    const GA_US = "dcn_gggggggggggggggggggg";
    const SC_US = "dcn_ssssssssssssssssssss";
    const ga = await seedSource(w, { id: G, connectorId: "google-analytics", method: "share_access", label: "Google Analytics 4" });
    await seedPart(w, ga, US_BRAND, { useId: GA_US, account: "properties/123456789", connectorId: "google-analytics", method: "share_access" });
    const grants = [
      { to: "members" as const, can: "read" as const },
      { to: "agent:vizzy" as const, can: "read" as const },
    ];
    const today = new Date(LANE_TICK).toISOString().slice(0, 10);
    await createDataConnection(
      { ...US_BRAND, source: "system" },
      {
        id: SC_US,
        connectorId: "search-console",
        method: "share_access",
        label: "Search Console",
        account: "sc-domain:fernhill-us.example",
        ownerUid: "usr_priya",
        grants,
        secrets: {},
        health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
        disconnectedAt: null,
        collect: { ...freshCollect(), lastDay: "1969-12-30", rolledOn: today },
      },
      [],
      w.us,
    );
    const seen: string[][] = [];
    const detect = vi.fn(async (_ctx: unknown, _c: unknown, others: readonly DataConnection[]) => {
      seen.push(others.map((o) => o.id).sort());
      return { status: "nothing" as const, fired: { rising_search: 0, losing_page: 0, within_reach: 0 }, checked: [], proposed: 0, refreshed: 0, stale: 0 };
    });
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    await lane({ detect });
    expect(seen.at(-1)).not.toContain(GA_US);
    expect(seen.at(-1)).toContain(SC_US);
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    await lane({ detect });
    expect(seen.at(-1)).toContain(GA_US);
  });

  it("gives a suspended brand its parts' housekeeping only", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { status: "disconnected" }, activity: [] }), { regionDb: w.regionDb });
    const collect = vi.fn(async () => ({ status: "nothing" as const, days: 0 }));
    const r = await lane({ collect, listTenants: () => Promise.resolve([{ id: US_BRAND.tenantId, region: "us", status: "suspended", organisationId: ORG } as Tenant]) });
    expect(r).toMatchObject({ brands: 0, partsEnded: 1 });
    expect(collect).not.toHaveBeenCalled();
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
  });

  it("ends a part whose brand left and sweeps an emptied organisation, with sharing off", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    seedTenant(w, US_BRAND, OTHER_ORG);
    const r = await lane();
    expect(r.partsEnded).toBe(1);
    expect(await record(US_BRAND, USE_US)).toMatchObject({ status: "disconnected" });
    expect(await record(EU_BRAND, USE_EU)).toMatchObject({ status: "connected" });
  });
});

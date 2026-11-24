import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { failingFirestore } from "./testing/failingFirestore";
import { isStoredTimestamp, timestampFirestore } from "./testing/timestampFirestore";
import { forTenant } from "./repository";
import { TenantValidationError } from "./errors";
import { createDataConnection, DATA_CONNECTIONS, type NewDataConnection } from "./dataConnections";
import {
  changeOrganisationConnection,
  changePart,
  createOrganisationConnection,
  disconnectOrganisationConnectionRecord,
  endPart,
  findOrganisationConnection,
  getOrganisationConnection,
  givePart,
  listOrganisationConnections,
  listRegionOrganisationConnections,
  newOrganisationConnectionId,
  ORGANISATION_CONNECTION_ACTIVITY,
  ORGANISATION_CONNECTIONS,
  purgeOrganisationConnection,
  repairParts,
  REPAIR_AFTER_MS,
  type NewOrganisationConnection,
  type OrganisationStores,
  type SourceRef,
} from "./organisationConnections";
import type { Region } from "@/lib/types/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";

// Made-up organisations and brands: Fernhill Group (org_ten_fernhill) with Fernhill Plants in Europe
// and Fernhill US in the United States; Other Co (org_ten_other) in the United States.
const ORG = "org_ten_fernhill";
const OTHER_ORG = "org_ten_other";
const OCN = "ocn_aaaaaaaaaaaaaaaaaaaa";
const OCN2 = "ocn_bbbbbbbbbbbbbbbbbbbb";
const USE_EU = "dcn_eeeeeeeeeeeeeeeeeeee";
const USE_US = "dcn_uuuuuuuuuuuuuuuuuuuu";
const EU_BRAND = { tenantId: "ten_fernhill", region: "eu" as Region };
const US_BRAND = { tenantId: "ten_fernhill-us", region: "us" as Region };
const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T10:01:00.000Z";
const LATER = new Date(Date.parse(T0) + REPAIR_AFTER_MS + 60_000);
const SITE_EU = "sc-domain:fernhill.example";
const SITE_US = "sc-domain:fernhill-us.example";

const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };
const sealed = { blob: { ct: "Y3Q=", iv: "aXY=", tag: "dGFn" }, encKeyId: "00112233aabbccdd", sealedAt: T0 };

function orgConn(over: Partial<NewOrganisationConnection> = {}): NewOrganisationConnection {
  return {
    id: OCN,
    organisationId: ORG,
    region: "eu",
    connectorId: "search-console",
    method: "oauth_pkce",
    label: "Search Console",
    createdBy: "usr_priya",
    signerUid: "usr_priya",
    connectedFromTenantId: EU_BRAND.tenantId,
    secrets: { access: sealed, refresh: sealed },
    tokenExpiresAt: T0,
    refresh: { leaseId: null, leaseUntil: null },
    health,
    pausedAt: null,
    pausedBy: null,
    status: "connected",
    createdAt: T0,
    updatedAt: T0,
    disconnectedAt: null,
    collectHold: null,
    parts: [],
    ...over,
  };
}

function brandRecord(id: string, account: string): Omit<NewDataConnection, "source"> {
  return {
    id,
    connectorId: "search-console",
    method: "oauth_pkce",
    label: "Search Console",
    account,
    ownerUid: "usr_priya",
    grants: [{ to: "members", can: "read" }],
    secrets: {},
    health,
    pausedAt: null,
    pausedBy: null,
    status: "connected",
    createdAt: T0,
    updatedAt: T0,
    disconnectedAt: null,
  };
}

const SOURCE: SourceRef = { organisationId: ORG, connectionId: OCN, region: "eu" };

let eu: FakeFirestore;
let us: FakeFirestore;
let asia: FakeFirestore;
let stores: OrganisationStores;
/** One fake database per region, as in production. */
const by = (eu_: FakeFirestore, us_: FakeFirestore) => (r: Region) => (r === "eu" ? eu_ : r === "us" ? us_ : asia);
beforeEach(() => {
  eu = new FakeFirestore();
  us = new FakeFirestore();
  asia = new FakeFirestore();
  stores = { regionDb: by(eu, us) };
});

const give = (brand = US_BRAND, useId = USE_US, account = SITE_US, over: Partial<Parameters<typeof givePart>[0]> = {}) =>
  givePart({ source: SOURCE, brand, record: brandRecord(useId, account), recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }], by: "usr_priya", at: T0, ...over }, stores);
const orgRecord = async () => (await getOrganisationConnection(ORG, OCN, "eu", stores))!;

describe("organisation connections: kept where connected, found in every region", () => {
  it("makes an ocn_ id with 20 base32 characters", () => {
    expect(newOrganisationConnectionId()).toMatch(/^ocn_[a-z2-7]{20}$/);
  });

  it("creates the record in the region it was connected from, with its activity, ttlAt a Timestamp in Firestore", async () => {
    const tsEu = timestampFirestore(eu);
    const regionDb = by(tsEu, us);
    await createOrganisationConnection(orgConn(), [{ kind: "connected", by: "usr_priya", at: T0 }], { regionDb });
    expect(eu.raw(ORGANISATION_CONNECTIONS, OCN)).toMatchObject({ organisationId: ORG, region: "eu", status: "connected" });
    expect(us.dump(ORGANISATION_CONNECTIONS)).toEqual([]);
    const row = eu.dump(ORGANISATION_CONNECTION_ACTIVITY)[0]!;
    expect(row).toMatchObject({ organisationId: ORG, connectionId: OCN, kind: "connected" });
    expect(isStoredTimestamp(row.ttlAt)).toBe(true);
    // Read back through Firestore's shape: no date field is read as a Date.
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb }))!.createdAt).toBe(T0);
  });

  it("refuses a record that isn't an organisation's, or a bad id", async () => {
    await expect(createOrganisationConnection(orgConn({ organisationId: "ten_x" }), [], stores)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(createOrganisationConnection(orgConn({ id: "dcn_aaaaaaaaaaaaaaaaaaaa" }), [], stores)).rejects.toBeInstanceOf(TenantValidationError);
  });

  it("finds a connection in any region, and never another organisation's", async () => {
    await createOrganisationConnection(orgConn(), [], stores);
    await createOrganisationConnection(orgConn({ id: OCN2, region: "us", connectedFromTenantId: US_BRAND.tenantId }), [], stores);
    expect((await findOrganisationConnection(ORG, OCN, stores))?.region).toBe("eu");
    expect((await findOrganisationConnection(ORG, OCN2, stores))?.region).toBe("us");
    expect(await findOrganisationConnection(OTHER_ORG, OCN, stores)).toBeNull();
    expect(await getOrganisationConnection(OTHER_ORG, OCN, "eu", stores)).toBeNull();
    expect(await getOrganisationConnection(ORG, OCN, "us", stores)).toBeNull();
    expect((await listOrganisationConnections(ORG, {}, stores)).map((c) => c.id).sort()).toEqual([OCN, OCN2]);
    expect(await listOrganisationConnections(OTHER_ORG, {}, stores)).toEqual([]);
    expect((await listOrganisationConnections(ORG, { connectorId: "ga4" }, stores)).length).toBe(0);
  });

  it("throws when a region can't be read, so a listing never takes silence for none", async () => {
    await createOrganisationConnection(orgConn(), [], stores);
    const broken = failingFirestore(us, { collections: [ORGANISATION_CONNECTIONS] });
    await expect(listOrganisationConnections(ORG, {}, { regionDb: by(eu, broken) })).rejects.toThrow();
  });

  it("lists one region's connected records for the sweep", async () => {
    await createOrganisationConnection(orgConn(), [], stores);
    await createOrganisationConnection(orgConn({ id: OCN2, organisationId: OTHER_ORG, status: "disconnected" }), [], stores);
    expect((await listRegionOrganisationConnections("eu", { connected: true }, stores)).map((c) => c.id)).toEqual([OCN]);
    expect((await listRegionOrganisationConnections("eu", {}, stores)).length).toBe(2);
  });

  it("changes a record only for its own organisation, and never its identity fields", async () => {
    await createOrganisationConnection(orgConn(), [], stores);
    expect(await changeOrganisationConnection(OTHER_ORG, OCN, "eu", () => ({ patch: { label: "x" }, activity: [] }), stores)).toEqual({ ok: false, why: "not_found" });
    const r = await changeOrganisationConnection(
      ORG,
      OCN,
      "eu",
      () => ({ patch: { label: "Renamed", ...({ organisationId: OTHER_ORG, region: "us" } as object) }, activity: [{ kind: "paused", by: "usr_priya", at: T1 }] }),
      stores,
    );
    expect(r.ok).toBe(true);
    expect(eu.raw(ORGANISATION_CONNECTIONS, OCN)).toMatchObject({ organisationId: ORG, region: "eu", label: "Renamed", updatedAt: T1 });
  });
});

describe("giving a part across regions, in three steps", () => {
  beforeEach(async () => {
    await createOrganisationConnection(orgConn(), [], stores);
  });

  it("keeps the part in the sign in's region and the brand record in the brand's", async () => {
    const r = await give();
    expect(r).toMatchObject({ ok: true, active: true });
    // The brand record is in the US database only, with its source naming Europe.
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ tenantId: US_BRAND.tenantId, account: SITE_US, secrets: {}, source: SOURCE });
    expect(eu.raw(DATA_CONNECTIONS, USE_US)).toBeUndefined();
    expect(us.dump("data_connection_activity").map((a) => a.code)).toEqual(["part_given"]);
    // The part is in Europe only.
    const part = (await orgRecord()).parts[0]!;
    expect(part).toMatchObject({ tenantId: US_BRAND.tenantId, region: "us", account: SITE_US, useId: USE_US, state: "active" });
    expect(us.dump(ORGANISATION_CONNECTIONS)).toEqual([]);
    expect((await orgRecord()).recent[0]).toMatchObject({ kind: "part_given", tenantId: US_BRAND.tenantId });
    // Another brand can't see the record.
    expect(await forTenant({ tenantId: "ten_other", region: "us", source: "system" }, us).dataConnections.getById(USE_US)).toBeNull();
  });

  it("gives a brand one part of a connection, and a part once", async () => {
    expect((await give()).ok).toBe(true);
    expect(await give(US_BRAND, "dcn_vvvvvvvvvvvvvvvvvvvv", "sc-domain:other.example")).toEqual({ ok: false, why: "has_part" });
    expect(await give(EU_BRAND, USE_EU, SITE_US)).toEqual({ ok: false, why: "part_given" });
    expect((await orgRecord()).parts).toHaveLength(1);
  });

  it("gives a part once when two owners give it at the same moment", async () => {
    const [a, b] = await Promise.all([give(US_BRAND, USE_US, SITE_US), give(EU_BRAND, USE_EU, SITE_US)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await orgRecord()).parts).toHaveLength(1);
  });

  it("refuses a part the brand already reads with its own connection, and undoes step one", async () => {
    await createDataConnection({ ...US_BRAND, source: "system" }, { ...brandRecord("dcn_wwwwwwwwwwwwwwwwwwww", SITE_US), secrets: {} }, [], us);
    expect(await give()).toEqual({ ok: false, why: "own_connection" });
    expect((await orgRecord()).parts).toEqual([]);
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toBeUndefined();
  });

  it("undoes step one when the extra write of step two refuses", async () => {
    expect(await give(US_BRAND, USE_US, SITE_US, { alsoStage: async () => ({ ok: false, why: "settings_changed" }) })).toEqual({ ok: false, why: "settings_changed" });
    expect((await orgRecord()).parts).toEqual([]);
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toBeUndefined();
  });

  it("writes step two's extra write with the brand record, in the brand's database", async () => {
    const r = await give(US_BRAND, USE_US, SITE_US, {
      alsoStage: async (txn, store) => {
        const ref = store.collection("connection_parts_probe").doc("x");
        await txn.get(ref);
        return { ok: true, stage: () => txn.create(ref, { tenantId: US_BRAND.tenantId }) };
      },
    });
    expect(r.ok).toBe(true);
    expect(us.raw("connection_parts_probe", "x")).toBeDefined();
    expect(eu.raw("connection_parts_probe", "x")).toBeUndefined();
  });

  it("ends the brand record when step three finds the part gone", async () => {
    us.onBeforeCommit = async () => {
      // Between steps: an owner took the pending part back.
      await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { parts: [] }, activity: [] }), stores);
    };
    expect(await give()).toEqual({ ok: false, why: "gone" });
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ status: "disconnected", collect: { erasePending: "all" } });
  });

  it("leaves a give pending, reading nothing, when step three can't be written", async () => {
    const broken = failingFirestore(eu, { collections: [] });
    let calls = 0;
    const flaky: OrganisationStores = {
      regionDb: (r) => {
        if (r !== "eu") return r === "us" ? us : asia;
        calls += 1;
        // Step one reads and writes, then step three fails.
        return calls >= 2 ? failingFirestore(eu, { collections: [ORGANISATION_CONNECTIONS] }) : broken;
      },
    };
    const r = await givePart({ source: SOURCE, brand: US_BRAND, record: brandRecord(USE_US, SITE_US), recordActivity: [], by: "usr_priya", at: T0 }, flaky);
    expect(r).toMatchObject({ ok: true, active: false });
    expect((await orgRecord()).parts[0]!.state).toBe("pending");
  });

  it("refuses a disconnected source, another connector, and another organisation's record", async () => {
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { status: "disconnected" }, activity: [] }), stores);
    expect(await give()).toEqual({ ok: false, why: "not_connected" });
    expect(await givePart({ source: { ...SOURCE, organisationId: OTHER_ORG }, brand: US_BRAND, record: brandRecord(USE_US, SITE_US), recordActivity: [], by: "x", at: T0 }, stores)).toEqual({ ok: false, why: "not_found" });
  });
});

describe("changing and ending a part", () => {
  beforeEach(async () => {
    await createOrganisationConnection(orgConn(), [], stores);
    await give();
  });

  const newSite = "sc-domain:fernhill-shop.example";
  const changeTo = (account: string) => (cur: DataConnection) => ({ patch: { account, collect: { ...(cur.collect ?? ({} as never)), gen: (cur.collect?.gen ?? 0) + 1 } as DataConnection["collect"] }, activity: [{ kind: "account_picked" as const, by: "usr_priya", at: T1, code: "part_changed" }] });

  it("changes the part in three steps: pending with was, the brand record, then active", async () => {
    const r = await changePart({ source: SOURCE, brand: US_BRAND, useId: USE_US, account: newSite, by: "usr_priya", at: T1, plan: changeTo(newSite) }, stores);
    expect(r).toMatchObject({ ok: true, was: SITE_US, active: true });
    expect((await orgRecord()).parts[0]).toMatchObject({ account: newSite, was: null, state: "active" });
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ account: newSite });
  });

  it("puts the old part back when the brand record didn't change", async () => {
    const r = await changePart({ source: SOURCE, brand: US_BRAND, useId: USE_US, account: newSite, by: "usr_priya", at: T1, plan: () => null }, stores);
    expect(r).toMatchObject({ ok: false, why: "unchanged" });
    expect((await orgRecord()).parts[0]).toMatchObject({ account: SITE_US, was: null, state: "active" });
  });

  it("never lets an ordinary change move a part's account, its source or put a secret on it", async () => {
    const ctx = { ...US_BRAND, source: "system" as const };
    const { changeDataConnection } = await import("./dataConnections");
    await changeDataConnection(ctx, USE_US, () => ({ patch: { account: "sc-domain:stolen.example", secrets: { token: sealed }, ...({ source: { ...SOURCE, organisationId: OTHER_ORG } } as object) }, activity: [] }), us);
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ account: SITE_US, secrets: {}, source: SOURCE });
  });

  it("ends a part: ending, the brand record disconnected with everything to erase, then the entry gone", async () => {
    const r = await endPart({ source: SOURCE, brand: US_BRAND, useId: USE_US, by: "usr_priya", at: T1, code: "part_ended" }, stores);
    expect(r).toMatchObject({ ended: true, removed: true });
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ status: "disconnected", secrets: {}, collect: { erasePending: "all" } });
    expect((await orgRecord()).parts).toEqual([]);
    expect((await orgRecord()).recent[0]).toMatchObject({ kind: "part_ended", by: "usr_priya", tenantId: US_BRAND.tenantId });
  });

  it("Stop using still ends the brand record when the sign in's database can't be written", async () => {
    const down: OrganisationStores = { regionDb: by(failingFirestore(eu, { collections: [ORGANISATION_CONNECTIONS] }), us) };
    const r = await endPart({ source: SOURCE, brand: US_BRAND, useId: USE_US, by: "usr_leo", at: T1, code: "stopped_using", evenIfSourceFails: true }, down);
    expect(r).toMatchObject({ ended: true, removed: false });
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ status: "disconnected" });
    // Without it, a take back stops at step one.
    await give(EU_BRAND, USE_EU, SITE_EU);
    await expect(endPart({ source: SOURCE, brand: EU_BRAND, useId: USE_EU, by: "x", at: T1, code: "part_ended" }, { regionDb: by(failingFirestore(eu, { collections: [ORGANISATION_CONNECTIONS] }), failingFirestore(us, { collections: [ORGANISATION_CONNECTIONS] })) })).rejects.toThrow();
  });

  it("disconnects the organisation's record: secrets emptied and every part ending", async () => {
    const r = await disconnectOrganisationConnectionRecord(SOURCE, { by: "usr_priya", at: T1 }, stores);
    expect(r?.before.secrets).toHaveProperty("refresh");
    expect(r?.after).toMatchObject({ status: "disconnected", secrets: {} });
    expect(r?.after.parts.map((p) => p.state)).toEqual(["ending"]);
    expect(await disconnectOrganisationConnectionRecord(SOURCE, { by: "usr_priya", at: T1 }, stores)).toBeNull();
  });

  it("purges a record: activity, secrets and parts gone, one purged row left", async () => {
    const r = await purgeOrganisationConnection(ORG, OCN, "eu", "purge:test", T1, stores);
    expect(r).toMatchObject({ found: true, secretsDeleted: 2 });
    expect(eu.raw(ORGANISATION_CONNECTIONS, OCN)).toMatchObject({ status: "disconnected", secrets: {}, parts: [] });
    expect(eu.dump(ORGANISATION_CONNECTION_ACTIVITY).map((a) => a.kind)).toEqual(["purged"]);
  });
});

describe("repairs, on positive evidence only", () => {
  beforeEach(async () => {
    await createOrganisationConnection(orgConn(), [], stores);
  });

  const seedPart = (over: Record<string, unknown>) =>
    changeOrganisationConnection(
      ORG,
      OCN,
      "eu",
      () => ({ patch: { parts: [{ tenantId: US_BRAND.tenantId, region: "us", account: SITE_US, useId: USE_US, state: "pending", stateSince: T0, was: null, givenBy: "usr_priya", givenAt: T0, endedBy: null, ...over } as never] }, activity: [] }),
      stores,
    );
  const seedBrand = (over: Partial<NewDataConnection> = {}) =>
    us.seed(DATA_CONNECTIONS, USE_US, { ...brandRecord(USE_US, SITE_US), tenantId: US_BRAND.tenantId, recent: [], source: SOURCE, ...over });

  it("leaves a give younger than 10 minutes alone, then makes it active once its brand record reads it", async () => {
    await seedPart({});
    seedBrand();
    expect((await repairParts(await orgRecord(), { by: "system", now: new Date(T1) }, stores))[0]!.outcome).toBe("skipped");
    expect((await repairParts(await orgRecord(), { by: "system", now: LATER }, stores))[0]!.outcome).toBe("activated");
    expect((await orgRecord()).parts[0]!.state).toBe("active");
  });

  it("removes a give stopped after step one (its brand record missing)", async () => {
    await seedPart({});
    expect((await repairParts(await orgRecord(), { by: "system", now: LATER }, stores))[0]!.outcome).toBe("removed");
    expect((await orgRecord()).parts).toEqual([]);
  });

  it("puts a change stopped after step one back on the old part", async () => {
    await seedPart({ account: "sc-domain:new.example", was: SITE_US });
    seedBrand();
    expect((await repairParts(await orgRecord(), { by: "system", now: LATER }, stores))[0]!.outcome).toBe("put_back");
    expect((await orgRecord()).parts[0]).toMatchObject({ account: SITE_US, was: null, state: "active" });
  });

  it("finishes a take back stopped after step one or two", async () => {
    await seedPart({ state: "ending", endedBy: "usr_priya" });
    seedBrand();
    expect((await repairParts(await orgRecord(), { by: "system", now: new Date(T1) }, stores))[0]!.outcome).toBe("finished");
    expect(us.raw(DATA_CONNECTIONS, USE_US)).toMatchObject({ status: "disconnected", collect: { erasePending: "all" } });
    expect((await orgRecord()).parts).toEqual([]);
  });

  it("repairs nothing when the brand's database can't be read", async () => {
    await seedPart({});
    seedBrand();
    const down: OrganisationStores = { regionDb: by(eu, failingFirestore(us, { collections: [DATA_CONNECTIONS] })) };
    expect((await repairParts(await orgRecord(), { by: "system", now: LATER }, down))[0]!.outcome).toBe("skipped");
    expect((await orgRecord()).parts[0]!.state).toBe("pending");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { changeDataConnection, createDataConnection, forTenant, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { ACTIVITY_KINDS, freshCollect } from "@/lib/types/dataConnection";
import type { ConnectorActor } from "./grants";
import { healthyAt } from "./health";
import { LANE, runConnectorsLane } from "./collect/tick";
import { pendingAfter, pendingWith } from "./erase";
import { purgeConnections } from "./purge";
import { disconnect, pickAccount } from "./service";
import { writeDayDoc } from "./snapshots";
import { answer, routedTransport } from "./testing/providers";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { sealConnectorSecret } from "./vault";

// Erasing what a connection collected: Disconnect, Change property, the lane's retry and the
// purge, with the collect switch off throughout. Every site and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const ID = "dcn_ssssssssssssssssssss";
const NOW = new Date("2026-11-23T10:00:00.000Z");
const OLD_SITE = "sc-domain:example.com";
const NEW_SITE = "https://blog.example.com/";
const SITES = { siteEntry: [{ siteUrl: OLD_SITE, permissionLevel: "siteOwner" }, { siteUrl: NEW_SITE, permissionLevel: "siteOwner" }] };

/** The kinds an older build knows: what it can read on a record's recent list. */
const OLD_KINDS = ACTIVITY_KINDS.filter((k) => k !== "collected" && k !== "erased");

let db: FakeFirestore;
const load = async () => (await forTenant(A, db).dataConnections.getById(ID))!;
const kinds = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);
const snapshotsOf = () => db.dump("metric_snapshots").map((d) => `${d.gen}:${d.by}:${d.day}`);
const deps = () => ({ db, transport: routedTransport(() => answer(SITES)).transport, limit: async () => false, log: () => {}, now: NOW, sleep: async () => {} });

async function seed(over: Partial<NewDataConnection> = {}) {
  const at = new Date(NOW.getTime() - 86_400_000);
  await createDataConnection(
    A,
    {
      id: ID,
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Google Search Console",
      account: OLD_SITE,
      ownerUid: "usr_admin",
      grants: [],
      secrets: { [ACCESS_SLOT]: sealConnectorSecret("ten_a", ID, ACCESS_SLOT, "made-up-access", at), [REFRESH_SLOT]: sealConnectorSecret("ten_a", ID, REFRESH_SLOT, "made-up-refresh", at) },
      tokenExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      refresh: { leaseId: null, leaseUntil: null },
      health: healthyAt(at),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      disconnectedAt: null,
      collect: { ...freshCollect(null, 0), lastDay: "2026-11-20", backfilledTo: "2026-11-19", finalThrough: "2026-11-20", filled: true },
      ...over,
    },
    [{ kind: "connected", by: "usr_admin", at: at.toISOString() }],
    db,
  );
}

async function collected(gen: number, days = ["2026-11-19", "2026-11-20"]) {
  const owner = { id: ID, connectorId: "search-console", account: gen ? NEW_SITE : OLD_SITE, gen };
  for (const day of days) {
    for (const by of ["day", "page", "topic"] as const) {
      await writeDayDoc(A, { owner, stream: "search_performance", by, day, timeZone: "America/Los_Angeles", final: true, totals: null, rows: [{ key: "/a", m: { searchClicks: 1 } }], more: false, keepDays: 90 }, { db, now: NOW });
    }
  }
}

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "erase-test-vault-root-0123456789abcdefgh");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
  // Collecting is off: erasing never depends on it.
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("pending erases", () => {
  it("joins and clears what is pending, all winning", () => {
    expect(pendingWith(null, [0])).toEqual([0]);
    expect(pendingWith([0], [2, 0])).toEqual([0, 2]);
    expect(pendingWith([1], "all")).toBe("all");
    expect(pendingAfter([0, 1], [0])).toEqual([1]);
    expect(pendingAfter([0], [0])).toBeNull();
    expect(pendingAfter("all", [0])).toBe("all");
    expect(pendingAfter("all", "all")).toBeNull();
  });
});

describe("Disconnect", () => {
  it("leaves nothing it collected, of any generation, with collect off, and one erased row in the log only", async () => {
    await seed();
    await collected(0);
    await collected(1);
    const r = await disconnect(A, admin, ID, deps());
    expect(r.ok).toBe(true);
    expect(snapshotsOf()).toEqual([]);
    const conn = await load();
    expect(conn.collect).toMatchObject({ erasePending: null, nextAt: null });
    expect(kinds()).toEqual(["connected", "disconnected", "erased:all"]);
    // An older build, which doesn't know the new kinds, still reads the record.
    expect(conn.recent.every((e) => (OLD_KINDS as readonly string[]).includes(e.kind))).toBe(true);
  });
});

describe("Change property", () => {
  it("erases the old site's numbers only, bumps the generation and starts the new 90 days", async () => {
    await seed();
    await collected(0);
    const r = await pickAccount(A, admin, ID, { account: NEW_SITE }, deps());
    expect(r).toMatchObject({ ok: true, value: { details: { account: NEW_SITE } } });
    expect(snapshotsOf()).toEqual([]);
    const c = (await load()).collect!;
    expect(c).toMatchObject({ gen: 1, erasePending: null, leaseId: null, lastDay: null, backfilledTo: null, filled: false, nextAt: NOW.toISOString() });
    expect(kinds()).toEqual(["connected", "account_picked", "erased:old_site"]);
    // The new site's numbers, collected under the new generation, are never touched by an old erase.
    await collected(1);
    await purgeConnections({ ...A, source: "system" }, { apply: false, db });
    expect(snapshotsOf()).toHaveLength(6);
  });

  it("waits while a collect run holds the connection", async () => {
    await seed({ collect: { ...freshCollect(null, 0), leaseId: "run", leaseUntil: new Date(NOW.getTime() + 30_000).toISOString() } });
    await collected(0);
    expect(await pickAccount(A, admin, ID, { account: NEW_SITE }, deps())).toMatchObject({ ok: false, status: 429, error: "busy" });
    expect((await load()).account).toBe(OLD_SITE);
    expect(snapshotsOf()).toHaveLength(6);
  });

  it("starts collecting on the next run when a property is picked the first time", async () => {
    await seed({ account: "", collect: undefined });
    await pickAccount(A, admin, ID, { account: OLD_SITE }, deps());
    expect((await load()).collect).toMatchObject({ gen: 0, nextAt: NOW.toISOString(), erasePending: null });
  });
});

describe("a half done erase", () => {
  it("is tried again by the lane, with collect off", async () => {
    await seed();
    await collected(0);
    await changeDataConnection(A, ID, (cur) => ({ patch: { status: "disconnected", collect: { ...cur.collect!, erasePending: "all" } }, activity: [] }), db);
    const tick = 7 * LANE.TICK_MS;
    const r = await runConnectorsLane({ deadlineMs: tick + 25_000 }, { db, clock: () => tick, listTenants: async () => [{ id: "ten_a", region: "us", status: "active" } as never], log: () => {} });
    expect(r).toMatchObject({ brands: 1, erased: 1, connections: 0 });
    expect(snapshotsOf()).toEqual([]);
    expect((await load()).collect?.erasePending).toBeNull();
  });
});

describe("the purge", () => {
  it("counts collected numbers in a dry run and erases them with every switch off", async () => {
    await seed();
    await collected(0);
    for (const name of ["CONNECTORS_ENABLED", "CONNECTOR_SEARCH_CONSOLE_ENABLED", "CONNECTORS_VAULT_KEY"]) vi.stubEnv(name, "");
    const system = { ...A, source: "system" as const };
    const dry = await purgeConnections(system, { apply: false, db });
    expect(dry.items[0]).toMatchObject({ connectionId: ID, snapshots: 6 });
    expect(snapshotsOf()).toHaveLength(6);
    const done = await purgeConnections(system, { apply: true, by: "ops", now: NOW, db });
    expect(done.removed[0]).toMatchObject({ connectionId: ID, snapshotsDeleted: 6 });
    expect(snapshotsOf()).toEqual([]);
  });
});

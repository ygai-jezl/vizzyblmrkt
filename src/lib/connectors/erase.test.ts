import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import type { SearchStore } from "@/lib/search/types";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { changeDataConnection, createDataConnection, forTenant, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { ACTIVITY_KINDS, freshCollect } from "@/lib/types/dataConnection";
import type { ConnectorActor } from "./grants";
import { healthyAt } from "./health";
import { LANE, runConnectorsLane } from "./collect/tick";
import { eraseConnectionData, pendingAfter, pendingWith } from "./erase";
import { purgeConnections, purgeLines } from "./purge";
import { disconnect, pickAccount } from "./service";
import { writeDayDoc } from "./snapshots";
import { saveDetection, linkAction } from "./signals/store";
import { proposeAgentAction } from "@/lib/tenant";
import { agentDedupeKey, AgentActionSchema } from "@/lib/types/agentAction";
import { answer, routedTransport } from "./testing/providers";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { sealConnectorSecret } from "./vault";

// Tests pass their own index; the default store would reach the search databases.
vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own index");
  },
}));

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
let index: MemorySearchIndex;
const load = async () => (await forTenant(A, db).dataConnections.getById(ID))!;
const kinds = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);
const snapshotsOf = () => db.dump("metric_snapshots").map((d) => `${d.gen}:${d.by}:${d.day}`);
const searchIndex = (ctx: { tenantId: string }) => index.storeFor(ctx);
const deps = () => ({ db, transport: routedTransport(() => answer(SITES)).transport, limit: async () => false, log: () => {}, now: NOW, sleep: async () => {}, searchIndex });

/** This connection's searches in brand search, for a brand (ADR-0013): made-up words and numbers. */
async function indexedSearches(tenantId = "ten_a") {
  const sourceKey = `research:gsc:${ID}`;
  await index.storeFor({ tenantId }).putSource(
    { sourceKey, kind: "research", ref: `gsc:${ID}`, hash: "h", chunks: 1, embedded: true, indexedAt: NOW.toISOString(), version: "2026-W47" },
    [{ tenantId, kind: "research", ref: `gsc:${ID}`, sourceKey, chunk: 0, title: "Google searches: example.com", text: "repot a fig: 120 impressions, 4 clicks, position 8.2", url: "", lang: "en", updatedAt: NOW.toISOString(), embedding: [1, 0, 0] }],
    0,
  );
}
const searchKeys = (tenantId = "ten_a") => [...(index.manifests.get(tenantId)?.keys() ?? [])];

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
  index = new MemorySearchIndex();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "erase-test-vault-root-0123456789abcdefgh");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
  // Collecting, brand search and its searches are off: erasing never depends on them.
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
  vi.stubEnv("CONNECTORS_SEARCH_TEXT_ENABLED", "false");
  vi.stubEnv("SEARCH_INDEX_ENABLED", "false");
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

/** A suggestion from this connection's numbers, open in Review, for generation `gen` (made-up numbers). */
async function suggested(gen: number, page = "/care/fiddle-leaf-fig") {
  const { row } = await saveDetection(
    A,
    { connectionId: ID, gen, account: OLD_SITE, connectorId: "search-console", rule: "losing_page", key: { page, host: "example.com" }, label: page, numbers: { searchClicks: 41 }, before: { searchClicks: 96 }, window: { from: "2026-10-24", to: "2026-11-20" }, shownIn: "review" },
    { db, now: NOW },
  );
  const { action } = await proposeAgentAction(
    A,
    {
      dedupeKey: agentDedupeKey("data_signal.suggest", row.id, "r1"),
      agent: "connector_signals",
      action: "data_signal.suggest",
      target: { type: "data_signal", id: row.id },
      personId: null,
      proposal: { rule: "losing_page", connectionId: ID, gen, label: page },
      basis: null,
      signals: [{ kind: "data_signal", ref: row.id }],
      review: { kind: "data_signal", href: "/admin/approvals#data_signal" },
      requestedBy: { type: "system", id: "connector_signals" },
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
      clearDetailsOnClose: true,
      at: NOW.toISOString(),
    },
    { db },
  );
  await linkAction(A, row.id, action.id, 1, { db });
  return action.id;
}
const states = async () => (await forTenant(A, db).agentActions.find()).map((a) => AgentActionSchema.parse(a)).map((a) => `${a.state}${a.declined ? `:${a.declined.reason}` : ""}${a.proposal ? "" : ":cleared"}`);

describe("suggestions from collected numbers", () => {
  it("leave on Disconnect with signals off: rows deleted, open suggestions declined as stale, values cleared", async () => {
    await seed();
    await suggested(0);
    await suggested(1, "/care/monstera");
    expect(db.dump("data_signals")).toHaveLength(2);
    expect((await disconnect(A, admin, ID, deps())).ok).toBe(true);
    expect(db.dump("data_signals")).toEqual([]);
    expect(await states()).toEqual(["declined:stale:cleared", "declined:stale:cleared"]);
  });

  it("of the old site only on Change property", async () => {
    await seed();
    await suggested(0);
    await pickAccount(A, admin, ID, { account: NEW_SITE }, deps());
    expect(db.dump("data_signals")).toEqual([]);
    await suggested(1, "/care/monstera");
    await eraseConnectionData(A, ID, [0], { by: "system", now: NOW, db, searchIndex });
    expect(db.dump("data_signals")).toHaveLength(1);
    expect((await states()).sort()).toEqual(["declined:stale:cleared", "proposed"]);
  });

  it("are counted by the purge's dry run and go with it", async () => {
    await seed();
    await suggested(0);
    const system = { ...A, source: "system" as const };
    vi.stubEnv("CONNECTORS_ENABLED", "");
    expect((await purgeConnections(system, { apply: false, db, searchIndex })).items[0]).toMatchObject({ signals: 1 });
    const done = await purgeConnections(system, { apply: true, by: "ops", now: NOW, db, searchIndex });
    expect(done.removed[0]).toMatchObject({ signalsDeleted: 1, suggestionsDeclined: 1 });
    expect(purgeLines(done).join("\n")).toContain("1 suggestions removed (1 open, declined)");
    expect(db.dump("data_signals")).toEqual([]);
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
    await purgeConnections({ ...A, source: "system" }, { apply: false, db, searchIndex });
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
    const r = await runConnectorsLane({ deadlineMs: tick + 25_000 }, { db, clock: () => tick, listTenants: async () => [{ id: "ten_a", region: "us", status: "active" } as never], log: () => {}, searchIndex });
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
    const dry = await purgeConnections(system, { apply: false, db, searchIndex });
    expect(dry.items[0]).toMatchObject({ connectionId: ID, snapshots: 6 });
    expect(snapshotsOf()).toHaveLength(6);
    const done = await purgeConnections(system, { apply: true, by: "ops", now: NOW, db, searchIndex });
    expect(done.removed[0]).toMatchObject({ connectionId: ID, snapshotsDeleted: 6 });
    expect(snapshotsOf()).toEqual([]);
  });
});

describe("searches in brand search", () => {
  it("leave on Disconnect with indexing off, from this brand only", async () => {
    await seed();
    await indexedSearches();
    await indexedSearches("ten_b");
    expect(searchKeys()).toEqual([`research:gsc:${ID}`]);
    expect((await disconnect(A, admin, ID, deps())).ok).toBe(true);
    expect(searchKeys()).toEqual([]);
    expect(index.chunks.get("ten_a")?.size ?? 0).toBe(0);
    expect(searchKeys("ten_b")).toEqual([`research:gsc:${ID}`]);
    expect((await load()).collect?.erasePending).toBeNull();
  });

  it("leave on Change property, as the old site's", async () => {
    await seed();
    await indexedSearches();
    await pickAccount(A, admin, ID, { account: NEW_SITE }, deps());
    expect(searchKeys()).toEqual([]);
    expect(kinds()).toEqual(["connected", "account_picked", "erased:old_site"]);
  });

  it("keep the erase pending when they can't be removed, and the lane removes them later", async () => {
    await seed();
    await collected(0);
    await indexedSearches();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = (ctx: { tenantId: string }): SearchStore => ({ ...index.storeFor(ctx), removeSource: async () => Promise.reject(Object.assign(new Error("unavailable"), { code: 14 })) });
    expect((await disconnect(A, admin, ID, { ...deps(), searchIndex: down })).ok).toBe(true);
    // The numbers went; the searches didn't, so nothing is cleared and no erased row is written yet.
    expect(snapshotsOf()).toEqual([]);
    expect(searchKeys()).toEqual([`research:gsc:${ID}`]);
    expect((await load()).collect?.erasePending).toBe("all");
    expect(kinds()).toEqual(["connected", "disconnected"]);
    const tick = 7 * LANE.TICK_MS;
    const lane = (s: typeof searchIndex) =>
      runConnectorsLane({ deadlineMs: tick + 25_000 }, { db, clock: () => tick, listTenants: async () => [{ id: "ten_a", region: "us", status: "active" } as never], log: () => {}, searchIndex: s });
    expect(await lane(down)).toMatchObject({ erased: 0 });
    expect((await load()).collect?.erasePending).toBe("all");
    expect(await lane(searchIndex)).toMatchObject({ erased: 1 });
    expect(searchKeys()).toEqual([]);
    expect((await load()).collect?.erasePending).toBeNull();
    expect(kinds()).toEqual(["connected", "disconnected", "erased:all"]);
    warn.mockRestore();
  });

  it("aren't looked for on a connection that puts none there", async () => {
    await seed({ connectorId: "cloudflare", method: "token_fields", label: "Cloudflare", account: "0123456789abcdef0123456789abcdef", secrets: {} });
    const untouched = vi.fn((): SearchStore => {
      throw new Error("not a Search Console connection");
    });
    expect(await eraseConnectionData(A, ID, "all", { by: "system", now: NOW, db, searchIndex: untouched })).toEqual({ snapshots: 0, signals: 0, declined: 0, search: "skipped" });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("are counted by the purge's dry run and removed by it, with every switch off", async () => {
    await seed();
    await indexedSearches();
    for (const name of ["CONNECTORS_ENABLED", "CONNECTOR_SEARCH_CONSOLE_ENABLED", "CONNECTORS_VAULT_KEY"]) vi.stubEnv(name, "");
    const system = { ...A, source: "system" as const };
    const dry = await purgeConnections(system, { apply: false, db, searchIndex });
    expect(dry.items[0]).toMatchObject({ connectionId: ID, searchEntry: true });
    expect(purgeLines(dry)[0]).toContain("0 collected snapshots, 0 suggestions, its Google searches in brand search");
    expect(searchKeys()).toEqual([`research:gsc:${ID}`]);
    const done = await purgeConnections(system, { apply: true, by: "ops", now: NOW, db, searchIndex });
    expect(done.removed[0]).toMatchObject({ connectionId: ID, searchRemoved: true });
    expect(purgeLines(done).join("\n")).toContain("Google searches removed from brand search");
    expect(searchKeys()).toEqual([]);
    // Run again: nothing is left, and nothing is said about searches.
    const again = await purgeConnections(system, { apply: false, db, searchIndex });
    expect(again.items[0]).toMatchObject({ searchEntry: false });
  });
});

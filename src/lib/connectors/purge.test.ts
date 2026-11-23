import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeDataConnection, createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { purgeActor, purgeConnections, purgeLines } from "./purge";
import { brandTag, copyTag, shareDescription } from "./shareAccess";
import { sealConnectorSecret } from "./vault";

// The search databases: an in-memory index, since every erase removes a Search Console
// connection's searches from brand search whatever SEARCH_INDEX_ENABLED says (ADR-0013).
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// Runs with every connector switch off: the purge must work whatever they say.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T12:00:00.000Z";
const ONE = "dcn_aaaaaaaaaaaaaaaaaaaa";
const TWO = "dcn_bbbbbbbbbbbbbbbbbbbb";
const THEIRS = "dcn_cccccccccccccccccccc";
const blob = { ct: "Y3Q=", iv: "aXY=", tag: "dGFn" };

const conn = (id: string): NewDataConnection => ({
  id,
  connectorId: "cloudflare",
  method: "token_fields",
  label: "Cloudflare",
  account: "0123456789abcdef0123456789abcdef",
  ownerUid: "usr_admin",
  grants: [{ to: "members", can: "read" }],
  secrets: { token: { blob, encKeyId: "00112233aabbccdd", sealedAt: T0 } },
  health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
  pausedAt: null,
  pausedBy: null,
  status: "connected",
  createdAt: T0,
  updatedAt: T0,
  disconnectedAt: null,
});

let db: FakeFirestore;
beforeEach(async () => {
  for (const name of ["CONNECTORS_ENABLED", "CONNECTOR_CLOUDFLARE_ENABLED", "CONNECTORS_VAULT_KEY"]) vi.stubEnv(name, "");
  db = new FakeFirestore();
  for (const [ctx, id] of [[A, ONE], [A, TWO], [B, THEIRS]] as const) {
    await createDataConnection(ctx, conn(id), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
    await changeDataConnection(ctx, id, () => ({ patch: {}, activity: [{ kind: "verified", by: "system", at: T0 }] }), db);
  }
});

afterEach(() => vi.unstubAllEnvs());

const activityOf = (tenantId: string, id: string) => db.dump("data_connection_activity").filter((a) => a.tenantId === tenantId && a.connectionId === id).map((a) => a.kind);

describe("purgeConnections", () => {
  it("counts in a dry run and writes nothing", async () => {
    const before = JSON.stringify([db.dump("data_connections"), db.dump("data_connection_activity")]);
    const r = await purgeConnections(A, { apply: false, db });
    expect(r.items).toEqual([
      { connectionId: ONE, connectorId: "cloudflare", status: "connected", secrets: 1, recent: 2, activity: 2, snapshots: 0, searchEntry: null, address: "none" },
      { connectionId: TWO, connectorId: "cloudflare", status: "connected", secrets: 1, recent: 2, activity: 2, snapshots: 0, searchEntry: null, address: "none" },
    ]);
    expect(r.removed).toEqual([]);
    expect(JSON.stringify([db.dump("data_connections"), db.dump("data_connection_activity")])).toBe(before);
  });

  it("touches only the named connection of the named brand", async () => {
    const r = await purgeConnections(A, { connectionId: ONE, apply: true, by: "ops", now: new Date(T1), db });
    expect(r.removed).toEqual([{ connectionId: ONE, found: true, activityDeleted: 2, secretsDeleted: 1, recentDeleted: 2, revoked: false, addressDeleted: null, snapshotsDeleted: 0, searchRemoved: null }]);
    expect(db.raw("data_connections", ONE)).toMatchObject({ secrets: {}, status: "disconnected", disconnectedAt: T1, recent: [{ kind: "purged", by: "purge:ops", at: T1, code: null }] });
    expect(activityOf("ten_a", ONE)).toEqual(["purged"]);
    // The brand's other connection and another brand's are left alone.
    expect(db.raw("data_connections", TWO)).toMatchObject({ status: "connected", secrets: { token: { encKeyId: "00112233aabbccdd" } } });
    expect(activityOf("ten_a", TWO).sort()).toEqual(["connected", "verified"]);
    expect(db.raw("data_connections", THEIRS)).toMatchObject({ status: "connected" });
    expect(activityOf("ten_b", THEIRS).sort()).toEqual(["connected", "verified"]);
    expect(purgeLines(r).join("\n")).toContain(`${ONE} purged: 1 secrets, 2 recent, 2 activity rows, 0 collected snapshots removed`);
  });

  it("purges every connection of the brand when none is named, and none of another brand's", async () => {
    const r = await purgeConnections(A, { apply: true, by: "ops", now: new Date(T1), db });
    expect(r.removed.map((x) => x.connectionId)).toEqual([ONE, TWO]);
    expect(db.raw("data_connections", THEIRS)?.status).toBe("connected");
  });

  it("finds nothing for another brand's id, and needs a label to apply", async () => {
    const r = await purgeConnections(A, { connectionId: THEIRS, apply: true, by: "ops", db });
    expect(r).toMatchObject({ items: [], removed: [], missing: THEIRS });
    expect(db.raw("data_connections", THEIRS)?.status).toBe("connected");
    await expect(purgeConnections(A, { apply: true, db })).rejects.toThrow("--by takes a short label");
    expect(() => purgeActor("someone@example.com")).toThrow();
    expect(purgeActor("ops_1")).toBe("purge:ops_1");
  });
});

describe("purging a Google sign in", () => {
  const SIGNED = "dcn_dddddddddddddddddddd";
  const signedIn = async () => {
    vi.stubEnv("CONNECTORS_VAULT_KEY", "purge-test-vault-root-0123456789abcdef01");
    await createDataConnection(
      A,
      {
        ...conn(SIGNED),
        connectorId: "search-console",
        method: "oauth_pkce",
        account: "sc-domain:example.com",
        secrets: { access: sealConnectorSecret("ten_a", SIGNED, "access", "made-up-access"), refresh: sealConnectorSecret("ten_a", SIGNED, "refresh", "made-up-refresh") },
        tokenExpiresAt: T1,
        refresh: { leaseId: null, leaseUntil: null },
      },
      [{ kind: "connected", by: "usr_admin", at: T0 }],
      db,
    );
  };

  it("revokes it at Google only with the revoke switch on, after the purge", async () => {
    await signedIn();
    const transport = vi.fn(async () => new Response(null, { status: 200 }));
    const off = await purgeConnections(A, { connectionId: SIGNED, apply: true, by: "ops", now: new Date(T1), db, transport, log: () => {} });
    expect(off.removed[0]).toMatchObject({ connectionId: SIGNED, secretsDeleted: 2, revoked: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it("says so in its lines when it revoked", async () => {
    await signedIn();
    vi.stubEnv("CONNECTOR_GOOGLE_REVOKE_ENABLED", "true");
    const transport = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    const r = await purgeConnections(A, { connectionId: SIGNED, apply: true, by: "ops", now: new Date(T1), db, transport, log: () => {} });
    expect(r.removed[0]).toMatchObject({ revoked: true });
    expect(transport.mock.calls[0]![0]).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(transport.mock.calls[0]![1].body)).toBe("token=made-up-refresh");
    expect(purgeLines(r).join("\n")).toContain("sign in revoked at Google");
    expect(db.raw("data_connections", SIGNED)).toMatchObject({ secrets: {}, status: "disconnected" });
    const dry = await purgeConnections(A, { apply: false, db, transport, log: () => {} });
    expect(dry.removed).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("purging shared connections and leftover Google addresses", () => {
  const PROJECT = "made-up-identities";
  const SHARED = "dcn_eeeeeeeeeeeeeeeeeeee";
  const GONE = "dcn_ffffffffffffffffffff";
  const emailOf = (n: string) => `ygc-${n.repeat(20)}@${PROJECT}.iam.gserviceaccount.com`;

  /** A fake IAM holding the addresses, each tagged for a brand and a connection. */
  function fakeIam(failDeletes = false) {
    const accounts = new Map<string, { email: string; uniqueId: string; description: string }>();
    const add = (uniqueId: string, email: string, tenantId: string, connectionId: string, description = shareDescription(tenantId, connectionId)) =>
      accounts.set(uniqueId, { email, uniqueId, description });
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (init.method === "GET") return new Response(JSON.stringify({ accounts: [...accounts.values()] }), { status: 200 });
      if (init.method === "DELETE") {
        if (failDeletes) return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 });
        accounts.delete(u.pathname.split("/").pop()!);
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 500 });
    });
    return { accounts, add, transport, deps: { transport, appToken: async () => "made-up-app-token", log: () => {} } };
  }

  const sharedConn = async (id: string, uniqueId: string, email: string, status: "connected" | "disconnected" = "connected") => {
    await createDataConnection(
      A,
      {
        ...conn(id),
        connectorId: "search-console",
        method: "share_access",
        account: "sc-domain:example.com",
        secrets: {},
        serviceAccount: { email, uniqueId, createdAt: T0, deletedAt: null },
        status,
        disconnectedAt: status === "disconnected" ? T0 : null,
      },
      [{ kind: "shared", by: "usr_admin", at: T0 }],
      db,
    );
  };

  beforeEach(() => vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT));

  it("lists this brand's leftover addresses in a dry run and deletes nothing", async () => {
    const iam = fakeIam();
    await sharedConn(SHARED, "101", emailOf("a"));
    iam.add("101", emailOf("a"), "ten_a", SHARED);
    iam.add("102", emailOf("b"), "ten_a", "dcn_gggggggggggggggggggg");
    iam.add("103", emailOf("c"), "ten_b", "dcn_hhhhhhhhhhhhhhhhhhhh");
    const r = await purgeConnections(A, { apply: false, db, ...iam.deps });
    expect(r.items.find((i) => i.connectionId === SHARED)?.address).toBe("kept");
    expect(r.orphans).toEqual([{ email: emailOf("b"), connectionId: "dcn_gggggggggggggggggggg", deleted: null }]);
    expect(iam.accounts.size).toBe(3);
    expect(purgeLines(r).join("\n")).toContain(`leftover Google address ${emailOf("b")}`);
  });

  it("deletes a purged connection's address and this brand's orphans, never another brand's", async () => {
    const iam = fakeIam();
    await sharedConn(SHARED, "101", emailOf("a"));
    iam.add("101", emailOf("a"), "ten_a", SHARED);
    iam.add("102", emailOf("b"), "ten_a", "dcn_gggggggggggggggggggg");
    iam.add("103", emailOf("c"), "ten_b", "dcn_hhhhhhhhhhhhhhhhhhhh");
    const r = await purgeConnections(A, { apply: true, by: "ops", now: new Date(T1), db, ...iam.deps });
    expect(r.removed.find((x) => x.connectionId === SHARED)).toMatchObject({ addressDeleted: true });
    expect(r.orphans).toEqual([{ email: emailOf("b"), connectionId: "dcn_gggggggggggggggggggg", deleted: true }]);
    expect([...iam.accounts.keys()]).toEqual(["103"]);
    expect(db.raw("data_connections", SHARED)).toMatchObject({ status: "disconnected", serviceAccount: { deletedAt: T1 } });
  });

  it("never takes another copy's addresses for this brand's leftovers, even for the same tenant id", async () => {
    // Staging and production sharing one identities project, with the same tenant ids.
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "made-up-app-staging");
    const iam = fakeIam();
    iam.add("102", emailOf("b"), "ten_a", "dcn_gggggggggggggggggggg");
    iam.add("105", emailOf("e"), "ten_a", "dcn_jjjjjjjjjjjjjjjjjjjj", shareDescription("ten_a", "dcn_jjjjjjjjjjjjjjjjjjjj", copyTag("made-up-app-prod")));
    // Made before copies were tagged: no copy, so not this copy's to delete.
    iam.add("106", emailOf("k"), "ten_a", "dcn_kkkkkkkkkkkkkkkkkkkk", `YouGrow connected data. connection=dcn_kkkkkkkkkkkkkkkkkkkk brand=${brandTag("ten_a")}`);
    const r = await purgeConnections(A, { apply: true, by: "ops", now: new Date(T1), db, ...iam.deps });
    expect(r.orphans).toEqual([{ email: emailOf("b"), connectionId: "dcn_gggggggggggggggggggg", deleted: true }]);
    expect([...iam.accounts.keys()].sort()).toEqual(["105", "106"]);
  });

  it("retries a failed delete with addresses only, leaving every record's history alone", async () => {
    const iam = fakeIam();
    await sharedConn(GONE, "104", emailOf("d"), "disconnected");
    iam.add("104", emailOf("d"), "ten_a", GONE);
    const before = activityOf("ten_a", ONE).length;
    const r = await purgeConnections(A, { apply: true, by: "ops", now: new Date(T1), db, addressesOnly: true, ...iam.deps });
    expect(r.items.map((i) => i.connectionId)).toEqual([GONE]);
    expect(r.removed).toEqual([{ connectionId: GONE, found: true, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0, revoked: false, addressDeleted: true, snapshotsDeleted: 0, searchRemoved: null }]);
    expect(iam.accounts.size).toBe(0);
    expect(db.raw("data_connections", ONE)?.status).toBe("connected");
    expect(activityOf("ten_a", ONE)).toHaveLength(before);
    expect(activityOf("ten_a", GONE)).toEqual(["shared"]);
  });

  it("records cleanup_failed when Google won't delete, and says to run again", async () => {
    const iam = fakeIam(true);
    await sharedConn(SHARED, "101", emailOf("a"));
    iam.add("101", emailOf("a"), "ten_a", SHARED);
    const r = await purgeConnections(A, { connectionId: SHARED, apply: true, by: "ops", now: new Date(T1), db, ...iam.deps });
    expect(r.removed[0]).toMatchObject({ addressDeleted: false });
    expect(activityOf("ten_a", SHARED)).toEqual(["purged", "cleanup_failed"]);
    expect(db.raw("data_connections", SHARED)).toMatchObject({ serviceAccount: { deletedAt: null } });
    expect(purgeLines(r).join("\n")).toContain("NOT deleted");
  });

  it("skips the identities project when it isn't set, saying why", async () => {
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "");
    const iam = fakeIam();
    const r = await purgeConnections(A, { apply: false, db, ...iam.deps });
    expect(r.shareSkipped).toContain("CONNECTORS_IDENTITIES_PROJECT is not set");
    expect(iam.transport).not.toHaveBeenCalled();
  });
});

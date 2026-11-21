import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeDataConnection, createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { purgeActor, purgeConnections, purgeLines } from "./purge";
import { sealConnectorSecret } from "./vault";

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
      { connectionId: ONE, connectorId: "cloudflare", status: "connected", secrets: 1, recent: 2, activity: 2 },
      { connectionId: TWO, connectorId: "cloudflare", status: "connected", secrets: 1, recent: 2, activity: 2 },
    ]);
    expect(r.removed).toEqual([]);
    expect(JSON.stringify([db.dump("data_connections"), db.dump("data_connection_activity")])).toBe(before);
  });

  it("touches only the named connection of the named brand", async () => {
    const r = await purgeConnections(A, { connectionId: ONE, apply: true, by: "ops", now: new Date(T1), db });
    expect(r.removed).toEqual([{ connectionId: ONE, found: true, activityDeleted: 2, secretsDeleted: 1, recentDeleted: 2, revoked: false }]);
    expect(db.raw("data_connections", ONE)).toMatchObject({ secrets: {}, status: "disconnected", disconnectedAt: T1, recent: [{ kind: "purged", by: "purge:ops", at: T1, code: null }] });
    expect(activityOf("ten_a", ONE)).toEqual(["purged"]);
    // The brand's other connection and another brand's are left alone.
    expect(db.raw("data_connections", TWO)).toMatchObject({ status: "connected", secrets: { token: { encKeyId: "00112233aabbccdd" } } });
    expect(activityOf("ten_a", TWO).sort()).toEqual(["connected", "verified"]);
    expect(db.raw("data_connections", THEIRS)).toMatchObject({ status: "connected" });
    expect(activityOf("ten_b", THEIRS).sort()).toEqual(["connected", "verified"]);
    expect(purgeLines(r).join("\n")).toContain(`${ONE} purged: 1 secrets, 2 recent, 2 activity rows removed`);
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

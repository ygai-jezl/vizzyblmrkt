import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeDataConnection, createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { purgeActor, purgeConnections, purgeLines } from "./purge";

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
    expect(r.removed).toEqual([{ connectionId: ONE, found: true, activityDeleted: 2, secretsDeleted: 1, recentDeleted: 2 }]);
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

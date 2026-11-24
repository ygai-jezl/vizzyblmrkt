import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import {
  ACTIVITY_KEEP_DAYS,
  changeDataConnection,
  countDataConnectionActivity,
  createDataConnection,
  DATA_CONNECTION_ACTIVITY,
  DATA_CONNECTIONS,
  purgeDataConnection,
  RECENT_LIMIT,
  type NewDataConnection,
} from "./dataConnections";
import type { TenantContext } from "./types";

const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const ID = "dcn_abcdefghijklmnopqrst";
const OTHER = "dcn_bcdefghijklmnopqrstu";
const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";

const blob = { ct: "Y3Q=", iv: "aXY=", tag: "dGFn" };
const fresh = (id = ID, over: Partial<NewDataConnection> = {}): NewDataConnection => ({
  id,
  connectorId: "cloudflare",
  method: "token_fields",
  label: "Cloudflare",
  account: "0123456789abcdef0123456789abcdef",
  ownerUid: "usr_admin",
  grants: [],
  secrets: { token: { blob, encKeyId: "00112233aabbccdd", sealedAt: T0 } },
  health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
  pausedAt: null,
  pausedBy: null,
  status: "connected",
  createdAt: T0,
  updatedAt: T0,
  disconnectedAt: null,
  ...over,
});

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("createDataConnection", () => {
  it("writes the record and its activity in one go, with ttlAt a Date 90 days on", async () => {
    const conn = await createDataConnection(A, fresh(), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
    expect(conn.tenantId).toBe("ten_a");
    expect(conn.recent).toEqual([{ at: T0, kind: "connected", by: "usr_admin", code: null }]);
    expect(db.raw(DATA_CONNECTIONS, ID)).toMatchObject({ tenantId: "ten_a", connectorId: "cloudflare", status: "connected" });
    const rows = db.dump(DATA_CONNECTION_ACTIVITY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: "ten_a", connectionId: ID, connectorId: "cloudflare", kind: "connected", by: "usr_admin", code: null });
    expect(rows[0]!.ttlAt).toBeInstanceOf(Date);
    expect((rows[0]!.ttlAt as Date).toISOString()).toBe(new Date(Date.parse(T0) + ACTIVITY_KEEP_DAYS * 86_400_000).toISOString());
    expect(await forTenant(A, db).dataConnections.getById(ID)).toMatchObject({ id: ID, label: "Cloudflare" });
  });

  it("stamps the brand from the context and never overwrites an id another brand holds", async () => {
    await createDataConnection(A, { ...fresh(), tenantId: "ten_b" } as NewDataConnection, [], db);
    expect(db.raw(DATA_CONNECTIONS, ID)?.tenantId).toBe("ten_a");
    await expect(createDataConnection(B, fresh(), [{ kind: "connected", by: "usr_b", at: T0 }], db)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(db.raw(DATA_CONNECTIONS, ID)?.tenantId).toBe("ten_a");
    expect(db.dump(DATA_CONNECTION_ACTIVITY)).toHaveLength(0);
  });

  it("refuses a bad id, a bad activity time and a bad record, writing nothing", async () => {
    await expect(createDataConnection(A, fresh("pcn_1"), [], db)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(createDataConnection(A, fresh(), [{ kind: "connected", by: "usr_admin", at: "yesterday" }], db)).rejects.toThrow("bad_data_connection:at");
    await expect(createDataConnection(A, fresh(ID, { status: "gone" as never }), [], db)).rejects.toThrow("bad_data_connection:status");
    expect(db.dump(DATA_CONNECTIONS)).toHaveLength(0);
  });
});

describe("changeDataConnection", () => {
  beforeEach(async () => {
    await createDataConnection(A, fresh(), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
  });

  it("applies the patch and its activity together, and keeps the identity fields", async () => {
    const r = await changeDataConnection(
      A,
      ID,
      () => ({
        patch: { pausedAt: T1, pausedBy: "usr_admin", tenantId: "ten_b", connectorId: "github", createdAt: T1 } as never,
        activity: [{ kind: "paused", by: "usr_admin", at: T1 }],
      }),
      db,
    );
    expect(r.ok).toBe(true);
    const raw = db.raw(DATA_CONNECTIONS, ID)!;
    expect(raw).toMatchObject({ tenantId: "ten_a", connectorId: "cloudflare", createdAt: T0, pausedAt: T1, updatedAt: T1 });
    expect((raw.recent as { kind: string }[]).map((e) => e.kind)).toEqual(["paused", "connected"]);
    expect(db.dump(DATA_CONNECTION_ACTIVITY).map((x) => x.kind).sort()).toEqual(["connected", "paused"]);
  });

  it("keeps the recent list to the last 20, newest first", async () => {
    for (let i = 0; i < 25; i++) {
      const at = new Date(Date.parse(T1) + i * 60_000).toISOString();
      await changeDataConnection(A, ID, () => ({ patch: {}, activity: [{ kind: "verified", by: "system", at, code: String(i) }] }), db);
    }
    const recent = db.raw(DATA_CONNECTIONS, ID)!.recent as { code: string | null }[];
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]!.code).toBe("24");
    expect(recent.at(-1)!.code).toBe("5");
    expect(db.dump(DATA_CONNECTION_ACTIVITY)).toHaveLength(26);
  });

  it("treats another brand's connection as not found, and writes nothing", async () => {
    const r = await changeDataConnection(B, ID, () => ({ patch: { label: "Mine now" }, activity: [{ kind: "verified", by: "usr_b", at: T1 }] }), db);
    expect(r).toEqual({ ok: false, why: "not_found" });
    expect(await forTenant(B, db).dataConnections.getById(ID)).toBeNull();
    expect(db.raw(DATA_CONNECTIONS, ID)?.label).toBe("Cloudflare");
    expect(db.dump(DATA_CONNECTION_ACTIVITY)).toHaveLength(1);
    expect(await changeDataConnection(A, "not-an-id", () => null, db)).toEqual({ ok: false, why: "not_found" });
  });

  it("keeps what a live read asked on its activity row only, and refuses anything else there", async () => {
    const read = { stream: "zone_daily", by: "day", from: "2026-10-24", to: "2026-11-20", timeZone: "UTC", limit: 50, period: "last_28_days", pageFilter: false };
    await changeDataConnection(A, ID, () => ({ patch: {}, activity: [{ kind: "read", by: "agent:vizzy", at: T1, recent: false, read }] }), db);
    const row = db.dump(DATA_CONNECTION_ACTIVITY).find((x) => x.kind === "read")!;
    expect(row.read).toEqual(read);
    expect((db.raw(DATA_CONNECTIONS, ID)!.recent as Array<Record<string, unknown>>).every((e) => !("read" in e))).toBe(true);
    const bad = async (r: unknown, kind: "read" | "verified" = "read") =>
      changeDataConnection(A, ID, () => ({ patch: {}, activity: [{ kind, by: "agent:vizzy", at: T1, read: r as typeof read }] }), db);
    await expect(bad({ ...read, page: "/pricing" })).rejects.toThrow("bad_data_connection:read");
    await expect(bad({ ...read, limit: 0 })).rejects.toThrow("bad_data_connection:read");
    await expect(bad({ ...read, from: "a very long from value" })).rejects.toThrow("bad_data_connection:read");
    await expect(bad(read, "verified")).rejects.toThrow("bad_data_connection:read");
  });

  it("writes nothing when the plan declines or a patch is bad", async () => {
    const r = await changeDataConnection(A, ID, () => null, db);
    expect(r.ok).toBe(false);
    await expect(
      changeDataConnection(A, ID, () => ({ patch: { status: "gone" as never }, activity: [{ kind: "disconnected", by: "usr_admin", at: T1 }] }), db),
    ).rejects.toThrow("bad_data_connection:status");
    await expect(changeDataConnection(A, ID, () => ({ patch: {}, activity: [{ kind: "nope" as never, by: "x", at: T1 }] }), db)).rejects.toThrow(
      "bad_data_connection:kind",
    );
    expect(db.raw(DATA_CONNECTIONS, ID)?.status).toBe("connected");
    expect(db.dump(DATA_CONNECTION_ACTIVITY)).toHaveLength(1);
  });

  it("plans from the freshest record when another write lands first", async () => {
    db.onBeforeCommit = async () => {
      await db.collection(DATA_CONNECTIONS).doc(ID).update({ label: "Renamed meanwhile" });
    };
    const seen: string[] = [];
    await changeDataConnection(A, ID, (cur) => (seen.push(cur.label), { patch: { pausedAt: T1 }, activity: [{ kind: "paused", by: "usr_admin", at: T1 }] }), db);
    expect(seen).toEqual(["Cloudflare", "Renamed meanwhile"]);
    expect(db.dump(DATA_CONNECTION_ACTIVITY).filter((x) => x.kind === "paused")).toHaveLength(1);
  });
});

describe("purgeDataConnection", () => {
  it("removes only the named connection's secrets, recent list and activity, and leaves one purged row", async () => {
    await createDataConnection(A, fresh(), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
    await createDataConnection(A, fresh(OTHER), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
    await changeDataConnection(A, ID, () => ({ patch: {}, activity: [{ kind: "verified", by: "system", at: T1 }] }), db);
    db.seed(DATA_CONNECTION_ACTIVITY, "dca_other_brand", { tenantId: "ten_b", connectionId: ID, connectorId: "cloudflare", kind: "connected", by: "x", at: T0, code: null });

    expect(await countDataConnectionActivity(A, ID, db)).toBe(2);
    const counts = await purgeDataConnection(A, ID, "purge:ops", T1, db);
    expect(counts).toEqual({ found: true, activityDeleted: 2, secretsDeleted: 1, recentDeleted: 2 });

    const raw = db.raw(DATA_CONNECTIONS, ID)!;
    expect(raw).toMatchObject({ secrets: {}, status: "disconnected", disconnectedAt: T1 });
    expect(raw.recent).toEqual([{ at: T1, kind: "purged", by: "purge:ops", code: null }]);
    const left = db.dump(DATA_CONNECTION_ACTIVITY);
    expect(left.filter((x) => x.connectionId === ID && x.tenantId === "ten_a").map((x) => x.kind)).toEqual(["purged"]);
    expect(left.some((x) => x.tenantId === "ten_b")).toBe(true);
    expect(left.filter((x) => x.connectionId === OTHER)).toHaveLength(1);
    expect(db.raw(DATA_CONNECTIONS, OTHER)?.secrets).toMatchObject({ token: { encKeyId: "00112233aabbccdd" } });
  });

  it("finds nothing for another brand's connection and touches nothing", async () => {
    await createDataConnection(A, fresh(), [{ kind: "connected", by: "usr_admin", at: T0 }], db);
    expect(await purgeDataConnection(B, ID, "purge:ops", T1, db)).toEqual({ found: false, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0 });
    expect(db.raw(DATA_CONNECTIONS, ID)?.status).toBe("connected");
    expect(db.dump(DATA_CONNECTION_ACTIVITY)).toHaveLength(1);
  });
});

describe("forTenant's view of connected data", () => {
  it("gives the records read only and the activity a count, so writes go through the writer", () => {
    const repo = forTenant(A, db);
    expectTypeOf(repo.dataConnections).not.toHaveProperty("create");
    expectTypeOf(repo.dataConnections).not.toHaveProperty("update");
    expectTypeOf(repo.dataConnections).not.toHaveProperty("claim");
    expectTypeOf(repo.dataConnectionActivity).not.toHaveProperty("find");
    expectTypeOf(repo.dataConnectionActivity).toHaveProperty("count");
  });
});

describe("a brand's part of an organisation's connection (Connectors 3)", () => {
  const SOURCE = { organisationId: "org_ten_a", connectionId: "ocn_aaaaaaaaaaaaaaaaaaaa", region: "eu" as const };
  const part = (over: Partial<NewDataConnection> = {}) => fresh(ID, { method: "oauth_pkce", connectorId: "search-console", account: "sc-domain:a.example", secrets: {}, source: SOURCE, ...over });

  it("is never made outside the part writer", async () => {
    await expect(createDataConnection(A, part(), [], db)).rejects.toBeInstanceOf(TenantValidationError);
    expect(db.raw(DATA_CONNECTIONS, ID)).toBeUndefined();
  });

  it("is made by the stage variant only with no secret and no address, beside another write in one transaction", async () => {
    const { stageDataConnectionCreate } = await import("./dataConnections");
    await expect(db.runTransaction(async (txn) => stageDataConnectionCreate(A, part({ secrets: fresh().secrets }), [], txn, db, { part: true }))).rejects.toBeInstanceOf(TenantValidationError);
    await db.runTransaction(async (txn) => {
      stageDataConnectionCreate(A, part(), [{ kind: "connected", by: "usr_admin", at: T0, code: "part_given" }], txn, db, { part: true });
      txn.create(db.collection("probe").doc("p"), { tenantId: "ten_a" });
    });
    expect(db.raw(DATA_CONNECTIONS, ID)).toMatchObject({ tenantId: "ten_a", source: SOURCE, secrets: {} });
    expect(db.raw("probe", "p")).toBeDefined();
  });

  it("keeps its source, its account and no secret whatever a change plans", async () => {
    const { stageDataConnectionCreate, prepareDataConnectionChange } = await import("./dataConnections");
    await db.runTransaction(async (txn) => void stageDataConnectionCreate(A, part(), [], txn, db, { part: true }));
    await changeDataConnection(A, ID, () => ({ patch: { account: "sc-domain:b.example", secrets: fresh().secrets, serviceAccount: { email: "x", uniqueId: "1", createdAt: T0, deletedAt: null }, ...({ source: { ...SOURCE, region: "us" } } as object) }, activity: [] }), db);
    expect(db.raw(DATA_CONNECTIONS, ID)).toMatchObject({ account: "sc-domain:a.example", secrets: {}, serviceAccount: null, source: SOURCE });
    // The part writer alone changes its account, in its own transaction.
    await db.runTransaction(async (txn) => {
      const p = await prepareDataConnectionChange(A, ID, () => ({ patch: { account: "sc-domain:b.example" }, activity: [] }), txn, db, { part: true });
      p.stage();
    });
    expect(db.raw(DATA_CONNECTIONS, ID)?.account).toBe("sc-domain:b.example");
  });

  it("parses with the current schema, and its source is dropped by a parse that doesn't know it", async () => {
    const { DataConnectionSchema } = await import("@/lib/types/dataConnection");
    const { stageDataConnectionCreate } = await import("./dataConnections");
    await db.runTransaction(async (txn) => void stageDataConnectionCreate(A, part(), [{ kind: "connected", by: "usr_admin", at: T0, code: "part_given" }], txn, db, { part: true }));
    const stored = { ...db.raw(DATA_CONNECTIONS, ID)!, id: ID };
    expect(DataConnectionSchema.parse(stored).source).toEqual(SOURCE);
    // An older build's schema (no source): its recent kinds are ones it knows, and the source goes.
    const older = DataConnectionSchema.omit({ source: true });
    const parsed = older.parse(stored) as Record<string, unknown>;
    expect(parsed.source).toBeUndefined();
    expect(parsed.secrets).toEqual({});
  });
});

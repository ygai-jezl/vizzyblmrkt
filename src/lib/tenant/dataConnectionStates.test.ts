import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { shapeRecordingFirestore } from "./testing/queryShape";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { consumeConnectionState, createConnectionState, DATA_CONNECTION_STATES, STATE_VALID_MS, type NewConnectionState } from "./dataConnectionStates";
import type { TenantContext } from "./types";

const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "system" };
const ID = "a".repeat(64);
const T0 = "2026-11-21T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms);
const fresh = (over: Partial<NewConnectionState> = {}): NewConnectionState => ({
  id: ID,
  connectorId: "search-console",
  uid: "usr_admin",
  connectionId: null,
  createdAt: T0,
  ...over,
});
const who = { connectorId: "search-console", uid: "usr_admin" };

/** Every method bound to its own object, with one method swapped. */
function swap<T extends object>(target: T, name: PropertyKey, replacement: unknown): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === name) return replacement;
      const v = Reflect.get(t, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** The fake database, except that deleting a document outside a transaction fails. */
function deletesFail(base: FakeFirestore): FakeFirestore {
  return swap(base, "collection", (name: string) => {
    const c = base.collection(name);
    return swap(c, "doc", (id?: string) => swap(c.doc(id), "delete", async () => Promise.reject(new Error("unavailable"))));
  });
}

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

describe("sign in states", () => {
  it("are made with the brand, a 10 minute expiry and a Date time to live", async () => {
    const made = await createConnectionState(A, fresh(), db);
    expect(made).toEqual({ ...fresh(), tenantId: "ten_a", expiresAt: "2026-11-21T10:10:00.000Z", usedAt: null });
    const raw = db.raw(DATA_CONNECTION_STATES, ID)!;
    expect(raw.tenantId).toBe("ten_a");
    expect(raw.ttlAt).toBeInstanceOf(Date);
    expect((raw.ttlAt as Date).toISOString()).toBe("2026-11-21T10:10:00.000Z");
    expect(STATE_VALID_MS).toBe(600_000);
  });

  it("refuse a bad id, connector, admin, connection or time, and never overwrite an id in any brand", async () => {
    for (const over of [{ id: "short" }, { connectorId: "Search Console" }, { uid: "" }, { connectionId: "pcn_nope" }, { createdAt: "yesterday" }]) {
      await expect(createConnectionState(A, fresh(over), db)).rejects.toBeInstanceOf(TenantValidationError);
    }
    await createConnectionState(A, fresh(), db);
    await expect(createConnectionState(B, fresh(), db)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(db.raw(DATA_CONNECTION_STATES, ID)!.tenantId).toBe("ten_a");
  });

  it("are claimed once, then deleted, so a replay finds nothing", async () => {
    await createConnectionState(A, fresh({ connectionId: "dcn_abcdefghijklmnopqrst" }), db);
    const first = await consumeConnectionState(A, ID, who, at(60_000), db);
    expect(first).toEqual({ ok: true, state: expect.objectContaining({ id: ID, connectionId: "dcn_abcdefghijklmnopqrst", usedAt: "2026-11-21T10:01:00.000Z" }) });
    expect(db.raw(DATA_CONNECTION_STATES, ID)).toBeUndefined();
    expect(await consumeConnectionState(A, ID, who, at(61_000), db)).toEqual({ ok: false, why: "missing" });
  });

  it("refuse a second claim even when the delete failed", async () => {
    await createConnectionState(A, fresh(), db);
    expect((await consumeConnectionState(A, ID, who, at(1000), deletesFail(db))).ok).toBe(true);
    expect(db.raw(DATA_CONNECTION_STATES, ID)!.usedAt).toBe("2026-11-21T10:00:01.000Z");
    expect(await consumeConnectionState(A, ID, who, at(2000), db)).toEqual({ ok: false, why: "used" });
  });

  it("let only one of two racing callbacks claim it", async () => {
    await createConnectionState(A, fresh(), db);
    const results = await Promise.all([consumeConnectionState(A, ID, who, at(1000), db), consumeConnectionState(A, ID, who, at(1000), db)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuse another brand, an expired state, and another admin or connector", async () => {
    await createConnectionState(A, fresh(), db);
    expect(await consumeConnectionState(B, ID, who, at(1000), db)).toEqual({ ok: false, why: "missing" });
    expect(await consumeConnectionState(A, ID, { ...who, uid: "usr_other" }, at(1000), db)).toEqual({ ok: false, why: "mismatch" });
    expect(await consumeConnectionState(A, ID, { ...who, connectorId: "ga4" }, at(1000), db)).toEqual({ ok: false, why: "mismatch" });
    expect(db.raw(DATA_CONNECTION_STATES, ID)!.usedAt).toBeNull();
    expect(await consumeConnectionState(A, ID, who, at(STATE_VALID_MS), db)).toEqual({ ok: false, why: "expired" });
    expect(db.raw(DATA_CONNECTION_STATES, ID)).toBeUndefined();
    expect(await consumeConnectionState(A, "not-an-id", who, at(1000), db)).toEqual({ ok: false, why: "missing" });
  });

  it("are read by id only, so they need no index", async () => {
    const ops: string[] = [];
    const shaped = shapeRecordingFirestore(db, ops);
    await createConnectionState(A, fresh(), shaped);
    await consumeConnectionState(A, ID, who, at(1000), shaped);
    expect(ops).toEqual([]);
  });
});

describe("a sign in for an organisation (Connectors 3)", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
  });
  const OCN = "ocn_aaaaaaaaaaaaaaaaaaaa";

  it("keeps the organisation and the connection signed in again, and finishes only as the organisation's", async () => {
    await createConnectionState(A, fresh({ organisationId: "org_ten_a", sourceId: OCN }), db);
    expect(db.raw(DATA_CONNECTION_STATES, ID)).toMatchObject({ organisationId: "org_ten_a", sourceId: OCN });
    expect(await consumeConnectionState(A, ID, who, at(1000), db)).toEqual({ ok: false, why: "mismatch" });
    expect(await consumeConnectionState(A, ID, { ...who, organisationId: "org_ten_b" }, at(1000), db)).toEqual({ ok: false, why: "mismatch" });
    const r = await consumeConnectionState(A, ID, { ...who, organisationId: "org_ten_a" }, at(1000), db);
    expect(r).toMatchObject({ ok: true, state: { organisationId: "org_ten_a", sourceId: OCN, connectionId: null } });
  });

  it("never finishes a brand's sign in as an organisation's", async () => {
    await createConnectionState(A, fresh(), db);
    expect(await consumeConnectionState(A, ID, { ...who, organisationId: "org_ten_a" }, at(1000), db)).toEqual({ ok: false, why: "mismatch" });
    expect((await consumeConnectionState(A, ID, who, at(1000), db)).ok).toBe(true);
  });

  it("refuses a source without an organisation, a brand connection beside one, or a bad id", async () => {
    await expect(createConnectionState(A, fresh({ sourceId: OCN }), db)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(createConnectionState(A, fresh({ organisationId: "org_ten_a", connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa" }), db)).rejects.toBeInstanceOf(TenantValidationError);
    await expect(createConnectionState(A, fresh({ organisationId: "org_ten_a", sourceId: "dcn_aaaaaaaaaaaaaaaaaaaa" }), db)).rejects.toBeInstanceOf(TenantValidationError);
  });
});

import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { applyProductMessage, type ApplyMessageArgs } from "./productIngest";
import { putConnectionKey, getConnectionKey, deleteConnectionKey } from "./connectionKeys";
import { TenantIsolationError } from "./errors";
import type { TenantContext } from "./types";

const ctxA: TenantContext = { tenantId: "ten_A", region: "us", source: "api_key" };
const ctxB: TenantContext = { tenantId: "ten_B", region: "us", source: "api_key" };

function userDoc(over: Record<string, unknown> = {}) {
  return {
    connectionId: "pcn_1",
    externalUserId: "u1",
    email: "a@acme.test",
    emailNormalized: "a@acme.test",
    traits: {},
    steps: {},
    milestones: {},
    emailPreferences: {},
    status: "active" as const,
    firstSeenAt: "2026-09-21T00:00:00Z",
    lastSeenAt: "2026-09-21T00:00:00Z",
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    ...over,
  };
}

function args(over: Partial<ApplyMessageArgs> = {}): ApplyMessageArgs {
  return {
    eventId: "pe_1",
    userDocId: "pu_1",
    mutate: () => ({ next: userDoc(), applied: true }),
    buildEvent: (applied) => ({
      connectionId: "pcn_1",
      productUserId: "pu_1",
      externalUserId: "u1",
      messageId: "m1",
      type: "identify",
      event: null,
      payload: {},
      timestamp: "2026-09-21T00:00:00Z",
      receivedAt: "2026-09-21T00:00:01Z",
      applied,
    }),
    ...over,
  };
}

describe("applyProductMessage", () => {
  it("writes the event row and the profile together", async () => {
    const db = new FakeFirestore();
    const r = await applyProductMessage(ctxA, args(), db);
    expect(r.outcome).toBe("applied");
    expect(db.raw("product_events", "pe_1")).toMatchObject({ tenantId: "ten_A", applied: true });
    expect(db.raw("product_users", "pu_1")).toMatchObject({ tenantId: "ten_A", email: "a@acme.test" });
  });

  it("treats a replayed message as a duplicate and changes nothing", async () => {
    const db = new FakeFirestore();
    await applyProductMessage(ctxA, args(), db);
    const before = db.writeCountFor("product_users", "pu_1");

    const r = await applyProductMessage(
      ctxA,
      args({ mutate: () => ({ next: userDoc({ email: "changed@acme.test" }), applied: true }) }),
      db,
    );

    expect(r.outcome).toBe("duplicate");
    expect(db.writeCountFor("product_users", "pu_1")).toBe(before);
    expect(db.raw("product_users", "pu_1")).toMatchObject({ email: "a@acme.test" });
  });

  it("records an unchanged message without touching the profile", async () => {
    const db = new FakeFirestore();
    const r = await applyProductMessage(ctxA, args({ mutate: () => ({ next: null, applied: false }) }), db);
    expect(r.outcome).toBe("unchanged");
    expect(db.raw("product_events", "pe_1")).toMatchObject({ applied: false });
    expect(db.raw("product_users", "pu_1")).toBeUndefined();
  });

  it("writes nothing for a rejected message, so it can be resent once fixed", async () => {
    const db = new FakeFirestore();
    const r = await applyProductMessage(ctxA, args({ mutate: () => ({ reject: "user_deleted" }) }), db);
    expect(r).toEqual({ outcome: "rejected", reason: "user_deleted" });
    expect(db.raw("product_events", "pe_1")).toBeUndefined();
  });

  it("refuses a profile or event id that belongs to another tenant", async () => {
    const db = new FakeFirestore();
    db.seed("product_users", "pu_1", { ...userDoc(), tenantId: "ten_B" });
    await expect(applyProductMessage(ctxA, args(), db)).rejects.toBeInstanceOf(TenantIsolationError);

    const db2 = new FakeFirestore();
    await applyProductMessage(ctxB, args(), db2);
    await expect(applyProductMessage(ctxA, args({ userDocId: "pu_other" }), db2)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });
});

describe("connection key routing (control plane)", () => {
  const rec = {
    keyId: "ygk_x",
    tenantId: "ten_A",
    region: "eu" as const,
    connectionId: "pcn_1",
    createdAt: "2026-09-21T00:00:00Z",
  };

  it("never re-points an existing key id", async () => {
    const db = new FakeFirestore();
    await putConnectionKey(rec, db);
    await expect(putConnectionKey({ ...rec, tenantId: "ten_B" }, db)).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    expect(await getConnectionKey("ygk_x", db)).toMatchObject({ tenantId: "ten_A" });
  });

  it("only lets the owning tenant delete a key", async () => {
    const db = new FakeFirestore();
    await putConnectionKey(rec, db);
    await expect(deleteConnectionKey("ygk_x", "ten_B", db)).rejects.toBeInstanceOf(TenantIsolationError);
    await deleteConnectionKey("ygk_x", "ten_A", db);
    expect(await getConnectionKey("ygk_x", db)).toBeNull();
  });
});

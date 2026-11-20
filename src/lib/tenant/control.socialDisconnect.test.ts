import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { deleteTenantSocialConnection } from "./control";

// Disconnecting X removes the webhook map entry only when this brand holds it. Brand B
// connecting an X account that brand A already holds gets held_by_other; B's disconnect
// must leave A's attribution alone.
const X_ID = "1234567890";
const conn = (over: Record<string, unknown> = {}) => ({
  platform: "x",
  enc: { v: 1, iv: "iv", tag: "tag", ct: "ct" },
  handle: "acme",
  userId: X_ID,
  connectedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const tenantDoc = (socialConnections: Record<string, unknown>) => ({
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  updatedAt: "2026-11-01T00:00:00.000Z",
  socialConnections,
});

function seeded(holder: string): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", tenantDoc({ x: conn(), linkedin: conn({ platform: "linkedin", userId: "li_sub_A" }) }));
  db.seed("tenants", "ten_B", tenantDoc({ x: conn() }));
  db.seed("social_subscriptions", `x:${X_ID}`, {
    tenantId: holder,
    region: "us",
    platform: "x",
    userId: X_ID,
    connectedAt: "2026-11-01T00:00:00.000Z",
  });
  db.seed("social_subscriptions", "x:999", { tenantId: "ten_C", region: "us", platform: "x", userId: "999", connectedAt: "2026-11-01T00:00:00.000Z" });
  return db;
}
const connections = (db: FakeFirestore, id: string) =>
  (db.raw("tenants", id)?.socialConnections ?? {}) as Record<string, unknown>;

describe("deleteTenantSocialConnection", () => {
  it("a brand that doesn't hold the X account keeps the holder's attribution", async () => {
    const db = seeded("ten_A");
    await deleteTenantSocialConnection("ten_B", "x", db);
    expect(db.raw("social_subscriptions", `x:${X_ID}`)?.tenantId).toBe("ten_A");
    expect(connections(db, "ten_B").x).toBeUndefined();
    expect(connections(db, "ten_A").x).toBeDefined();
  });

  it("the holder's disconnect removes the attribution and its connection", async () => {
    const db = seeded("ten_A");
    await deleteTenantSocialConnection("ten_A", "x", db);
    expect(db.raw("social_subscriptions", `x:${X_ID}`)).toBeUndefined();
    expect(connections(db, "ten_A").x).toBeUndefined();
    // Freed, not handed over: brand B still has its connection but no attribution.
    expect(connections(db, "ten_B").x).toBeDefined();
  });

  it("a connection with no user id removes only the connection", async () => {
    const db = seeded("ten_A");
    db.seed("tenants", "ten_D", tenantDoc({ x: conn({ userId: undefined }) }));
    await deleteTenantSocialConnection("ten_D", "x", db);
    expect(connections(db, "ten_D").x).toBeUndefined();
    expect(db.raw("social_subscriptions", `x:${X_ID}`)?.tenantId).toBe("ten_A");
  });

  it("leaves other platforms, other tenants and other accounts untouched", async () => {
    const db = seeded("ten_A");
    await deleteTenantSocialConnection("ten_A", "x", db);
    expect(connections(db, "ten_A").linkedin).toBeDefined();
    expect(db.raw("tenants", "ten_B")?.socialConnections).toEqual({ x: conn() });
    expect(db.raw("social_subscriptions", "x:999")?.tenantId).toBe("ten_C");
  });

  it("does nothing for a brand that doesn't exist", async () => {
    const db = seeded("ten_A");
    await deleteTenantSocialConnection("ten_missing", "x", db);
    expect(db.raw("social_subscriptions", `x:${X_ID}`)?.tenantId).toBe("ten_A");
  });
});

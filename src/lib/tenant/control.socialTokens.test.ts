import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { deleteTenantSocialConnection, swapTenantSocialToken } from "./control";
import { getTenantById } from "./registry";

// A social token refresh stores its new token compare-and-set on the token it
// refreshed. A Disconnect that lands while a publish run refreshes is never undone,
// and a partial socialConnections map (which fails TenantSchema.parse and locks
// everyone out of the brand) is never left behind.
const blob = (ct: string) => ({ ct, iv: `${ct}-iv`, tag: `${ct}-tag` });
const x = (over: Record<string, unknown> = {}) => ({
  platform: "x",
  enc: blob("old-ct"),
  refreshEnc: blob("old-refresh"),
  handle: "acme",
  userId: "1234567890",
  scope: "tweet.read tweet.write users.read offline.access",
  expiresAt: "2026-11-20T10:00:00.000Z",
  connectedBy: "usr_admin",
  connectedAt: "2026-11-20T08:00:00.000Z",
  ...over,
});
const linkedin = () => ({
  platform: "linkedin",
  enc: blob("li-ct"),
  handle: "Acme",
  userId: "li_sub_A",
  connectedAt: "2026-11-01T00:00:00.000Z",
});
const tenantDoc = (socialConnections: Record<string, unknown>) => ({
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  allowedOrigins: ["https://example.com"],
  billingTier: "mvp_free",
  ownerId: "usr_owner",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  socialConnections,
});

function seeded(conn: Record<string, unknown> = x()): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", tenantDoc({ x: conn, linkedin: linkedin() }));
  db.seed("tenants", "ten_B", tenantDoc({ x: x() }));
  return db;
}
const stored = (db: FakeFirestore, id = "ten_A") =>
  (db.raw("tenants", id)?.socialConnections ?? {}) as Record<string, Record<string, unknown> | undefined>;
const NEXT = {
  enc: blob("new-ct"),
  refreshEnc: blob("new-refresh"),
  expiresAt: "2026-11-20T12:00:00.000Z",
  scope: "tweet.read tweet.write users.read offline.access media.write",
};
/** Another request disconnects X, as the DELETE route does. */
const disconnect = (db: FakeFirestore) => () => deleteTenantSocialConnection("ten_A", "x", db);

describe("swapTenantSocialToken", () => {
  it("saves the new tokens, expiry and scope, and keeps everything else", async () => {
    const db = seeded();
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db)).toBe("saved");
    expect(stored(db).x).toEqual({ ...x(), ...NEXT });
    expect(db.raw("tenants", "ten_A")?.updatedAt).not.toBe("2026-11-01T00:00:00.000Z");
    expect((await getTenantById("ten_A", db))?.socialConnections?.x?.handle).toBe("acme");
  });

  it("keeps the stored scope when the refresh has none, and stores a null refresh token or expiry", async () => {
    const db = seeded();
    const next = { enc: blob("new-ct"), refreshEnc: null, expiresAt: null, scope: undefined };
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", next, db)).toBe("saved");
    expect(stored(db).x).toMatchObject({ enc: blob("new-ct"), refreshEnc: null, expiresAt: null, scope: x().scope });
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is stale and writes nothing when the stored token is not the one it refreshed", async () => {
    const db = seeded(x({ enc: blob("reconnected-ct") }));
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db)).toBe("stale");
    expect(stored(db).x).toEqual(x({ enc: blob("reconnected-ct") }));
  });

  it("is stale when another request stores a newer token before it commits", async () => {
    const db = seeded();
    db.onBeforeCommit = async () => {
      await db.collection("tenants").doc("ten_A").update({ "socialConnections.x.enc": blob("racer-ct") });
    };
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db)).toBe("stale");
    expect(stored(db).x?.enc).toEqual(blob("racer-ct"));
    expect(stored(db).x?.refreshEnc).toEqual(blob("old-refresh"));
  });

  it("is gone and writes nothing when the account was disconnected", async () => {
    const db = seeded();
    await disconnect(db)();
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db)).toBe("gone");
    expect(stored(db).x).toBeUndefined();
    expect(Object.keys(stored(db))).toEqual(["linkedin"]);
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is gone when a Disconnect lands before it commits, and never brings the account back", async () => {
    const db = seeded();
    db.onBeforeCommit = disconnect(db);
    expect(await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db)).toBe("gone");
    // No partial map: not even the dotted fields of the new token.
    expect(stored(db).x).toBeUndefined();
    const tenant = await getTenantById("ten_A", db);
    expect(tenant).not.toBeNull();
    expect(tenant?.socialConnections?.x).toBeUndefined();
  });

  it("is gone for a brand that doesn't exist", async () => {
    const db = seeded();
    expect(await swapTenantSocialToken("ten_missing", "x", "old-ct", NEXT, db)).toBe("gone");
    expect(db.raw("tenants", "ten_missing")).toBeUndefined();
  });

  it("leaves other platforms and other brands untouched", async () => {
    const db = seeded();
    await swapTenantSocialToken("ten_A", "x", "old-ct", NEXT, db);
    expect(stored(db).linkedin).toEqual(linkedin());
    expect(stored(db, "ten_B").x).toEqual(x());
  });
});

import { describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  clearTenantGitReconnect,
  markTenantGitReconnect,
  setTenantGitRepos,
  swapTenantGitToken,
} from "./control";
import { getTenantById } from "./registry";

// Every write to a stored git token, its reconnect mark or its repo choices is a
// compare-and-set transaction: it never writes onto a deleted connection (a partial
// map fails TenantSchema.parse and locks everyone out of the brand), and a slower
// request never overwrites or marks a token another request has just refreshed.
const blob = (ct: string) => ({ ct, iv: `${ct}-iv`, tag: `${ct}-tag` });
const REPO = {
  fullPath: "acme/app",
  owner: "acme",
  private: true,
  defaultBranch: "main",
  webUrl: "https://gitlab.com/acme/app",
};
const gitlab = (over: Record<string, unknown> = {}) => ({
  provider: "gitlab",
  kind: "oauth",
  enc: blob("old-ct"),
  refreshEnc: blob("old-refresh"),
  expiresAt: "2026-11-20T10:00:00.000Z",
  accountLogin: "acme-dev",
  connectedBy: "usr_admin",
  connectedAt: "2026-11-20T08:00:00.000Z",
  repos: [REPO],
  ...over,
});
const github = () => ({
  provider: "github",
  kind: "oauth",
  enc: blob("gh-ct"),
  connectedAt: "2026-11-01T00:00:00.000Z",
});
const tenantDoc = (gitConnections: Record<string, unknown>) => ({
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  allowedOrigins: ["https://example.com"],
  billingTier: "mvp_free",
  ownerId: "usr_owner",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  gitConnections,
});

function seeded(conn: Record<string, unknown> = gitlab()): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", tenantDoc({ gitlab: conn, github: github() }));
  db.seed("tenants", "ten_B", tenantDoc({ gitlab: gitlab() }));
  return db;
}
const stored = (db: FakeFirestore, id = "ten_A") =>
  (db.raw("tenants", id)?.gitConnections ?? {}) as Record<string, Record<string, unknown> | undefined>;
const NEXT = { enc: blob("new-ct"), refreshEnc: blob("new-refresh"), expiresAt: "2026-11-20T12:00:00.000Z" };
/** Another request removes the connection, as Disconnect does. */
const disconnect = (db: FakeFirestore) => async () => {
  await db.collection("tenants").doc("ten_A").update({ "gitConnections.gitlab": FieldValue.delete() });
};

describe("swapTenantGitToken", () => {
  it("saves the new token, refresh token and expiry, clears the mark and keeps the rest", async () => {
    const db = seeded(gitlab({ reconnect: { at: "2026-11-20T09:00:00.000Z", reason: "refresh_failed" } }));
    expect(await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db)).toBe("saved");
    const conn = stored(db).gitlab!;
    expect(conn).toMatchObject({ ...NEXT, provider: "gitlab", connectedAt: "2026-11-20T08:00:00.000Z", repos: [REPO] });
    expect(conn).not.toHaveProperty("reconnect");
    expect(db.raw("tenants", "ten_A")?.updatedAt).not.toBe("2026-11-01T00:00:00.000Z");
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is stale and writes nothing when the stored token is not the one it refreshed", async () => {
    const db = seeded(gitlab({ enc: blob("someone-elses-ct") }));
    expect(await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db)).toBe("stale");
    expect(stored(db).gitlab?.enc).toEqual(blob("someone-elses-ct"));
  });

  it("is stale when another request stores a newer token before it commits", async () => {
    const db = seeded();
    db.onBeforeCommit = async () => {
      await db.collection("tenants").doc("ten_A").update({ "gitConnections.gitlab.enc": blob("racer-ct") });
    };
    expect(await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db)).toBe("stale");
    expect(stored(db).gitlab?.enc).toEqual(blob("racer-ct"));
    expect(stored(db).gitlab?.refreshEnc).toEqual(blob("old-refresh"));
  });

  it("is gone and writes nothing when the connection was removed", async () => {
    const db = seeded();
    await disconnect(db)();
    expect(await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db)).toBe("gone");
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is gone when a Disconnect lands before it commits, and never brings the connection back", async () => {
    const db = seeded();
    db.onBeforeCommit = disconnect(db);
    expect(await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db)).toBe("gone");
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is gone for a brand that doesn't exist", async () => {
    const db = seeded();
    expect(await swapTenantGitToken("ten_missing", "gitlab", "old-ct", NEXT, db)).toBe("gone");
    expect(db.raw("tenants", "ten_missing")).toBeUndefined();
  });

  it("leaves other providers and other brands untouched", async () => {
    const db = seeded();
    await swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db);
    expect(stored(db).github).toEqual(github());
    expect(stored(db, "ten_B").gitlab).toEqual(gitlab());
  });
});

describe("markTenantGitReconnect", () => {
  it("marks the connection that still holds the token the caller saw", async () => {
    const db = seeded();
    expect(await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "refresh_failed", db)).toBe(true);
    expect(stored(db).gitlab?.reconnect).toMatchObject({ reason: "refresh_failed" });
    expect(typeof (stored(db).gitlab?.reconnect as { at?: unknown }).at).toBe("string");
    expect((await getTenantById("ten_A", db))?.gitConnections?.gitlab?.reconnect?.reason).toBe("refresh_failed");
  });

  it("doesn't mark a connection another request has just refreshed", async () => {
    const db = seeded(gitlab({ enc: blob("new-ct") }));
    expect(await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "provider_rejected", db)).toBe(false);
    expect(stored(db).gitlab).not.toHaveProperty("reconnect");
  });

  it("doesn't mark when a refresh lands before it commits", async () => {
    const db = seeded();
    db.onBeforeCommit = () => swapTenantGitToken("ten_A", "gitlab", "old-ct", NEXT, db).then(() => {});
    expect(await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "refresh_failed", db)).toBe(false);
    expect(stored(db).gitlab).not.toHaveProperty("reconnect");
    expect(stored(db).gitlab?.enc).toEqual(NEXT.enc);
  });

  it("is a no-op on a deleted connection, and the brand still loads", async () => {
    const db = seeded();
    await disconnect(db)();
    expect(await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "refresh_failed", db)).toBe(false);
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("is a no-op when a Disconnect lands before it commits", async () => {
    const db = seeded();
    db.onBeforeCommit = disconnect(db);
    expect(await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "refresh_failed", db)).toBe(false);
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("leaves other providers and other brands untouched", async () => {
    const db = seeded();
    await markTenantGitReconnect("ten_A", "gitlab", "old-ct", "refresh_failed", db);
    expect(stored(db).github).toEqual(github());
    expect(stored(db, "ten_B").gitlab).toEqual(gitlab());
  });
});

describe("clearTenantGitReconnect", () => {
  const marked = () => gitlab({ reconnect: { at: "2026-11-20T09:00:00.000Z", reason: "provider_rejected" } });

  it("clears the mark when the token is the one the caller saw", async () => {
    const db = seeded(marked());
    expect(await clearTenantGitReconnect("ten_A", "gitlab", "old-ct", db)).toBe(true);
    expect(stored(db).gitlab).not.toHaveProperty("reconnect");
    expect(stored(db).gitlab).toMatchObject({ provider: "gitlab", repos: [REPO] });
  });

  it("leaves the mark when the stored token is different", async () => {
    const db = seeded({ ...marked(), enc: blob("other-ct") });
    expect(await clearTenantGitReconnect("ten_A", "gitlab", "old-ct", db)).toBe(false);
    expect(stored(db).gitlab?.reconnect).toMatchObject({ reason: "provider_rejected" });
  });

  it("is a no-op on a deleted connection, and the brand still loads", async () => {
    const db = seeded(marked());
    await disconnect(db)();
    expect(await clearTenantGitReconnect("ten_A", "gitlab", "old-ct", db)).toBe(false);
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });
});

describe("setTenantGitRepos", () => {
  const NEW_REPO = { ...REPO, fullPath: "acme/site", webUrl: "https://gitlab.com/acme/site" };

  it("replaces the chosen repos on a live connection", async () => {
    const db = seeded();
    expect(await setTenantGitRepos("ten_A", "gitlab", [NEW_REPO], db)).toBe(true);
    expect(stored(db).gitlab).toMatchObject({ provider: "gitlab", enc: blob("old-ct"), repos: [NEW_REPO] });
    expect(typeof stored(db).gitlab?.reposUpdatedAt).toBe("string");
  });

  it("writes nothing on a deleted connection, so the brand still loads", async () => {
    const db = seeded();
    await disconnect(db)();
    expect(await setTenantGitRepos("ten_A", "gitlab", [NEW_REPO], db)).toBe(false);
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("writes nothing when a Disconnect lands before it commits (no partial map)", async () => {
    const db = seeded();
    db.onBeforeCommit = disconnect(db);
    expect(await setTenantGitRepos("ten_A", "gitlab", [NEW_REPO], db)).toBe(false);
    expect(stored(db).gitlab).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it("returns false for a brand that doesn't exist", async () => {
    const db = seeded();
    expect(await setTenantGitRepos("ten_missing", "gitlab", [NEW_REPO], db)).toBe(false);
    expect(db.raw("tenants", "ten_missing")).toBeUndefined();
  });

  it("leaves other providers and other brands untouched", async () => {
    const db = seeded();
    await setTenantGitRepos("ten_A", "gitlab", [NEW_REPO], db);
    expect(stored(db).github).toEqual(github());
    expect(stored(db, "ten_B").gitlab).toEqual(gitlab());
  });
});

import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { TenantIsolationError } from "./errors";
import { deleteLaunchKey, getLaunchKey, putLaunchKey } from "./launchKeys";
import { forTenant } from "./repository";

const rec = { keyId: "ygl_abc", tenantId: "ten_A", region: "us" as const, campaignId: "camp1", createdAt: "2026-10-25T10:00:00Z" };

describe("launch key routing", () => {
  it("routes a key id to its tenant, region and launch", async () => {
    const db = new FakeFirestore();
    await putLaunchKey(rec, db);
    expect(await getLaunchKey("ygl_abc", db)).toEqual(rec);
    expect(await getLaunchKey("ygl_missing", db)).toBeNull();
    expect(await getLaunchKey("", db)).toBeNull();
  });

  it("never re-points an existing key id", async () => {
    const db = new FakeFirestore();
    await putLaunchKey(rec, db);
    await expect(putLaunchKey({ ...rec, tenantId: "ten_B", campaignId: "theirs" }, db)).rejects.toBeInstanceOf(TenantIsolationError);
    expect((await getLaunchKey("ygl_abc", db))?.tenantId).toBe("ten_A");
  });

  it("lets only the owning tenant remove a key's routing", async () => {
    const db = new FakeFirestore();
    await putLaunchKey(rec, db);
    await expect(deleteLaunchKey("ygl_abc", "ten_B", db)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(await getLaunchKey("ygl_abc", db)).not.toBeNull();
    await deleteLaunchKey("ygl_abc", "ten_A", db);
    expect(await getLaunchKey("ygl_abc", db)).toBeNull();
    await deleteLaunchKey("ygl_abc", "ten_A", db); // already gone: fine
  });

  it("ignores a record with missing fields", async () => {
    const db = new FakeFirestore();
    db.seed("launch_keys", "ygl_bad", { keyId: "ygl_bad", tenantId: "ten_A" });
    expect(await getLaunchKey("ygl_bad", db)).toBeNull();
  });

  it("keeps a product key id from routing as a launch key", async () => {
    const db = new FakeFirestore();
    db.seed("connection_keys", "ygk_prod", { keyId: "ygk_prod", tenantId: "ten_A", region: "us", connectionId: "pcn_1" });
    expect(await getLaunchKey("ygk_prod", db)).toBeNull();
  });
});

describe("site keys", () => {
  it("are tenant scoped", async () => {
    const db = new FakeFirestore();
    db.seed("launch_site_keys", "camp1", { tenantId: "ten_A", campaignId: "camp1", keyId: "ygl_abc", status: "active" });
    const a = forTenant({ tenantId: "ten_A", region: "us", source: "system" }, db);
    const b = forTenant({ tenantId: "ten_B", region: "us", source: "system" }, db);
    expect(await a.siteKeys.getById("camp1")).not.toBeNull();
    expect(await b.siteKeys.getById("camp1")).toBeNull();
    await expect(b.siteKeys.update("camp1", { status: "revoked" })).rejects.toBeInstanceOf(TenantIsolationError);
    expect(db.raw("launch_site_keys", "camp1")?.status).toBe("active");
  });
});

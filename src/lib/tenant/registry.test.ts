import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  getTenantByOrigin,
  getTenantById,
  getTenantsForUser,
  getTenantMembership,
  listAllTenants,
} from "./registry";

function tenant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantName: "Vizzybl AI",
    rootDomain: "vizzybl.ai",
    status: "active",
    region: "us",
    allowedOrigins: ["https://vizzybl.ai", "https://waitlist.vizzybl.ai"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-06-15T16:00:00Z",
    updatedAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

describe("tenant registry", () => {
  it("resolves a tenant from an allow-listed origin", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", tenant());

    expect((await getTenantByOrigin("https://waitlist.vizzybl.ai", db))?.id).toBe(
      "ten_A",
    );
  });

  it("returns null for an origin that is not allow-listed (no tenant leak)", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_A", tenant());

    expect(await getTenantByOrigin("https://evil.example", db)).toBeNull();
  });

  it("getTenantById returns null for an unknown id", async () => {
    const db = new FakeFirestore();
    expect(await getTenantById("nope", db)).toBeNull();
  });

  it("listAllTenants enumerates every tenant across regions (for the scheduled worker)", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_us", tenant({ region: "us" }));
    db.seed("tenants", "ten_eu", tenant({ region: "eu", rootDomain: "yougrow.ai" }));
    db.seed("tenants", "ten_asia", tenant({ region: "asia" }));

    const all = await listAllTenants(db);
    expect(all.map((t) => t.id).sort()).toEqual(["ten_asia", "ten_eu", "ten_us"]);
    expect(all.map((t) => t.region).sort()).toEqual(["asia", "eu", "us"]);
  });

  it("listAllTenants returns an empty list when there are no tenants", async () => {
    expect(await listAllTenants(new FakeFirestore())).toEqual([]);
  });

  it("lists all tenant associations for a user", async () => {
    const db = new FakeFirestore();
    db.seed("tenant_users", "tu1", {
      userId: "usr_1",
      tenantId: "ten_A",
      role: "admin",
      joinedAt: "2026-06-15T16:00:00Z",
    });
    db.seed("tenant_users", "tu2", {
      userId: "usr_1",
      tenantId: "ten_B",
      role: "member",
      joinedAt: "2026-06-15T16:00:00Z",
    });
    db.seed("tenant_users", "tu3", {
      userId: "usr_2",
      tenantId: "ten_A",
      role: "admin",
      joinedAt: "2026-06-15T16:00:00Z",
    });

    const got = await getTenantsForUser("usr_1", db);
    expect(got.map((t) => t.tenantId).sort()).toEqual(["ten_A", "ten_B"]);
  });

  it("getTenantMembership returns the membership for an existing user↔tenant pair", async () => {
    const db = new FakeFirestore();
    db.seed("tenant_users", "tu1", {
      userId: "usr_1",
      tenantId: "ten_A",
      role: "admin",
      joinedAt: "2026-06-15T16:00:00Z",
    });
    db.seed("tenant_users", "tu2", {
      userId: "usr_1",
      tenantId: "ten_B",
      role: "member",
      joinedAt: "2026-06-15T16:00:00Z",
    });

    const m = await getTenantMembership("usr_1", "ten_B", db);
    expect(m).toMatchObject({ userId: "usr_1", tenantId: "ten_B", role: "member" });
  });

  it("getTenantMembership returns null when the user is not a member of that tenant", async () => {
    const db = new FakeFirestore();
    db.seed("tenant_users", "tu1", {
      userId: "usr_1",
      tenantId: "ten_A",
      role: "admin",
      joinedAt: "2026-06-15T16:00:00Z",
    });

    expect(await getTenantMembership("usr_1", "ten_B", db)).toBeNull();
    expect(await getTenantMembership("usr_2", "ten_A", db)).toBeNull();
  });
});

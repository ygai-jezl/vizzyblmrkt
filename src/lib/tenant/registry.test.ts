import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { getTenantByOrigin, getTenantById, getTenantsForUser } from "./registry";

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
});

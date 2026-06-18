import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  resolveTenantFromOrigin,
  tenantContextFromClaims,
  resolveActiveTenant,
} from "./context";
import type { TenantContext } from "./types";
import { TenantNotFoundError, TenantValidationError } from "./errors";

function tenant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantName: "Vizzybl AI",
    rootDomain: "vizzybl.ai",
    status: "active",
    region: "us",
    allowedOrigins: ["https://vizzybl.ai"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-06-15T16:00:00Z",
    updatedAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

describe("resolveTenantFromOrigin", () => {
  it("carries the tenant's region into the context", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_eu", tenant({ region: "eu" }));

    const ctx = await resolveTenantFromOrigin("https://vizzybl.ai", db);
    expect(ctx).toMatchObject({ tenantId: "ten_eu", region: "eu", source: "host" });
  });

  it("rejects a suspended tenant", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_s", tenant({ status: "suspended" }));
    await expect(
      resolveTenantFromOrigin("https://vizzybl.ai", db),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});

describe("tenantContextFromClaims", () => {
  it("builds a context from verified tenant_id + region claims", () => {
    const ctx = tenantContextFromClaims({
      uid: "usr_1",
      tenant_id: "ten_A",
      region: "asia",
      role: "admin",
    });
    expect(ctx).toEqual({
      tenantId: "ten_A",
      region: "asia",
      userId: "usr_1",
      role: "admin",
      source: "idtoken",
    });
  });

  it("rejects a token missing the region claim", () => {
    expect(() =>
      tenantContextFromClaims({ uid: "usr_1", tenant_id: "ten_A" }),
    ).toThrow(TenantValidationError);
  });

  it("rejects a token missing the tenant_id claim", () => {
    expect(() =>
      tenantContextFromClaims({ uid: "usr_1", region: "us" }),
    ).toThrow(TenantValidationError);
  });
});

describe("resolveActiveTenant", () => {
  const home: TenantContext = {
    tenantId: "ten_A",
    region: "us",
    userId: "usr_1",
    role: "admin",
    source: "idtoken",
  };

  function membership(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userId: "usr_1",
      tenantId: "ten_B",
      role: "member",
      joinedAt: "2026-06-15T16:00:00Z",
      ...over,
    };
  }

  it("overrides to a tenant the user belongs to, taking region + role from the target", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_B", tenant({ region: "eu" }));
    db.seed("tenant_users", "m1", membership());

    expect(await resolveActiveTenant(home, "ten_B", db)).toEqual({
      tenantId: "ten_B",
      region: "eu",
      userId: "usr_1",
      role: "member",
      source: "idtoken",
    });
  });

  it("ignores a candidate the user is NOT a member of (no escalation)", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_B", tenant()); // tenant exists, but no membership row
    expect(await resolveActiveTenant(home, "ten_B", db)).toEqual(home);
  });

  it("ignores a suspended target tenant", async () => {
    const db = new FakeFirestore();
    db.seed("tenants", "ten_B", tenant({ status: "suspended" }));
    db.seed("tenant_users", "m1", membership({ role: "admin" }));
    expect(await resolveActiveTenant(home, "ten_B", db)).toEqual(home);
  });

  it("ignores a candidate whose tenant doc no longer exists", async () => {
    const db = new FakeFirestore();
    db.seed("tenant_users", "m1", membership()); // membership but no tenants/ten_B doc
    expect(await resolveActiveTenant(home, "ten_B", db)).toEqual(home);
  });

  it("is a no-op for the home tenant or an absent cookie", async () => {
    const db = new FakeFirestore();
    expect(await resolveActiveTenant(home, "ten_A", db)).toEqual(home);
    expect(await resolveActiveTenant(home, undefined, db)).toEqual(home);
  });
});

import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { resolveTenantFromOrigin, tenantContextFromClaims } from "./context";
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

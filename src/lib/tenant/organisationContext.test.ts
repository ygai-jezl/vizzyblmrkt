import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { isBrandAdminByRow, isBrandAdminLive, organisationContextFor, verifiedPersonOf, type VerifiedPerson } from "./organisationContext";
import type { TenantContext } from "./types";

// Made-up people: Priya owns Fernhill Group and is in Fernhill Plants by her claims (her home
// brand, no tenant_users row) and in Harbour Blooms by a row; Leo is a member of Harbour Blooms.
const T = "2026-11-24T10:00:00.000Z";
let db: FakeFirestore;

function seedBrand(id: string, over: Record<string, unknown> = {}) {
  db.seed("tenants", id, { tenantName: id, rootDomain: `${id}.example`, ownerId: "usr_priya", status: "active", region: "eu", allowedOrigins: [], createdAt: T, updatedAt: T, organisationId: "org_ten_fernhill", ...over });
}

beforeEach(() => {
  db = new FakeFirestore();
  seedBrand("ten_fernhill");
  seedBrand("ten_harbour");
  seedBrand("ten_stray", { organisationId: "org_ten_fernhill" });
  db.seed("organisations", "org_ten_fernhill", {
    name: "Fernhill Group",
    plan: "ultra",
    planSince: T,
    brandIds: ["ten_fernhill", "ten_harbour"],
    ownerIds: ["usr_priya"],
    createdBy: "usr_priya",
    createdAt: T,
    updatedAt: T,
  });
  db.seed("tenant_users", "m1", { userId: "usr_priya", tenantId: "ten_harbour", role: "admin", joinedAt: T });
  db.seed("tenant_users", "m2", { userId: "usr_leo", tenantId: "ten_harbour", role: "member", joinedAt: T });
});

const ctx = (tenantId: string, userId = "usr_priya"): TenantContext => ({ tenantId, region: "eu", userId, role: "admin", source: "idtoken" });
const priya: VerifiedPerson = { userId: "usr_priya", homeTenantId: "ten_fernhill", homeRole: "admin" };

describe("the organisation context, read live", () => {
  it("names the session brand's organisation and whether the person owns it", async () => {
    const org = await organisationContextFor(ctx("ten_harbour"), db);
    expect(org).toMatchObject({ organisation: { id: "org_ten_fernhill" }, isOwner: true, userId: "usr_priya" });
    expect((await organisationContextFor(ctx("ten_harbour", "usr_leo"), db))?.isOwner).toBe(false);
  });

  it("follows the owners as they are now, not as they were", async () => {
    db.seed("organisations", "org_ten_fernhill", { ...db.raw("organisations", "org_ten_fernhill")!, ownerIds: [] });
    expect((await organisationContextFor(ctx("ten_harbour"), db))?.isOwner).toBe(false);
  });

  it("is none for a brand its organisation doesn't list, a suspended brand, or no person", async () => {
    expect(await organisationContextFor(ctx("ten_stray"), db)).toBeNull();
    seedBrand("ten_harbour", { status: "suspended" });
    expect(await organisationContextFor(ctx("ten_harbour"), db)).toBeNull();
    expect(await organisationContextFor({ tenantId: "ten_fernhill", region: "eu", source: "system" }, db)).toBeNull();
  });
});

describe("isBrandAdminLive", () => {
  it("takes a tenant_users admin row", async () => {
    expect(await isBrandAdminLive(priya, "ten_harbour", db)).toBe(true);
    expect(await isBrandAdminByRow("usr_priya", "ten_harbour", db)).toBe(true);
  });

  it("takes the verified home brand's admin claims, where there is no row", async () => {
    expect(await isBrandAdminLive(priya, "ten_fernhill", db)).toBe(true);
    expect(await isBrandAdminLive({ ...priya, homeRole: "member" }, "ten_fernhill", db)).toBe(false);
    // Moving brands takes the row only: claims decide nothing there.
    expect(await isBrandAdminByRow("usr_priya", "ten_fernhill", db)).toBe(false);
  });

  it("refuses a member's row, and a switched brand with no row", async () => {
    expect(await isBrandAdminLive({ userId: "usr_leo", homeTenantId: "ten_leo", homeRole: "admin" }, "ten_harbour", db)).toBe(false);
    expect(await isBrandAdminLive(priya, "ten_stray", db)).toBe(false);
  });

  it("builds the person from the verified session only", () => {
    expect(verifiedPersonOf({ ctx: ctx("ten_harbour"), homeTenantId: "ten_fernhill", homeRole: "admin" })).toEqual(priya);
    expect(verifiedPersonOf({ ctx: { tenantId: "ten_x", region: "eu", source: "idtoken" }, homeTenantId: "ten_x" })).toBeNull();
  });
});

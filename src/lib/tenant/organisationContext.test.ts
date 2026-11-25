import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { isBrandAdminByRow, isBrandAdminLive, mayMoveBrand, organisationContextFor, verifiedPersonOf, type VerifiedPerson } from "./organisationContext";
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

describe("mayMoveBrand: who may move a brand, read live (pick 16)", () => {
  // Fernhill Cafe [made up] sits in an organisation of its own that Priya also owns, and she has an
  // admin row there; Otto's Bakery [made up] is in Otto's organisation, where Priya has an admin row
  // but isn't an owner.
  beforeEach(() => {
    seedBrand("ten_cafe", { organisationId: "org_ten_cafe" });
    seedBrand("ten_otto", { organisationId: "org_ten_otto" });
    seedBrand("ten_open", { organisationId: undefined });
    db.seed("organisations", "org_ten_cafe", { name: "Fernhill Cafe", plan: "free", planSince: T, brandIds: ["ten_cafe"], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: T, updatedAt: T });
    db.seed("organisations", "org_ten_otto", { name: "Otto Group", plan: "pro", planSince: T, brandIds: ["ten_otto"], ownerIds: ["usr_otto"], createdBy: "usr_otto", createdAt: T, updatedAt: T });
    db.seed("tenant_users", "m3", { userId: "usr_priya", tenantId: "ten_cafe", role: "admin", joinedAt: T });
    db.seed("tenant_users", "m4", { userId: "usr_priya", tenantId: "ten_otto", role: "admin", joinedAt: T });
    db.seed("tenant_users", "m5", { userId: "usr_priya", tenantId: "ten_open", role: "admin", joinedAt: T });
  });

  it("takes an owner of the brand's organisation with a real admin row for the brand, in any organisation they own", async () => {
    const a = await mayMoveBrand(priya, "ten_harbour", db);
    expect(a).toMatchObject({ ok: true, brand: { id: "ten_harbour" }, organisation: { id: "org_ten_fernhill" } });
    const b = await mayMoveBrand(priya, "ten_cafe", db);
    expect(b).toMatchObject({ ok: true, organisation: { id: "org_ten_cafe", plan: "free" } });
  });

  it("refuses the home brand reached by claims only, even when they say admin", async () => {
    expect(await mayMoveBrand(priya, "ten_fernhill", db)).toMatchObject({ ok: false, why: "home_only", brand: { id: "ten_fernhill" } });
    // An operator adds a row: now it may move.
    db.seed("tenant_users", "m6", { userId: "usr_priya", tenantId: "ten_fernhill", role: "admin", joinedAt: T });
    expect((await mayMoveBrand(priya, "ten_fernhill", db)).ok).toBe(true);
  });

  it("refuses a member's row and no row at all, for a brand that isn't the home brand", async () => {
    const leo: VerifiedPerson = { userId: "usr_leo", homeTenantId: "ten_leo", homeRole: "admin" };
    db.seed("organisations", "org_ten_fernhill", { ...db.raw("organisations", "org_ten_fernhill")!, ownerIds: ["usr_priya", "usr_leo"] });
    expect(await mayMoveBrand(leo, "ten_harbour", db)).toMatchObject({ ok: false, why: "not_admin", brand: { id: "ten_harbour" } });
    expect(await mayMoveBrand(leo, "ten_fernhill", db)).toMatchObject({ ok: false, why: "not_admin" });
  });

  it("refuses an organisation the person doesn't own, whatever rows they have (another organisation's brand)", async () => {
    expect(await mayMoveBrand(priya, "ten_otto", db)).toEqual({ ok: false, why: "not_owner" });
  });

  it("reads the owners and rows as they are now", async () => {
    db.seed("organisations", "org_ten_cafe", { ...db.raw("organisations", "org_ten_cafe")!, ownerIds: [] });
    expect(await mayMoveBrand(priya, "ten_cafe", db)).toEqual({ ok: false, why: "not_owner" });
    db.seed("organisations", "org_ten_cafe", { ...db.raw("organisations", "org_ten_cafe")!, ownerIds: ["usr_priya"] });
    db.seed("tenant_users", "m3", { userId: "usr_priya", tenantId: "ten_cafe", role: "member", joinedAt: T });
    expect(await mayMoveBrand(priya, "ten_cafe", db)).toMatchObject({ ok: false, why: "not_admin" });
  });

  it("refuses a missing or suspended brand, one with no organisation, and one its organisation doesn't list", async () => {
    expect(await mayMoveBrand(priya, "ten_nobody", db)).toEqual({ ok: false, why: "no_brand" });
    seedBrand("ten_cafe", { organisationId: "org_ten_cafe", status: "suspended" });
    expect(await mayMoveBrand(priya, "ten_cafe", db)).toEqual({ ok: false, why: "no_brand" });
    expect(await mayMoveBrand(priya, "ten_open", db)).toEqual({ ok: false, why: "no_organisation" });
    expect(await mayMoveBrand(priya, "ten_stray", db)).toEqual({ ok: false, why: "no_organisation" });
    expect(await mayMoveBrand({ ...priya, userId: "" }, "ten_harbour", db)).toEqual({ ok: false, why: "no_brand" });
  });
});

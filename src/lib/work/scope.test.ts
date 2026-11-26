import { afterEach, describe, expect, it, vi } from "vitest";
import { brandForTask, seesTask, workScopeFor, zoneForTask } from "./scope";
import { FERNHILL, HEARTH, makeWorld, PEOPLE } from "./testing/world";
import { LUMEN_EU, LUMEN_US, ORG, OTHER_ORG } from "./testing/fixtures";

afterEach(() => vi.unstubAllEnvs());

describe("who sees what in Work", () => {
  it("shows an owner the whole organisation, every brand with its region, time zone and selected repos", async () => {
    const w = makeWorld();
    const s = await w.scope(PEOPLE.nina);
    expect(s).toMatchObject({ organisationId: ORG, organisationName: "Lumen", view: "organisation", owner: true, oneBrand: false, standalone: false, canDelete: true, canImport: true });
    expect(s.brands.map((b) => [b.id, b.region, b.timeZone])).toEqual([
      [LUMEN_US, "us", "America/New_York"],
      [LUMEN_EU, "eu", "Europe/Berlin"],
    ]);
    expect(s.brands[0]!.repos).toEqual([{ provider: "github", fullPath: "Lumen-Example/notes-app" }]);
    // The session brand comes first, whichever brand the owner is in.
    expect((await w.scope(PEOPLE.ninaEu)).brands.map((b) => b.id)).toEqual([LUMEN_EU, LUMEN_US]);
  });

  it("shows a member or an admin who isn't an owner only their own brand in a multi brand organisation", async () => {
    const w = makeWorld();
    const sam = await w.scope(PEOPLE.sam);
    expect(sam).toMatchObject({ view: "brand", owner: false, canDelete: false, canImport: false });
    expect(sam.brands.map((b) => b.id)).toEqual([LUMEN_US]);
    const leo = await w.scope(PEOPLE.leo);
    expect(leo).toMatchObject({ view: "brand", canDelete: true, canImport: true });
    expect(seesTask(sam, { organisationId: ORG, brandId: LUMEN_US })).toBe(true);
    expect(seesTask(sam, { organisationId: ORG, brandId: LUMEN_EU })).toBe(false);
    expect(seesTask(sam, { organisationId: ORG, brandId: null })).toBe(false);
    expect(seesTask(sam, { organisationId: OTHER_ORG, brandId: LUMEN_US })).toBe(false);
  });

  it("shows everyone in a one brand organisation all of its Work, admins deleting and importing", async () => {
    const w = makeWorld();
    const rosa = await w.scope(PEOPLE.rosa);
    expect(rosa).toMatchObject({ organisationId: OTHER_ORG, view: "organisation", owner: false, oneBrand: true, canDelete: false });
    expect(seesTask(rosa, { organisationId: OTHER_ORG, brandId: null })).toBe(true);
    // In a one brand organisation every task counts as the brand's.
    expect(brandForTask(rosa, { brandId: null })?.id).toBe(FERNHILL);
    expect((await w.scope(PEOPLE.priya)).canDelete).toBe(true);
  });

  it("treats a brand with no organisation yet as its own, under the id the backfill gives it", async () => {
    const w = makeWorld();
    const s = await w.scope(PEOPLE.hal);
    expect(s).toMatchObject({ organisationId: `org_${HEARTH}`, standalone: true, view: "organisation", oneBrand: true, organisationName: null });
    expect(zoneForTask(s, { brandId: null, addedFrom: HEARTH })).toBe("Asia/Singapore");
  });

  it("refuses instead of guessing when that id is someone's record already, or the organisation doesn't list the brand", async () => {
    const w = makeWorld();
    w.control.seed("organisations", `org_${HEARTH}`, { name: "Old", plan: "free", planSince: "x", brandIds: [], ownerIds: [], createdBy: "x", createdAt: "x", updatedAt: "x" });
    expect(await workScopeFor(PEOPLE.hal, w.deps)).toEqual({ ok: false, why: "no_organisation" });
    w.control.seed("organisations", ORG, { name: "Lumen", plan: "self_hosted", planSince: "x", brandIds: [LUMEN_EU], ownerIds: [], createdBy: "x", createdAt: "x", updatedAt: "x" });
    expect(await workScopeFor(PEOPLE.sam, w.deps)).toEqual({ ok: false, why: "no_organisation" });
  });

  it("refuses with no signed in person, or a suspended brand", async () => {
    const w = makeWorld();
    expect(await workScopeFor({ ...PEOPLE.sam, userId: undefined }, w.deps)).toEqual({ ok: false, why: "signed_out" });
    w.control.seed("tenants", FERNHILL, { ...w.control.raw("tenants", FERNHILL)!, status: "suspended" });
    expect(await workScopeFor(PEOPLE.rosa, w.deps)).toEqual({ ok: false, why: "no_brand" });
  });

  it("leaves out a listed brand whose own record names another organisation", async () => {
    const w = makeWorld();
    w.control.seed("tenants", LUMEN_EU, { ...w.control.raw("tenants", LUMEN_EU)!, organisationId: "org_ten_elsewhere" });
    expect((await w.scope(PEOPLE.nina)).brands.map((b) => b.id)).toEqual([LUMEN_US]);
  });

  it("names operators by LOOPS_OPERATOR_EMAILS, ignoring case, and nobody while it is empty", async () => {
    const w = makeWorld();
    expect((await w.scope(PEOPLE.nina)).operator).toBe(false);
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "someone@example.com, NINA@Lumen.Example");
    expect((await w.scope(PEOPLE.nina)).operator).toBe(true);
    expect((await w.scope(PEOPLE.sam)).operator).toBe(false);
  });
});

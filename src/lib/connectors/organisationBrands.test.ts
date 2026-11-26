import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allocateWorkRefs, createWorkTask, forTenant, getOrganisationConnection } from "@/lib/tenant";
import { aTask, aWrite } from "@/lib/work/testing/fixtures";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { flakyFirestore } from "@/lib/tenant/testing/flakyFirestore";
import type { Region } from "@/lib/types/tenant";
import { sealConnectorSecret } from "./vault";
import { bringBrandIn, moveBrandOut, narrowerOf, organisationBrandsScreen } from "./organisationBrands";
import { organisationOwnerOf, type OrganisationOwner } from "./organisationOwner";
import { EU_BRAND, ORG, OCN, orgWorld, seedFernhill, seedPart, seedSource, seedTenant, T0, US_BRAND, type OrgWorld } from "./testing/organisation";

// The search databases: an in-memory index, since ending a part erases its searches.
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// Brands in the organisation (Connectors 3 group 4). Fernhill Group [made up] has Fernhill Plants
// (Europe, Priya's home brand: claims, no tenant_users row) and Fernhill US (United States, an admin
// row). Priya also owns Fernhill Cafe's organisation (Free, alone, an admin row) and Fernhill
// Wholesale's (Enterprise, an admin row). She has an admin row for Otto's Bakery but doesn't own
// its organisation, and only a member row for Fernhill Market. One fake database per region, kept
// the way Firestore keeps dates.
let w: OrgWorld;
let owner: OrganisationOwner;
const CAFE = { tenantId: "ten_cafe", region: "eu" as Region };
const OCN_CAFE = "ocn_cccccccccccccccccccc";
const USE_CAFE = "dcn_cccccccccccccccccccc";

function seedOrg(id: string, name: string, plan: string, brandIds: string[], ownerIds = ["usr_priya"]) {
  w.us.seed("organisations", id, { name, plan, planSince: T0, brandIds, ownerIds, createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
}
const row = (userId: string, tenantId: string, role: "admin" | "member" = "admin") => w.us.seed("tenant_users", `${userId}_${tenantId}`, { userId, tenantId, role, joinedAt: T0 });
const deps = () => ({ controlDb: w.us, regionDb: w.regionDb });

beforeEach(async () => {
  const base = orgWorld();
  const us = timestampFirestore(base.us);
  const eu = timestampFirestore(base.eu);
  const asia = timestampFirestore(base.asia);
  w = { us, eu, asia, regionDb: (r) => (r === "eu" ? eu : r === "asia" ? asia : us) };
  seedFernhill(w);
  w.us.seed("tenants", EU_BRAND.tenantId, { ...w.us.raw("tenants", EU_BRAND.tenantId)!, orgPlan: "ultra" });
  seedTenant(w, US_BRAND, ORG, { orgPlan: "ultra" });
  seedTenant(w, CAFE, "org_ten_cafe", { tenantName: "Fernhill Cafe", orgPlan: "free" });
  seedTenant(w, { tenantId: "ten_wholesale", region: "eu" }, "org_ten_wholesale", { tenantName: "Fernhill Wholesale", orgPlan: "enterprise" });
  seedTenant(w, { tenantId: "ten_otto", region: "us" }, "org_ten_otto", { tenantName: "Otto's Bakery", orgPlan: "pro" });
  seedTenant(w, { tenantId: "ten_market", region: "us" }, "org_ten_market", { tenantName: "Fernhill Market", orgPlan: "pro" });
  seedOrg("org_ten_cafe", "Fernhill Cafe", "free", ["ten_cafe"]);
  seedOrg("org_ten_wholesale", "Wholesale Group", "enterprise", ["ten_wholesale"]);
  seedOrg("org_ten_otto", "Otto Group", "pro", ["ten_otto"], ["usr_otto"]);
  seedOrg("org_ten_market", "Market Group", "pro", ["ten_market"]);
  row("usr_priya", US_BRAND.tenantId);
  row("usr_priya", "ten_cafe");
  row("usr_priya", "ten_wholesale");
  row("usr_priya", "ten_otto");
  row("usr_priya", "ten_market", "member");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const r = await organisationOwnerOf({ tenantId: EU_BRAND.tenantId, region: "eu", userId: "usr_priya", role: "admin", source: "idtoken" }, { userId: "usr_priya", homeTenantId: EU_BRAND.tenantId, homeRole: "admin" }, { controlDb: w.us });
  if (!r.ok) throw new Error(r.why);
  owner = r.owner;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the Brands section", () => {
  it("lists the organisation's brands in every region, the parts each is given, and why Move out would be refused", async () => {
    const source = await seedSource(w);
    await seedPart(w, source, US_BRAND, { useId: "dcn_uuuuuuuuuuuuuuuuuuuu", account: "0123456789abcdef0123456789abcd02" });
    const s = await organisationBrandsScreen(owner, deps());
    expect(s.organisation).toEqual({ id: ORG, name: "Fernhill Group", planName: "Ultra" });
    expect(s.brands).toEqual([
      // Priya reaches Fernhill Plants by her claims only: a move needs a row.
      { id: EU_BRAND.tenantId, name: "Fernhill Plants", regionName: "Europe", isThis: true, parts: [], keptFrom: ["Europe"], moveRefusal: "home_only" },
      { id: US_BRAND.tenantId, name: "Fernhill US", regionName: "United States", isThis: false, parts: ["cloudflare"], keptFrom: [], moveRefusal: null },
    ]);
    expect(s.full).toBeNull();
  });

  it("offers only brands in another organisation Priya owns, where she has an admin row, saying what each would narrow", async () => {
    const s = await organisationBrandsScreen(owner, deps());
    expect(s.candidates.map((c) => [c.id, c.organisation.name, c.organisation.planName, c.organisation.alone, c.narrower])).toEqual([
      ["ten_cafe", "Fernhill Cafe", "Free", true, null],
      ["ten_wholesale", "Wholesale Group", "Enterprise", true, "features"],
    ]);
  });

  it("names nothing of another organisation's brands that Priya doesn't own", async () => {
    const s = await organisationBrandsScreen(owner, deps());
    expect(JSON.stringify(s)).not.toContain("Otto");
    expect(JSON.stringify(s)).not.toContain("Market");
  });

  it("says when the plan's brands allowance is reached", async () => {
    seedOrg(ORG, "Fernhill Group", "pro", [EU_BRAND.tenantId, US_BRAND.tenantId, "ten_x"]);
    const again = await organisationOwnerOf(owner.ctx, owner.person, { controlDb: w.us });
    if (!again.ok) throw new Error(again.why);
    expect((await organisationBrandsScreen(again.owner, deps())).full).toEqual({ limit: 3 });
  });

  it("can't count the parts when a region can't be read, and still lists the brands", async () => {
    const broken = { ...deps(), regionDb: (r: Region) => (r === "asia" ? ({ collection: () => { throw new Error("unavailable"); } } as never) : w.regionDb(r)) };
    const s = await organisationBrandsScreen(owner, broken);
    expect(s.brands.map((b) => b.parts)).toEqual([null, null]);
  });
});

describe("narrowerOf (the plans preview, read only)", () => {
  it("is null moving up, features when a plan's feature is lost, Enterprise's own features included", () => {
    expect(narrowerOf({ orgPlan: "free" }, "ultra")).toBeNull();
    expect(narrowerOf({ orgPlan: "ultra" }, "ultra")).toBeNull();
    expect(narrowerOf({ orgPlan: "ultra" }, "pro")).toBe("features");
    expect(narrowerOf({ orgPlan: "enterprise" }, "ultra")).toBe("features");
  });
});

describe("Bring in", () => {
  it("brings a brand in on the organisation's plan, ends its parts from where it was, and disconnects that organisation's connections once it is empty", async () => {
    const cafeSource = await seedSource(w, { id: OCN_CAFE, organisationId: "org_ten_cafe", connectedFromTenantId: "ten_cafe" });
    await seedPart(w, cafeSource, CAFE, { useId: USE_CAFE, account: "0123456789abcdef0123456789abcd09" });
    const fernSource = await seedSource(w);
    await seedPart(w, fernSource, US_BRAND, { useId: "dcn_uuuuuuuuuuuuuuuuuuuu", account: "0123456789abcdef0123456789abcd02" });

    const r = await bringBrandIn(owner, "ten_cafe", deps());
    expect(r).toEqual({ ok: true, status: 200, value: { message: "Fernhill Cafe joined Fernhill Group.", organisationId: ORG, ended: 1, disconnected: 1 } });
    expect(w.us.raw("tenants", "ten_cafe")).toMatchObject({ organisationId: ORG, orgPlan: "ultra" });
    expect(w.us.raw("organisations", ORG)?.brandIds).toEqual([EU_BRAND.tenantId, US_BRAND.tenantId, "ten_cafe"]);
    // The part ended in the brand's own region, and what it collected is waiting to be erased.
    const rec = await forTenant({ ...CAFE, source: "system" }, w.eu).dataConnections.getById(USE_CAFE);
    expect(rec).toMatchObject({ status: "disconnected" });
    expect((await getOrganisationConnection("org_ten_cafe", OCN_CAFE, "eu", { regionDb: w.regionDb }))?.status).toBe("disconnected");
    // Fernhill Group's own connection, and its part for Fernhill US, are untouched.
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))?.parts.map((p) => [p.tenantId, p.state])).toEqual([[US_BRAND.tenantId, "active"]]);
    const joined = (Object.values(w.us.dump("organisation_changes")) as Array<Record<string, unknown>>).find((c) => c.kind === "brand.joined");
    expect(joined).toMatchObject({ organisationId: ORG, tenantId: "ten_cafe", from: "org_ten_cafe", actor: "usr_priya" });
  });

  it("takes the brand's Work tasks along, with new numbers, and leaves its old organisation's whole business tasks there", async () => {
    const stores = { regionDb: w.regionDb, controlDb: w.us };
    await allocateWorkRefs(ORG, 4, w.us);
    const cafeTask = await createWorkTask(aTask({ organisationId: "org_ten_cafe", brandId: "ten_cafe", addedFrom: "ten_cafe", region: "eu", ref: 1 }), aWrite(), stores);
    const cafeWhole = await createWorkTask(aTask({ organisationId: "org_ten_cafe", brandId: null, addedFrom: "ten_cafe", region: "eu", ref: 2 }), aWrite(), stores);
    expect(await bringBrandIn(owner, "ten_cafe", deps())).toMatchObject({ ok: true });
    expect(w.eu.raw("work_tasks", cafeTask.task.id)).toMatchObject({ organisationId: ORG, ref: 5, region: "eu" });
    // Left behind with the organisation, which the move emptied: kept, never erased by the move.
    expect(w.eu.raw("work_tasks", cafeWhole.task.id)).toMatchObject({ organisationId: "org_ten_cafe", ref: 2 });
  });

  it("takes the brand's Work along when taking it stops partway once, carrying on from where it stopped", async () => {
    const stores = { regionDb: w.regionDb, controlDb: w.us };
    await allocateWorkRefs(ORG, 4, w.us);
    const one = await createWorkTask(aTask({ organisationId: "org_ten_cafe", brandId: "ten_cafe", addedFrom: "ten_cafe", region: "eu", ref: 1 }), aWrite(), stores);
    const two = await createWorkTask(aTask({ organisationId: "org_ten_cafe", brandId: "ten_cafe", addedFrom: "ten_cafe", region: "eu", ref: 2, title: "Second" }), aWrite(), stores);
    // Europe refuses its second transaction once: the first task has moved, the second not yet.
    const flakyEu = flakyFirestore(w.eu, { failOn: 2 });
    const flaky = { controlDb: w.us, regionDb: (r: Region) => (r === "eu" ? flakyEu : w.regionDb(r)) };
    expect(await bringBrandIn(owner, "ten_cafe", flaky)).toMatchObject({ ok: true });
    expect([one, two].map((t) => w.eu.raw("work_tasks", t.task.id)?.organisationId)).toEqual([ORG, ORG]);
    expect(new Set([one, two].map((t) => w.eu.raw("work_tasks", t.task.id)?.ref))).toEqual(new Set([5, 7]));
    const left = (Object.values(w.eu.dump("work_log")) as Array<Record<string, unknown>>).filter((x) => x.taskId === one.task.id || x.taskId === two.task.id);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((x) => x.organisationId === ORG)).toBe(true);
  });

  it("refuses a narrower plan, with nothing moved", async () => {
    const r = await bringBrandIn(owner, "ten_wholesale", deps());
    expect(r).toMatchObject({ ok: false, status: 409, error: "narrower", message: "Bringing in Fernhill Wholesale would move it from Enterprise to Ultra and turn off features it has. That needs a plan change first." });
    expect(w.us.raw("tenants", "ten_wholesale")).toMatchObject({ organisationId: "org_ten_wholesale" });
  });

  it("refuses at the plan's brands allowance", async () => {
    seedOrg(ORG, "Fernhill Group", "pro", [EU_BRAND.tenantId, US_BRAND.tenantId, "ten_x"]);
    const again = await organisationOwnerOf(owner.ctx, owner.person, { controlDb: w.us });
    if (!again.ok) throw new Error(again.why);
    const r = await bringBrandIn(again.owner, "ten_cafe", deps());
    expect(r).toMatchObject({ ok: false, status: 409, error: "full", message: "Fernhill Group already has the 3 brands Pro allows. Bringing in another needs a plan change first." });
    expect(w.us.raw("tenants", "ten_cafe")).toMatchObject({ organisationId: "org_ten_cafe" });
  });

  it("refuses another organisation's brand Priya doesn't own, a member row, no row, and her home brand's claims", async () => {
    expect(await bringBrandIn(owner, "ten_otto", deps())).toMatchObject({ ok: false, status: 403, error: "not_owner_there" });
    expect(await bringBrandIn(owner, "ten_market", deps())).toMatchObject({ ok: false, status: 403, error: "not_admin" });
    // Her home brand is in Fernhill Group already; from another organisation's page, it would need a row.
    seedTenant(w, { tenantId: "ten_home", region: "eu" }, "org_ten_home", { tenantName: "Home Shop", orgPlan: "ultra" });
    seedOrg("org_ten_home", "Home Shop", "ultra", ["ten_home"]);
    const homeOwner = { ...owner, person: { ...owner.person, homeTenantId: "ten_home" } };
    expect(await bringBrandIn(homeOwner, "ten_home", deps())).toMatchObject({ ok: false, status: 403, error: "home_only" });
    expect(w.us.raw("tenants", "ten_home")).toMatchObject({ organisationId: "org_ten_home" });
    expect(await bringBrandIn(owner, "ten_nobody", deps())).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a brand already in the organisation", async () => {
    expect(await bringBrandIn(owner, US_BRAND.tenantId, deps())).toMatchObject({ ok: false, status: 409, error: "already" });
  });
});

describe("Move out", () => {
  const changes = () => Object.values(w.us.dump("organisation_changes")) as Array<Record<string, unknown>>;

  it("takes the brand's Work tasks to its new organisation, numbered from 1 there", async () => {
    const stores = { regionDb: w.regionDb, controlDb: w.us };
    const mine = await createWorkTask(aTask({ organisationId: ORG, brandId: US_BRAND.tenantId, addedFrom: US_BRAND.tenantId, region: "us", ref: 12 }), aWrite(), stores);
    const plants = await createWorkTask(aTask({ organisationId: ORG, brandId: EU_BRAND.tenantId, addedFrom: EU_BRAND.tenantId, region: "eu", ref: 13 }), aWrite(), stores);
    expect(await moveBrandOut(owner, US_BRAND.tenantId, deps())).toMatchObject({ ok: true, value: { organisationId: "org_ten_fernhill-us" } });
    expect(w.us.raw("work_tasks", mine.task.id)).toMatchObject({ organisationId: "org_ten_fernhill-us", ref: 1 });
    expect(w.eu.raw("work_tasks", plants.task.id)).toMatchObject({ organisationId: ORG, ref: 13 });
  });

  it("moves a brand out to one of its own on the same plan, with Priya its only owner, and ends its part; the connections stay in Europe for the others", async () => {
    // Fernhill Group had another owner too: the new organisation never inherits them.
    seedOrg(ORG, "Fernhill Group", "ultra", [EU_BRAND.tenantId, US_BRAND.tenantId], ["usr_priya", "usr_alex"]);
    const again = await organisationOwnerOf(owner.ctx, owner.person, { controlDb: w.us });
    if (!again.ok) throw new Error(again.why);
    const source = await seedSource(w);
    await seedPart(w, source, US_BRAND, { useId: "dcn_uuuuuuuuuuuuuuuuuuuu", account: "0123456789abcdef0123456789abcd02" });
    await seedPart(w, source, EU_BRAND, { useId: "dcn_eeeeeeeeeeeeeeeeeeee", account: "0123456789abcdef0123456789abcd01" });

    const r = await moveBrandOut(again.owner, US_BRAND.tenantId, deps());
    expect(r).toEqual({
      ok: true,
      status: 200,
      value: { message: "Fernhill US has an organisation of its own now, on Ultra, with you as its only owner.", organisationId: "org_ten_fernhill-us", ended: 1, disconnected: 0 },
    });
    expect(w.us.raw("organisations", "org_ten_fernhill-us")).toMatchObject({ plan: "ultra", brandIds: [US_BRAND.tenantId], ownerIds: ["usr_priya"], createdBy: "usr_priya" });
    expect(w.us.raw("tenants", US_BRAND.tenantId)).toMatchObject({ organisationId: "org_ten_fernhill-us", orgPlan: "ultra" });
    expect(w.us.raw("organisations", ORG)?.brandIds).toEqual([EU_BRAND.tenantId]);
    // The part ended in the brand's own region (the United States); the sign in stays in Europe, serving Fernhill Plants.
    expect(await forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById("dcn_uuuuuuuuuuuuuuuuuuuu")).toMatchObject({ status: "disconnected" });
    const kept = await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb });
    expect(kept?.status).toBe("connected");
    expect(kept?.parts.map((p) => [p.tenantId, p.state])).toEqual([[EU_BRAND.tenantId, "active"]]);
    expect(changes().filter((c) => c.kind === "brand.left")).toEqual([expect.objectContaining({ organisationId: ORG, tenantId: US_BRAND.tenantId, to: "org_ten_fernhill-us", actor: "usr_priya" })]);
  });

  it("takes an emptied id up again only after disconnecting what it still holds: no live connection, no secret to open", async () => {
    vi.stubEnv("CONNECTORS_VAULT_KEY", "brands-test-vault-root-0123456789abcdef");
    // org_ten_fernhill-us was left empty by an earlier move, holding a token another owner pasted.
    seedOrg("org_ten_fernhill-us", "Old Fernhill US", "pro", [], ["usr_old"]);
    const old = "ocn_oooooooooooooooooooo";
    await seedSource(w, { id: old, organisationId: "org_ten_fernhill-us", region: "us", connectedFromTenantId: US_BRAND.tenantId, secrets: { token: sealConnectorSecret("org_ten_fernhill-us", old, "token", "made-up-old-token", new Date(T0)) } });

    const r = await moveBrandOut(owner, US_BRAND.tenantId, deps());
    expect(r).toMatchObject({ ok: true, value: { organisationId: "org_ten_fernhill-us" } });
    const was = await getOrganisationConnection("org_ten_fernhill-us", old, "us", { regionDb: w.regionDb });
    expect(was).toMatchObject({ status: "disconnected", secrets: {} });
    expect(w.us.raw("organisations", "org_ten_fernhill-us")).toMatchObject({ ownerIds: ["usr_priya"], plan: "ultra", brandIds: [US_BRAND.tenantId] });
  });

  it("refuses, with nothing moved, when what an emptied id holds can't be read", async () => {
    seedOrg("org_ten_fernhill-us", "Old Fernhill US", "pro", [], ["usr_old"]);
    const broken = { ...deps(), regionDb: (r: Region) => (r === "asia" ? ({ collection: () => { throw new Error("unavailable"); } } as never) : w.regionDb(r)) };
    expect(await moveBrandOut(owner, US_BRAND.tenantId, broken)).toMatchObject({ ok: false, status: 503, error: "busy" });
    expect(w.us.raw("tenants", US_BRAND.tenantId)).toMatchObject({ organisationId: ORG });
  });

  it("refuses the brand Priya reaches only as her home brand, naming why", async () => {
    const r = await moveBrandOut(owner, EU_BRAND.tenantId, deps());
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      error: "home_only",
      message: "You can't move Fernhill Plants out here. Moves need you on Fernhill Plants' team as an admin, and you reach Fernhill Plants as the brand you first signed in with. Ask whoever runs YouGrow to add you to its team, or to move it for you.",
    });
    expect(w.us.raw("tenants", EU_BRAND.tenantId)).toMatchObject({ organisationId: ORG });
  });

  it("moves the brand Priya is in once she has a row, and refuses a brand alone or in another organisation", async () => {
    row("usr_priya", EU_BRAND.tenantId);
    expect(await moveBrandOut(owner, "ten_cafe", deps())).toMatchObject({ ok: false, status: 404 });
    expect(await moveBrandOut(owner, "ten_otto", deps())).toMatchObject({ ok: false, status: 403, error: "not_owner_there" });
    const moved = await moveBrandOut(owner, EU_BRAND.tenantId, deps());
    // Its own org_ten_fernhill is Fernhill Group itself, which still lists Fernhill US: a new id.
    expect(moved.ok && moved.value.organisationId).toMatch(/^org_ten_fernhill_[a-z0-9]{6}$/);
    expect(w.us.raw("organisations", ORG)?.brandIds).toEqual([US_BRAND.tenantId]);
    const alone = await organisationOwnerOf(owner.ctx, owner.person, { controlDb: w.us });
    if (!alone.ok) throw new Error(alone.why);
    expect(await moveBrandOut(alone.owner, EU_BRAND.tenantId, deps())).toMatchObject({ ok: false, status: 409, error: "alone" });
  });
});

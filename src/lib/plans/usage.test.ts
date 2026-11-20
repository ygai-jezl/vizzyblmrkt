import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { recordingFirestore } from "@/lib/tenant/testing/recordingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { attachBrandToOrganisation, ensureBrandOrganisation, getTenantById } from "@/lib/tenant";
import { planById } from "./catalog";
import { checkAllowance, mayAddUser, organisationAllowance, organisationUsage, type UsageDeps } from "./usage";

const T0 = "2026-11-01T00:00:00.000Z";
const NOW = new Date("2026-11-20T12:00:00.000Z");

function brand(name: string, region: Region, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantName: name,
    rootDomain: `${name.toLowerCase()}.example.com`,
    status: "active",
    region,
    allowedOrigins: [],
    ownerId: "usr_owner",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const ctxOf = (tenantId: string, region: Region, userId: string, role: "admin" | "member" = "admin"): TenantContext => ({ tenantId, region, userId, role, source: "idtoken" });

let control: FakeFirestore;
let us: FakeFirestore;
let eu: FakeFirestore;
let deps: UsageDeps;

function seedPeople(db: FakeFirestore, tenantId: string, all: number, other = 0) {
  for (let i = 0; i < all; i += 1) db.seed("contacts", `${tenantId}_p${i}`, { tenantId, memberOf: ["all", "via:form"], email: `p${i}@example.com` });
  for (let i = 0; i < other; i += 1) db.seed("contacts", `${tenantId}_o${i}`, { tenantId, memberOf: ["via:site"], email: `o${i}@example.com` });
}

beforeEach(() => {
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("GRANTED_ONLY_FEATURES", "");
  vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
  for (const s of ["BRAND_MAP_NEXT_UP_ENABLED", "CREATE_ARTICLE_AUTOPILOT_ENABLED", "COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED"]) vi.stubEnv(s, "");
  control = new FakeFirestore();
  us = new FakeFirestore();
  eu = new FakeFirestore();
  deps = { db: control, dataDb: (r) => (r === "eu" ? eu : us), now: () => NOW };

  // Acme (us) and Beta (eu) share a Pro organisation; usr_owner owns it.
  control.seed("tenants", "ten_A", brand("Acme", "us", { organisationId: "org_ten_A", orgPlan: "pro" }));
  control.seed("tenants", "ten_B", brand("Beta", "eu", { organisationId: "org_ten_A", orgPlan: "pro" }));
  control.seed("organisations", "org_ten_A", {
    name: "Acme group",
    plan: "pro",
    planSince: T0,
    brandIds: ["ten_A", "ten_B"],
    ownerIds: ["usr_owner"],
    createdBy: "backfill",
    createdAt: T0,
    updatedAt: T0,
  });
  for (const [id, userId, tenantId] of [
    ["ten_A_usr_owner", "usr_owner", "ten_A"],
    ["ten_B_usr_owner", "usr_owner", "ten_B"],
    ["ten_A_usr_member", "usr_member", "ten_A"],
  ]) control.seed("tenant_users", id!, { userId, tenantId, role: "admin", joinedAt: T0 });

  seedPeople(us, "ten_A", 3, 1);
  seedPeople(eu, "ten_B", 2);
  // Beta's rows in the wrong region's database would be a residency bug; they must never count.
  seedPeople(us, "ten_B", 7);
  us.seed("campaigns", "c1", { tenantId: "ten_A" });
  us.seed("campaigns", "c2", { tenantId: "ten_A", archivedAt: null });
  us.seed("campaigns", "c3", { tenantId: "ten_A", archivedAt: T0 });
  eu.seed("campaigns", "c4", { tenantId: "ten_B" });
});

afterEach(() => vi.unstubAllEnvs());

describe("organisationUsage", () => {
  it("shows an owner the whole organisation, across regions, with each user counted once", async () => {
    // The owner's role claim is member: the organisation's ownerIds decide, never the role.
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner", "member"), deps);

    expect(s.month).toBe("2026-11");
    expect(s.plan).toBe("pro");
    expect(s.organisation).toEqual({ id: "org_ten_A", name: "Acme group", plan: "pro", planSince: T0, owner: true, view: "organisation" });
    expect(s.thisBrand).toMatchObject({ id: "ten_A", name: "Acme", region: "us", people: 3, liveLaunches: 2, liveLaunchesCapped: false, liveLaunchesLimit: 5 });
    expect(s.brands).toEqual([
      { id: "ten_A", name: "Acme", region: "us", status: "active", isThis: true, people: 3, liveLaunches: 2, liveLaunchesCapped: false },
      { id: "ten_B", name: "Beta", region: "eu", status: "active", isThis: false, people: 2, liveLaunches: 1, liveLaunchesCapped: false },
    ]);
    const a = Object.fromEntries(s.allowances!.map((r) => [r.key, r]));
    expect(a.brands).toMatchObject({ used: 2, limit: 3, counted: true, scope: "organisation", over: false });
    expect(a.users).toMatchObject({ used: 2, limit: null, counted: true });
    expect(a.people).toMatchObject({ used: 5, limit: 10000, counted: true });
    expect(a.liveIdeas).toMatchObject({ label: "Live launches", used: 2, limit: 5, scope: "brand" });
  });

  it("leaves emails and AI credits not counted, with AI credits per user", async () => {
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    const a = Object.fromEntries(s.allowances!.map((r) => [r.key, r]));
    expect(a.emailsPerMonth).toMatchObject({ used: null, counted: false, limit: 5000, over: false });
    expect(a.aiCreditsPerMonth).toMatchObject({ used: null, counted: false, limit: 500, perUser: true });
  });

  it("shows anyone else only this brand, and reads no other brand", async () => {
    const asked: string[] = [];
    const load = vi.fn((id: string) => getTenantById(id, control));
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_member", "admin"), {
      ...deps,
      db: recordingFirestore(control, asked),
      dataDb: (r) => recordingFirestore(r === "eu" ? eu : us, asked),
      loadTenant: load,
    });

    expect(s.organisation).toEqual({ id: null, name: null, plan: "pro", planSince: T0, owner: false, view: "brand" });
    expect(s.brands).toBeNull();
    expect(s.allowances).toBeNull();
    expect(s.thisBrand).toMatchObject({ people: 3, liveLaunches: 2 });
    expect(load.mock.calls.map(([id]) => id)).toEqual(["ten_A"]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((id) => id === "ten_A")).toBe(true);
  });

  it("never names the other brand to someone who isn't an owner after brands are combined", async () => {
    control.seed("tenants", "ten_stealth", brand("Stealth Project", "us"));
    control.seed("tenants", "ten_quill", brand("Quill", "us"));
    control.seed("tenant_users", "ten_quill_usr_quill", { userId: "usr_quill", tenantId: "ten_quill", role: "admin", joinedAt: T0 });
    await ensureBrandOrganisation("ten_stealth", { plan: "pro", createdBy: "backfill", ownerIds: ["usr_owner"] }, control);
    await ensureBrandOrganisation("ten_quill", { plan: "free", createdBy: "backfill", ownerIds: ["usr_quill"] }, control);
    expect(await attachBrandToOrganisation("ten_quill", "org_ten_stealth", { actor: "move-brand:test" }, control)).toBe("moved");

    const s = await organisationUsage(ctxOf("ten_quill", "us", "usr_quill"), deps);
    expect(s.organisation).toMatchObject({ id: null, name: null, plan: "pro", owner: false, view: "brand" });
    expect(JSON.stringify(s)).not.toMatch(/stealth/i);

    // Its owner sees the organisation, still named after the brand it was made for.
    const owner = await organisationUsage(ctxOf("ten_quill", "us", "usr_owner"), deps);
    expect(owner.organisation).toMatchObject({ id: "org_ten_stealth", name: "Stealth Project", view: "organisation" });
    expect(owner.brands?.map((b) => b.name)).toEqual(["Stealth Project", "Quill"]);
  });

  it("shows and counts no listed brand whose own record points at another organisation", async () => {
    // Drift (--check reports it): org_ten_A lists ten_C, but ten_C belongs to org_ten_C.
    control.seed("tenants", "ten_C", brand("OtherCo", "us", { organisationId: "org_ten_C", orgPlan: "free" }));
    control.seed("organisations", "org_ten_C", { name: "OtherCo", plan: "free", planSince: T0, brandIds: ["ten_C"], ownerIds: ["usr_c"], createdBy: "backfill", createdAt: T0, updatedAt: T0 });
    control.seed("organisations", "org_ten_A", { ...control.raw("organisations", "org_ten_A"), brandIds: ["ten_A", "ten_B", "ten_C"] });
    seedPeople(us, "ten_C", 4);

    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    expect(s.brands?.map((b) => b.id)).toEqual(["ten_A", "ten_B"]);
    expect(JSON.stringify(s.brands)).not.toContain("OtherCo");
    // People can't be totalled without it, so the line says so rather than undercounting.
    expect(s.allowances?.find((r) => r.key === "people")?.used).toBeNull();
  });

  it("shows a one-brand organisation to any viewer", async () => {
    control.seed("tenants", "ten_C", brand("Gamma", "us", { organisationId: "org_ten_C", orgPlan: "free" }));
    control.seed("organisations", "org_ten_C", { name: "Gamma", plan: "free", planSince: T0, brandIds: ["ten_C"], ownerIds: [], createdBy: "backfill", createdAt: T0, updatedAt: T0 });

    const s = await organisationUsage(ctxOf("ten_C", "us", "usr_member", "member"), deps);

    expect(s.organisation).toMatchObject({ owner: false, view: "organisation" });
    expect(s.brands?.map((b) => b.id)).toEqual(["ten_C"]);
    expect(s.allowances?.find((r) => r.key === "aiCreditsPerMonth")).toMatchObject({ limit: 50, perUser: false });
  });

  it("counts people by the all tag only with person links on", async () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "");
    expect((await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps)).thisBrand.people).toBe(4);
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    expect((await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps)).thisBrand.people).toBe(3);
  });

  it("lists and counts a suspended brand, marked as such", async () => {
    control.seed("tenants", "ten_B", brand("Beta", "eu", { organisationId: "org_ten_A", orgPlan: "pro", status: "suspended" }));
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    expect(s.brands?.find((b) => b.id === "ten_B")?.status).toBe("suspended");
    expect(s.allowances?.find((r) => r.key === "brands")?.used).toBe(2);
  });

  it("gives null for a count that fails, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = failingFirestore(eu, { collections: ["contacts", "campaigns"] });
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), { ...deps, dataDb: (r) => (r === "eu" ? broken : us) });

    expect(s.brands?.find((b) => b.id === "ten_B")).toMatchObject({ people: null, liveLaunches: null });
    expect(s.allowances?.find((r) => r.key === "people")?.used).toBeNull();
    expect(s.thisBrand.people).toBe(3);
    warn.mockRestore();
  });

  it("shows monthly rows only for features whose switch is on", async () => {
    us.seed("brand_signals", "s1", { tenantId: "ten_A", lookupMonth: "2026-11" });
    us.seed("brand_signals", "s2", { tenantId: "ten_A", lookupMonth: "2026-11" });
    us.seed("brand_signals", "s3", { tenantId: "ten_A", lookupMonth: "2026-10" });
    us.seed("autopilot_runs", "r1", { tenantId: "ten_A", month: "2026-11", mode: "draft", planId: "pl_1" });
    us.seed("autopilot_runs", "r2", { tenantId: "ten_A", month: "2026-11", mode: "suggest" });

    expect((await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps)).monthly).toEqual([]);

    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "true");
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    expect(s.monthly).toEqual([
      { feature: "next_up", label: "Next up", used: 2, limit: 100, from: "default", included: false },
      { feature: "article_autopilot", label: "Article autopilot", used: 1, limit: 4, from: "plan", included: true },
    ]);
  });

  it("lists what the plan includes, and a brand's own grants", async () => {
    control.seed("tenants", "ten_A", brand("Acme", "us", { organisationId: "org_ten_A", orgPlan: "pro", grantedFeatures: ["competitors"] }));
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    const f = Object.fromEntries(s.features.map((r) => [r.feature, r]));
    expect(f.brand_search).toMatchObject({ included: true, granted: false, usable: true });
    expect(f.competitors).toMatchObject({ label: "Competitors", included: false, granted: true, usable: true });
    expect(f.next_up).toMatchObject({ included: false, granted: false, usable: false });
    expect(f.sso).toBeUndefined();
  });

  it("ignores organisations and plan copies with plans off", async () => {
    vi.stubEnv("PLANS_ENABLED", "false");
    const s = await organisationUsage(ctxOf("ten_A", "us", "usr_owner"), deps);
    expect(s).toMatchObject({ plansOn: false, plan: null, organisation: null, brands: null, allowances: null });
    expect(s.features.every((f) => f.included && f.usable)).toBe(true);
    expect(s.thisBrand.liveLaunchesLimit).toBeNull();
  });

  it("shows no organisation when the brand has none, or its organisation doesn't list it", async () => {
    control.seed("tenants", "ten_D", brand("Delta", "us"));
    const none = await organisationUsage(ctxOf("ten_D", "us", "usr_owner"), deps);
    expect(none).toMatchObject({ plan: null, organisation: null, brands: null });

    control.seed("tenants", "ten_E", brand("Echo", "us", { organisationId: "org_ten_A", orgPlan: "pro" }));
    const drift = await organisationUsage(ctxOf("ten_E", "us", "usr_owner"), deps);
    expect(drift.organisation).toBeNull();
    expect(drift.plan).toBe("pro");
  });
});

describe("allowances", () => {
  it("checkAllowance is allowed with plans off, or with no organisation", async () => {
    vi.stubEnv("PLANS_ENABLED", "false");
    expect(await checkAllowance(ctxOf("ten_A", "us", "usr_owner"), "brands", 5, deps)).toMatchObject({ allowed: true, organisationId: null });
    vi.stubEnv("PLANS_ENABLED", "true");
    control.seed("tenants", "ten_D", brand("Delta", "us"));
    expect(await checkAllowance(ctxOf("ten_D", "us", "usr_owner"), "brands", 1, deps)).toMatchObject({ allowed: true, organisationId: null });
  });

  it("checkAllowance is not allowed at the limit, and allowed with no limit or no count", async () => {
    const ctx = ctxOf("ten_A", "us", "usr_owner");
    expect(await checkAllowance(ctx, "brands", 1, deps)).toEqual({ allowed: true, used: 2, limit: 3, organisationId: "org_ten_A" });
    expect(await checkAllowance(ctx, "brands", 2, deps)).toMatchObject({ allowed: false, used: 2, limit: 3 });
    expect(await checkAllowance(ctx, "users", 50, deps)).toMatchObject({ allowed: true, used: 2, limit: null });
    expect(await checkAllowance(ctx, "emailsPerMonth", 10_000, deps)).toMatchObject({ allowed: true });

    control.seed("organisations", "org_ten_A", { ...control.raw("organisations", "org_ten_A"), plan: "free" });
    expect(await checkAllowance(ctx, "liveIdeas", 1, deps)).toMatchObject({ allowed: false, used: 2, limit: 1 });
    expect(await checkAllowance(ctx, "people", 1, deps)).toMatchObject({ allowed: true, used: 5, limit: 1000 });
  });

  it("organisationAllowance counts each allowance against the plan", async () => {
    const org = { plan: "pro" as const, brandIds: ["ten_A", "ten_B"] };
    expect(await organisationAllowance(org, "brands", deps)).toEqual({ used: 2, limit: 3, counted: true });
    expect(await organisationAllowance(org, "people", deps)).toEqual({ used: 5, limit: 10000, counted: true });
    expect(await organisationAllowance(org, "aiCreditsPerMonth", deps)).toEqual({ used: null, limit: 500, counted: false });
    expect(await organisationAllowance(org, "liveIdeas", deps)).toEqual({ used: null, limit: 5, counted: false });
    expect(await organisationAllowance(org, "liveIdeas", deps, { tenantId: "ten_B", region: "eu" })).toEqual({ used: 1, limit: 5, counted: true });
  });

  it("mayAddUser lets in someone already there, and stops at the users limit", () => {
    const free = planById("free");
    const two = new Set(["usr_1", "usr_2"]);
    expect(mayAddUser({ plan: "free" }, free, "usr_3", two)).toBe(false);
    expect(mayAddUser({ plan: "free" }, null, "usr_2", two)).toBe(true);
    expect(mayAddUser({ plan: "free" }, null, "usr_3", new Set(["usr_1"]))).toBe(true);
    expect(mayAddUser({ plan: "pro" }, null, "usr_3", two)).toBe(true);
    expect(mayAddUser({ plan: "free" }, planById("ultra"), "usr_3", two)).toBe(true);
  });
});

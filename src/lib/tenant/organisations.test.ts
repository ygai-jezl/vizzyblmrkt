import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  ORGANISATIONS,
  ORGANISATION_CHANGES,
  OPERATOR_LABEL,
  attachBrandToOrganisation,
  ensureBrandOrganisation,
  getOrganisation,
  hasDrift,
  listOrganisations,
  moveBrandToNewOrganisation,
  organisationDrift,
  organisationIdFor,
  organisationUserIds,
  scriptActor,
  setOrganisationName,
  setOrganisationOwners,
  setOrganisationPlan,
} from "./organisations";
import { getTenantById } from "./registry";
import { OrganisationChangeSchema, OrganisationSchema } from "@/lib/types/organisation";

const T0 = "2026-11-01T00:00:00.000Z";

function brand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantName: "Acme",
    rootDomain: "acme.example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://acme.example.com"],
    ownerId: "usr_owner",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function org(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Acme",
    plan: "ultra",
    planSince: T0,
    brandIds: [],
    ownerIds: [],
    createdBy: "backfill",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const changes = (db: FakeFirestore) => db.dump(ORGANISATION_CHANGES).map((r) => OrganisationChangeSchema.parse(r));
const kinds = (db: FakeFirestore) => changes(db).map((c) => c.kind).sort();

describe("organisations", () => {
  afterEach(() => vi.useRealTimers());

  describe("ensureBrandOrganisation", () => {
    it("creates org_<id>, links the brand, copies the plan and logs it", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());

      const res = await ensureBrandOrganisation("ten_A", { plan: "free", createdBy: "usr_maker", ownerIds: ["usr_maker"], actor: "usr_maker" }, db);

      expect(res).toEqual({ status: "created", organisationId: "org_ten_A" });
      expect(organisationIdFor("ten_A")).toBe("org_ten_A");
      const o = await getOrganisation("org_ten_A", db);
      expect(o).toMatchObject({ id: "org_ten_A", name: "Acme", plan: "free", brandIds: ["ten_A"], ownerIds: ["usr_maker"], createdBy: "usr_maker" });
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.id).toBeUndefined();
      const t = await getTenantById("ten_A", db);
      expect(t?.organisationId).toBe("org_ten_A");
      expect(t?.orgPlan).toBe("free");
      expect(kinds(db)).toEqual(["brand.joined", "organisation.created"]);
      expect(changes(db).every((c) => c.actor === "usr_maker" && c.organisationId === "org_ten_A")).toBe(true);
      expect(changes(db).find((c) => c.kind === "brand.joined")?.tenantId).toBe("ten_A");
    });

    it("leaves owners empty unless they are given (never inferred from the brand's ownerId)", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      await ensureBrandOrganisation("ten_A", { plan: "ultra", createdBy: "backfill", actor: "backfill:ops" }, db);
      expect((await getOrganisation("org_ten_A", db))?.ownerIds).toEqual([]);
      expect(changes(db).every((c) => c.actor === "backfill:ops")).toBe(true);
    });

    it("runs again with no extra writes", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      await ensureBrandOrganisation("ten_A", { plan: "ultra", createdBy: "backfill" }, db);
      const writes = [db.writeCountFor("tenants", "ten_A"), db.writeCountFor(ORGANISATIONS, "org_ten_A"), db.dump(ORGANISATION_CHANGES).length];

      expect(await ensureBrandOrganisation("ten_A", { plan: "free", createdBy: "backfill" }, db)).toEqual({ status: "exists", organisationId: "org_ten_A" });
      expect([db.writeCountFor("tenants", "ten_A"), db.writeCountFor(ORGANISATIONS, "org_ten_A"), db.dump(ORGANISATION_CHANGES).length]).toEqual(writes);
      expect((await getOrganisation("org_ten_A", db))?.plan).toBe("ultra");
    });

    it("never moves a brand that is already in another organisation", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_B", brand({ organisationId: "org_ten_A", orgPlan: "pro" }));
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "pro", brandIds: ["ten_A", "ten_B"] }));

      expect(await ensureBrandOrganisation("ten_B", { plan: "free", createdBy: "usr_1" }, db)).toEqual({ status: "exists", organisationId: "org_ten_A" });
      expect(db.raw("tenants", "ten_B")?.organisationId).toBe("org_ten_A");
      expect(db.raw(ORGANISATIONS, "org_ten_B")).toBeUndefined();
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
    });

    it("reuses an empty org_<id> left by a move, on the new plan", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "ultra", brandIds: [], ownerIds: ["usr_1"] }));

      expect(await ensureBrandOrganisation("ten_A", { plan: "pro", createdBy: "backfill" }, db)).toEqual({ status: "created", organisationId: "org_ten_A" });
      const o = await getOrganisation("org_ten_A", db);
      expect(o).toMatchObject({ plan: "pro", brandIds: ["ten_A"], ownerIds: ["usr_1"], createdAt: T0 });
      expect(db.raw("tenants", "ten_A")).toMatchObject({ organisationId: "org_ten_A", orgPlan: "pro" });
      expect(kinds(db)).toEqual(["brand.joined", "plan.changed"]);
    });

    it("gives conflict when org_<id> lists other brands, and writes nothing", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_X"] }));

      expect(await ensureBrandOrganisation("ten_A", { plan: "pro", createdBy: "backfill" }, db)).toEqual({ status: "conflict", organisationId: "org_ten_A" });
      expect(db.raw("tenants", "ten_A")?.organisationId).toBeUndefined();
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.brandIds).toEqual(["ten_X"]);
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
    });

    it("relinks a brand its organisation lists, on the organisation's plan", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "pro", brandIds: ["ten_A"] }));

      expect(await ensureBrandOrganisation("ten_A", { plan: "free", createdBy: "backfill" }, db)).toEqual({ status: "exists", organisationId: "org_ten_A" });
      expect(db.raw("tenants", "ten_A")).toMatchObject({ organisationId: "org_ten_A", orgPlan: "pro" });
    });

    it("says missing_brand for an unknown id, and refuses an unknown plan", async () => {
      const db = new FakeFirestore();
      expect(await ensureBrandOrganisation("ten_nope", { plan: "free", createdBy: "backfill" }, db)).toEqual({ status: "missing_brand" });
      expect(db.dump(ORGANISATIONS)).toHaveLength(0);
      db.seed("tenants", "ten_A", brand());
      await expect(ensureBrandOrganisation("ten_A", { plan: "platinum" as never, createdBy: "backfill" }, db)).rejects.toThrow(/unknown plan/);
    });
  });

  it("writes two change rows for two brands joined in the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
    const db = new FakeFirestore();
    db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"] }));
    db.seed("tenants", "ten_B", brand());
    db.seed("tenants", "ten_C", brand());

    expect(await attachBrandToOrganisation("ten_B", "org_ten_A", { actor: "script:ops" }, db)).toBe("moved");
    expect(await attachBrandToOrganisation("ten_C", "org_ten_A", { actor: "script:ops" }, db)).toBe("moved");

    const joined = changes(db).filter((c) => c.kind === "brand.joined");
    expect(joined.map((c) => c.tenantId).sort()).toEqual(["ten_B", "ten_C"]);
    expect(new Set(joined.map((c) => c.at)).size).toBe(1);
    expect(db.raw(ORGANISATIONS, "org_ten_A")?.brandIds).toEqual(["ten_A", "ten_B", "ten_C"]);
  });

  describe("setOrganisationPlan", () => {
    it("puts the organisation and every brand it lists on the plan, in one transaction", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "ultra", brandIds: ["ten_A", "ten_B"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));
      db.seed("tenants", "ten_B", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));
      db.seed("tenants", "ten_C", brand({ organisationId: "org_ten_C", orgPlan: "ultra" }));
      const tx = vi.spyOn(db, "runTransaction");

      const res = await setOrganisationPlan("org_ten_A", "free", "script:ops", db);

      expect(tx).toHaveBeenCalledTimes(1);
      expect(res?.organisation.plan).toBe("free");
      expect(res?.organisation.planSince).not.toBe(T0);
      expect(res?.missingBrands).toEqual([]);
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.plan).toBe("free");
      expect(db.raw("tenants", "ten_A")?.orgPlan).toBe("free");
      expect(db.raw("tenants", "ten_B")?.orgPlan).toBe("free");
      expect(db.raw("tenants", "ten_C")?.orgPlan).toBe("ultra");
      expect(db.writeCountFor("tenants", "ten_C")).toBe(0);
      const logged = changes(db);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ kind: "plan.changed", from: "ultra", to: "free", actor: "script:ops", organisationId: "org_ten_A" });
    });

    it("skips and reports a missing brand, and one that points elsewhere", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A", "ten_gone", "ten_D"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));
      db.seed("tenants", "ten_D", brand({ organisationId: "org_ten_D", orgPlan: "ultra" }));

      const res = await setOrganisationPlan("org_ten_A", "pro", "script:ops", db);

      expect(res?.missingBrands).toEqual(["ten_gone"]);
      expect(res?.unlinkedBrands).toEqual(["ten_D"]);
      expect(db.raw("tenants", "ten_A")?.orgPlan).toBe("pro");
      expect(db.raw("tenants", "ten_D")?.orgPlan).toBe("ultra");
      expect(db.raw("tenants", "ten_gone")).toBeUndefined();
    });

    it("repairs the copies and logs nothing when the plan is the same", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "pro", brandIds: ["ten_A"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "free" }));

      const res = await setOrganisationPlan("org_ten_A", "pro", "script:ops", db);

      expect(res?.organisation.planSince).toBe(T0);
      expect(db.raw("tenants", "ten_A")?.orgPlan).toBe("pro");
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
    });

    it("returns null for a missing organisation", async () => {
      const db = new FakeFirestore();
      expect(await setOrganisationPlan("org_nope", "pro", "script:ops", db)).toBeNull();
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
    });
  });

  describe("attachBrandToOrganisation", () => {
    it("moves a brand: the old organisation loses it and is kept, the new one gains it and its plan", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "pro", brandIds: ["ten_A"] }));
      db.seed(ORGANISATIONS, "org_ten_B", org("org_ten_B", { plan: "ultra", brandIds: ["ten_B"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "pro" }));
      db.seed("tenants", "ten_B", brand({ organisationId: "org_ten_B", orgPlan: "ultra" }));

      expect(await attachBrandToOrganisation("ten_B", "org_ten_A", { actor: "script:ops", maxBrands: 3 }, db)).toBe("moved");

      expect(db.raw(ORGANISATIONS, "org_ten_B")).toMatchObject({ brandIds: [] });
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.brandIds).toEqual(["ten_A", "ten_B"]);
      expect(db.raw("tenants", "ten_B")).toMatchObject({ organisationId: "org_ten_A", orgPlan: "pro" });
      const logged = changes(db);
      expect(logged.find((c) => c.kind === "brand.left")).toMatchObject({ organisationId: "org_ten_B", tenantId: "ten_B", to: "org_ten_A" });
      expect(logged.find((c) => c.kind === "brand.joined")).toMatchObject({ organisationId: "org_ten_A", tenantId: "ten_B", from: "org_ten_B" });
      expect(await attachBrandToOrganisation("ten_B", "org_ten_A", { actor: "script:ops" }, db)).toBe("already");
    });

    it("refuses at the brands allowance with no writes", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "free", brandIds: ["ten_A"] }));
      db.seed("tenants", "ten_B", brand());

      expect(await attachBrandToOrganisation("ten_B", "org_ten_A", { actor: "script:ops", maxBrands: 1 }, db)).toBe("full");
      expect(db.writeCountFor(ORGANISATIONS, "org_ten_A")).toBe(0);
      expect(db.writeCountFor("tenants", "ten_B")).toBe(0);
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
    });

    it("says missing for an unknown brand or organisation", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_B", brand());
      expect(await attachBrandToOrganisation("ten_B", "org_nope", { actor: "script:ops" }, db)).toBe("missing");
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"] }));
      expect(await attachBrandToOrganisation("ten_nope", "org_ten_A", { actor: "script:ops" }, db)).toBe("missing");
    });
  });

  describe("moveBrandToNewOrganisation", () => {
    it("splits a brand out into its own empty org_<id>, keeping the one it leaves", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "ultra", brandIds: ["ten_A", "ten_B"] }));
      db.seed(ORGANISATIONS, "org_ten_B", org("org_ten_B", { plan: "ultra", brandIds: [] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));
      db.seed("tenants", "ten_B", brand({ tenantName: "Beta", organisationId: "org_ten_A", orgPlan: "ultra" }));

      expect(await moveBrandToNewOrganisation("ten_B", { plan: "pro", actor: "script:ops" }, db)).toEqual({ organisationId: "org_ten_B", moved: true });

      expect(db.raw(ORGANISATIONS, "org_ten_A")?.brandIds).toEqual(["ten_A"]);
      expect(await getOrganisation("org_ten_B", db)).toMatchObject({ name: "Beta", plan: "pro", brandIds: ["ten_B"] });
      expect(db.raw("tenants", "ten_B")).toMatchObject({ organisationId: "org_ten_B", orgPlan: "pro" });
      expect(kinds(db)).toEqual(["brand.joined", "brand.left", "plan.changed"]);
    });

    it("makes a suffixed id when org_<id> lists other brands", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { plan: "ultra", brandIds: ["ten_A", "ten_B"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));
      db.seed("tenants", "ten_B", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));

      const res = await moveBrandToNewOrganisation("ten_A", { plan: "free", actor: "script:ops" }, db);

      expect(res?.organisationId).toMatch(/^org_ten_A_[a-z0-9]{6}$/);
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.brandIds).toEqual(["ten_B"]);
      expect(await getOrganisation(res!.organisationId, db)).toMatchObject({ plan: "free", brandIds: ["ten_A"], createdBy: "script:ops" });
      expect(db.raw("tenants", "ten_A")).toMatchObject({ organisationId: res!.organisationId, orgPlan: "free" });
      expect(kinds(db)).toEqual(["brand.joined", "brand.left", "organisation.created"]);
    });

    it("leaves a brand that is already alone where it is, and gives null for an unknown brand", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"] }));
      db.seed("tenants", "ten_A", brand({ organisationId: "org_ten_A", orgPlan: "ultra" }));

      expect(await moveBrandToNewOrganisation("ten_A", { plan: "free", actor: "script:ops" }, db)).toEqual({ organisationId: "org_ten_A", moved: false });
      expect(db.dump(ORGANISATION_CHANGES)).toHaveLength(0);
      expect(await moveBrandToNewOrganisation("ten_nope", { plan: "free", actor: "script:ops" }, db)).toBeNull();
    });
  });

  describe("setOrganisationOwners and setOrganisationName", () => {
    it("adds and removes owners, and logs the change", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"], ownerIds: ["usr_1", "usr_2"] }));

      const o = await setOrganisationOwners("org_ten_A", { add: ["usr_3", "usr_1"], remove: ["usr_2"] }, "script:ops", db);

      expect(o).not.toBe("too_many");
      expect((o as { ownerIds: string[] }).ownerIds).toEqual(["usr_1", "usr_3"]);
      expect(db.raw(ORGANISATIONS, "org_ten_A")?.ownerIds).toEqual(["usr_1", "usr_3"]);
      expect(changes(db)[0]).toMatchObject({ kind: "owners.changed", from: ["usr_1", "usr_2"], to: ["usr_1", "usr_3"] });
      expect(await setOrganisationOwners("org_ten_A", { add: ["usr_3"] }, "script:ops", db)).toMatchObject({ ownerIds: ["usr_1", "usr_3"] });
      expect(changes(db)).toHaveLength(1);
    });

    it("refuses more than 20 owners with no writes", async () => {
      const db = new FakeFirestore();
      const twenty = Array.from({ length: 20 }, (_, i) => `usr_${i}`);
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"], ownerIds: twenty }));

      expect(await setOrganisationOwners("org_ten_A", { add: ["usr_new"] }, "script:ops", db)).toBe("too_many");
      expect(db.writeCountFor(ORGANISATIONS, "org_ten_A")).toBe(0);
      expect(await setOrganisationOwners("org_nope", { add: ["usr_new"] }, "script:ops", db)).toBeNull();
    });

    it("renames an organisation and logs it", async () => {
      const db = new FakeFirestore();
      db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"] }));

      expect((await setOrganisationName("org_ten_A", "  Acme Group ", "script:ops", db))?.name).toBe("Acme Group");
      expect(changes(db)[0]).toMatchObject({ kind: "organisation.renamed", from: "Acme", to: "Acme Group" });
      await expect(setOrganisationName("org_ten_A", " ", "script:ops", db)).rejects.toThrow();
      expect(await setOrganisationName("org_nope", "Name", "script:ops", db)).toBeNull();
    });
  });

  describe("organisationUserIds", () => {
    it("counts a person in two brands once", async () => {
      const db = new FakeFirestore();
      db.seed("tenant_users", "ten_A_usr_1", { userId: "usr_1", tenantId: "ten_A", role: "admin", joinedAt: T0 });
      db.seed("tenant_users", "ten_B_usr_1", { userId: "usr_1", tenantId: "ten_B", role: "member", joinedAt: T0 });
      db.seed("tenant_users", "ten_B_usr_2", { userId: "usr_2", tenantId: "ten_B", role: "member", joinedAt: T0 });
      db.seed("tenant_users", "ten_X_usr_3", { userId: "usr_3", tenantId: "ten_X", role: "admin", joinedAt: T0 });

      expect([...(await organisationUserIds({ brandIds: ["ten_A", "ten_B"] }, db))].sort()).toEqual(["usr_1", "usr_2"]);
    });

    it("reads more than 30 brands in chunks", async () => {
      const db = new FakeFirestore();
      const ids = Array.from({ length: 65 }, (_, i) => `ten_${i}`);
      for (const [i, id] of ids.entries()) db.seed("tenant_users", `${id}_u`, { userId: `usr_${i % 40}`, tenantId: id, role: "admin", joinedAt: T0 });
      const where = vi.fn();
      const spied = { ...db, collection: (name: string) => {
        const c = db.collection(name);
        return { ...c, where: (f: string, op: never, v: unknown) => (where(v), c.where(f, op, v)) } as never;
      }, runTransaction: db.runTransaction.bind(db) };

      expect((await organisationUserIds({ brandIds: ids }, spied as never)).size).toBe(40);
      expect(where.mock.calls.map(([v]) => (v as string[]).length)).toEqual([30, 30, 5]);
    });
  });

  describe("scriptActor", () => {
    it("records <tool>:<label> for a plain label", () => {
      expect(scriptActor("script", "ops")).toBe("script:ops");
      expect(scriptActor("backfill", "jo_2-b")).toBe("backfill:jo_2-b");
    });

    it.each([undefined, "", "Jo", "jo@example.com", "example.test", "-jo", "a".repeat(41), "jo smith"])("refuses %s, so no email or domain is stored", (label) => {
      expect(() => scriptActor("script", label)).toThrow(/--by/);
      if (label) expect(OPERATOR_LABEL.test(label)).toBe(false);
    });
  });

  describe("organisationDrift", () => {
    const o = (id: string, over: Record<string, unknown> = {}) => OrganisationSchema.parse({ id, ...org(id, over) });

    it("is clean when every brand and organisation agree", () => {
      const d = organisationDrift(
        [
          { id: "ten_A", organisationId: "org_ten_A", orgPlan: "ultra" },
          { id: "ten_B", organisationId: "org_ten_A", orgPlan: "ultra" },
        ],
        [o("org_ten_A", { brandIds: ["ten_A", "ten_B"], ownerIds: ["usr_owner"] })],
      );
      expect(hasDrift(d)).toBe(false);
      expect(d.ownerless).toEqual([]);
    });

    it("reports open brands, broken links both ways, plan copies and conflicts", () => {
      const d = organisationDrift(
        [
          { id: "ten_open" },
          { id: "ten_conflict" },
          { id: "ten_gone_org", organisationId: "org_missing", orgPlan: "pro" },
          { id: "ten_unlisted", organisationId: "org_ten_A", orgPlan: "ultra" },
          { id: "ten_A", organisationId: "org_ten_A", orgPlan: "pro" },
          { id: "ten_elsewhere", organisationId: "org_ten_elsewhere", orgPlan: "free" },
        ],
        [
          o("org_ten_A", { brandIds: ["ten_A", "ten_deleted", "ten_elsewhere"] }),
          o("org_ten_conflict", { brandIds: ["ten_other"] }),
          o("org_ten_elsewhere", { plan: "free", brandIds: ["ten_elsewhere"] }),
        ],
      );
      expect(hasDrift(d)).toBe(true);
      expect(d.open).toEqual(["ten_open", "ten_conflict"]);
      expect(d.conflicts).toEqual([{ tenantId: "ten_conflict", organisationId: "org_ten_conflict" }]);
      expect(d.missingOrganisation).toEqual([{ tenantId: "ten_gone_org", organisationId: "org_missing" }]);
      expect(d.notListed).toEqual([{ tenantId: "ten_unlisted", organisationId: "org_ten_A" }]);
      expect(d.planDrift).toEqual([{ tenantId: "ten_A", organisationId: "org_ten_A", orgPlan: "pro", plan: "ultra" }]);
      expect(d.missingBrands).toEqual([
        { organisationId: "org_ten_A", tenantId: "ten_deleted" },
        { organisationId: "org_ten_conflict", tenantId: "ten_other" },
      ]);
      expect(d.listedElsewhere).toEqual([{ organisationId: "org_ten_A", tenantId: "ten_elsewhere", linkedTo: "org_ten_elsewhere" }]);
      expect(d.ownerless).toEqual(["org_ten_A"]);
    });

    it("counts a missing or damaged plan copy as drift, and an empty org_<id> as no conflict", () => {
      const d = organisationDrift(
        [{ id: "ten_A", organisationId: "org_ten_A" }, { id: "ten_B" }],
        [o("org_ten_A", { brandIds: ["ten_A"] }), o("org_ten_B", { brandIds: [] })],
      );
      expect(d.planDrift).toEqual([{ tenantId: "ten_A", organisationId: "org_ten_A", orgPlan: null, plan: "ultra" }]);
      expect(d.open).toEqual(["ten_B"]);
      expect(d.conflicts).toEqual([]);
    });

    it("warns, without drift, about a combined organisation nobody owns", () => {
      const d = organisationDrift(
        [
          { id: "ten_A", organisationId: "org_ten_A", orgPlan: "ultra" },
          { id: "ten_B", organisationId: "org_ten_A", orgPlan: "ultra" },
        ],
        [o("org_ten_A", { brandIds: ["ten_A", "ten_B"] })],
      );
      expect(hasDrift(d)).toBe(false);
      expect(d.ownerless).toEqual(["org_ten_A"]);
    });

    it("agrees with ensureBrandOrganisation after a backfill", async () => {
      const db = new FakeFirestore();
      db.seed("tenants", "ten_A", brand());
      db.seed("tenants", "ten_B", brand({ tenantName: "Beta" }));
      for (const id of ["ten_A", "ten_B"]) await ensureBrandOrganisation(id, { plan: "ultra", createdBy: "backfill", actor: "backfill:ops" }, db);
      const brands = await Promise.all(["ten_A", "ten_B"].map((id) => getTenantById(id, db)));
      expect(hasDrift(organisationDrift(brands.map((b) => b!), await listOrganisations(db)))).toBe(false);
    });
  });

  it("reads a damaged organisation as none, and lists only the ones that parse", async () => {
    const db = new FakeFirestore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.seed(ORGANISATIONS, "org_bad", { name: "", plan: "platinum", brandIds: "ten_A" });
    db.seed(ORGANISATIONS, "org_ten_A", org("org_ten_A", { brandIds: ["ten_A"] }));

    expect(await getOrganisation("org_bad", db)).toBeNull();
    expect(await getOrganisation("", db)).toBeNull();
    expect(await getOrganisation("org_none", db)).toBeNull();
    expect((await listOrganisations(db)).map((o) => o.id)).toEqual(["org_ten_A"]);
    warn.mockRestore();
  });
});

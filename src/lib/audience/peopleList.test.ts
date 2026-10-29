import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { suppressEmail } from "@/lib/email/suppression";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { listContacts } from "@/lib/admin/crm";
import { isPeopleTag, listPeople, peopleFilters, PEOPLE_PAGE } from "./peopleList";
import { syncPerson } from "./personSync";

/** Made-up people at .test, synced into person records the way the write paths do it. */

const ISO = (ms: number) => new Date(ms).toISOString();

function seedSignup(db: FakeFirestore, id: string, email: string, over: Record<string, unknown> = {}) {
  db.seed("signups", id, {
    tenantId: TENANT_ID,
    campaignId: "camp1",
    email,
    firstName: email.split("@")[0],
    verified: true,
    captchaValid: true,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: `ref_${id}`,
    referralLink: `https://example.test/r/${id}`,
    score: 0,
    createdAt: ISO(T0),
    ...over,
  });
}

async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  db.seed("campaigns", "camp1", { tenantId: TENANT_ID, waitlistName: "Beta waitlist" });
  seedSignup(db, "s_ada", "ada@customer.test");
  seedSignup(db, "s_bea", "bea@customer.test", { joinedVia: "site", createdAt: ISO(T0 + 1000) });
  seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test" });
  seedUser(db, "cal");
  for (const key of ["ada@customer.test", "bea@customer.test", "cal@customer.test"]) await syncPerson(ctx, key, { db, nowMs: T0 + 3_600_000 });
  return db;
}

const q = (over: Partial<Parameters<typeof listPeople>[1]> = {}) => ({ tag: "all", canEmail: false, q: "", cursor: null, ...over });

describe("listPeople", () => {
  it("lists everyone once, with where each came from", async () => {
    const db = await world();
    const { people, total } = await listPeople(ctx, q(), db);
    expect(total).toBe(3);
    const ada = people.find((p) => p.email === "ada@customer.test")!;
    expect(ada.launches).toEqual([{ id: "camp1", name: "Beta waitlist", status: "verified_active", via: "form" }]);
    expect(ada.products).toEqual([expect.objectContaining({ id: CONNECTION_ID, name: "Sandbox", stage: "new" })]);
  });

  it("shows one group at a time: a launch, the brand's own site, a product, a stage", async () => {
    const db = await world();
    const emails = async (tag: string) => (await listPeople(ctx, q({ tag }), db)).people.map((p) => p.email).sort();
    expect(await emails("launch:camp1")).toEqual(["ada@customer.test", "bea@customer.test"]);
    expect(await emails("via:site")).toEqual(["bea@customer.test"]);
    expect(await emails(`product:${CONNECTION_ID}`)).toEqual(["ada@customer.test", "cal@customer.test"]);
    expect(await emails(`stage:${CONNECTION_ID}:new`)).toEqual(["ada@customer.test", "cal@customer.test"]);
  });

  it("narrows to people we can email, and searches everyone", async () => {
    const db = await world();
    await suppressEmail(system, { email: "bea@customer.test", reason: "unsubscribe", source: "footer" }, db);
    await syncPerson(ctx, "bea@customer.test", { db, nowMs: T0 + 3_600_000 });
    const canEmail = await listPeople(ctx, q({ canEmail: true }), db);
    expect(canEmail.people.map((p) => p.email).sort()).toEqual(["ada@customer.test", "cal@customer.test"]);
    expect(canEmail.total).toBe(2);
    const found = await listPeople(ctx, q({ q: "Bea" }), db);
    expect(found.people.map((p) => p.email)).toEqual(["bea@customer.test"]);
    expect(found.people[0]).toMatchObject({ reach: "no", blocked: "unsubscribe" });
  });

  it("pages by activity without losing people who share a time, and leaves other brands out", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    for (let i = 0; i < PEOPLE_PAGE + 5; i += 1) {
      // Pairs share a sign-up time.
      seedSignup(db, `s_${i}`, `p${i}@customer.test`, { createdAt: ISO(T0 + Math.floor(i / 2) * 1000) });
      await syncPerson(ctx, `p${i}@customer.test`, { db, nowMs: T0 });
    }
    const first = await listPeople(ctx, q(), db);
    expect(first.total).toBe(PEOPLE_PAGE + 5);
    const second = await listPeople(ctx, q({ cursor: first.nextCursor }), db);
    const all = [...first.people, ...second.people].map((p) => p.id);
    expect(new Set(all).size).toBe(PEOPLE_PAGE + 5);
    expect(second.nextCursor).toBeNull();
    expect((await listPeople({ ...ctx, tenantId: "ten_other" }, q(), db)).total).toBe(0);
  });
});

describe("peopleFilters", () => {
  it("counts each group the brand has", async () => {
    const db = await world();
    const f = await peopleFilters(ctx, db);
    expect(f).toMatchObject({ everyone: 3, canEmail: 3, via: { form: 1, site: 1 } });
    expect(f.launches).toEqual([{ id: "camp1", name: "Beta waitlist", count: 2 }]);
    expect(f.products).toEqual([{ id: CONNECTION_ID, name: "Sandbox", count: 2, stages: { new: 2, onboarding: 0, stuck: 0, activated: 0, quiet: 0 } }]);
  });
});

describe("isPeopleTag", () => {
  it("accepts the groups the list shows and nothing else", () => {
    for (const ok of ["all", "launch:any", "launch:camp1", "via:site", "product:pcn_1", "stage:pcn_1:stuck", "quiet:pcn_1"]) expect(isPeopleTag(ok)).toBe(true);
    for (const bad of ["", "everyone", "stage:pcn_1:asleep", "launch:a/b", "group:pcn_1:ws"]) expect(isPeopleTag(bad)).toBe(false);
  });
});

describe("the Signups tab with person records on", () => {
  it("leaves out people who only use a product", async () => {
    const db = await world();
    const rows = await listContacts(ctx, { launchesOnly: true }, db);
    expect(rows.items.map((c) => c.email).sort()).toEqual(["ada@customer.test", "bea@customer.test"]);
    expect((await listContacts(ctx, {}, db)).items).toHaveLength(3);
  });
});

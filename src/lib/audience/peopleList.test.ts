import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { suppressEmail } from "@/lib/email/suppression";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import { listContacts } from "@/lib/admin/crm";
import { setRecordFieldValues } from "@/lib/tenant";
import { fieldOptionCounts, groupLabel, isFilterTag, isPeopleTag, listPeople, parseGroupTag, peopleFilters, PEOPLE_PAGE } from "./peopleList";
import { personIdOf, syncPerson } from "./personSync";
import { saveFieldListChange, type FieldListChange } from "./fieldList";
import { addPerson, withdrawHandConsent } from "./addPerson";
import { parseNewPerson } from "./newPerson";

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

  it("marks someone added by hand, who is in Everyone with no pill of their own", async () => {
    const db = await world();
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam" });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: ISO(T0 + 7_200_000) });
    const { people, total } = await listPeople(ctx, q(), db);
    expect(total).toBe(4);
    expect(people[0]).toMatchObject({ name: "Sam", email: "sam@labs.test", launches: [], products: [], reach: "no", addedByHand: true, consentWithdrawn: false });
    expect(people.filter((p) => p.addedByHand)).toHaveLength(1);
    expect(isPeopleTag("added:hand")).toBe(false);
  });

  it("marks someone whose recorded agreement the team withdrew", async () => {
    const db = await world();
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam", agreed: { how: "in_person" } });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: ISO(T0 + 7_200_000) });
    await withdrawHandConsent(ctx, personIdOf(TENANT_ID, "sam@labs.test"), { note: null }, { db, nowIso: ISO(T0 + 7_260_000) });
    const { people } = await listPeople(ctx, q(), db);
    expect(people.find((p) => p.email === "sam@labs.test")).toMatchObject({ reach: "no", addedByHand: true, consentWithdrawn: true });
    expect(people.filter((p) => p.consentWithdrawn)).toHaveLength(1);
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
      // Everyone shares one sign-up time, as a batch sent in one go does.
      seedSignup(db, `s_${i}`, `p${i}@customer.test`, { createdAt: ISO(T0) });
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
    // A search can't take the tag filter too: it leaves them out itself.
    expect((await listContacts(ctx, { q: "cal", launchesOnly: true }, db)).items).toEqual([]);
    expect((await listContacts(ctx, { q: "cal" }, db)).items).toHaveLength(1);
  });
});

describe("field and group filters", () => {
  const by = { type: "member", id: "u_admin" } as const;
  const AT = ISO(T0);
  const PLAN = "fld_000000000001";
  const TOPICS = "fld_000000000002";
  const DONE = "fld_000000000003";
  const NOTES = "fld_000000000004";

  async function withFields() {
    const db = await world();
    let f = 0;
    let o = 0;
    const fld = () => `fld_${String((f += 1)).padStart(12, "0")}`;
    const opt = () => `opt_${String((o += 1)).padStart(8, "0")}`;
    const adds: FieldListChange[] = [
      { op: "add", label: "Plan", type: "select", options: ["Free", "Pro"] },
      { op: "add", label: "Interests", type: "multi_select", options: ["Analytics", "Exports"] },
      { op: "add", label: "Onboarded", type: "checkbox" },
      { op: "add", label: "Notes", type: "text" },
    ];
    for (const [i, change] of adds.entries()) await saveFieldListChange(ctx, "person", { baseRev: i, change, by, nowIso: AT, newFieldId: fld, newOptionId: opt }, db);
    const set = (email: string, changes: Record<string, unknown>) =>
      setRecordFieldValues(ctx, { object: "person", recordId: personIdOf(TENANT_ID, email), changes, by, source: "editor", nowIso: AT }, { db });
    await set("ada@customer.test", { [PLAN]: "opt_00000002", [TOPICS]: ["opt_00000003", "opt_00000004"], [DONE]: true, [NOTES]: "likes exports" });
    await set("bea@customer.test", { [PLAN]: "opt_00000002", [TOPICS]: ["opt_00000004"] });
    await set("cal@customer.test", { [PLAN]: "opt_00000001", [DONE]: false });
    return db;
  }
  const emails = async (db: FakeFirestore, tag: string, canEmail = false) => (await listPeople(ctx, q({ tag, canEmail }), db)).people.map((p) => p.email).sort();

  it("shows everyone with a select, multi select or checkbox value, through the tags", async () => {
    const db = await withFields();
    expect(await emails(db, `field:${PLAN}:opt_00000002`)).toEqual(["ada@customer.test", "bea@customer.test"]);
    expect(await emails(db, `field:${TOPICS}:opt_00000004`)).toEqual(["ada@customer.test", "bea@customer.test"]);
    expect(await emails(db, `field:${TOPICS}:opt_00000003`)).toEqual(["ada@customer.test"]);
    expect(await emails(db, `field:${DONE}:yes`)).toEqual(["ada@customer.test"]);
    expect(await emails(db, `field:${PLAN}:opt_00000001`, true)).toEqual(["cal@customer.test"]);
  });

  it("keeps the tags through a sync, and rows carry only the filterable values asked for", async () => {
    const db = await withFields();
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 + 7_200_000 });
    const { people } = await listPeople(ctx, q({ tag: `field:${DONE}:yes` }), db, { fieldIds: new Set([PLAN, DONE]) });
    expect(people.map((p) => p.fields)).toEqual([{ [PLAN]: "opt_00000002", [DONE]: true }]);
    expect((await listPeople(ctx, q(), db)).people[0]!.fields).toBeUndefined();
  });

  it("lists the filterable fields without counts, and counts one field's options on demand", async () => {
    const db = await withFields();
    const f = await peopleFilters(ctx, db, { fields: true });
    expect(f.fields).toEqual([
      { id: PLAN, label: "Plan", type: "select", options: [{ id: "opt_00000001", label: "Free" }, { id: "opt_00000002", label: "Pro" }] },
      { id: TOPICS, label: "Interests", type: "multi_select", options: [{ id: "opt_00000003", label: "Analytics" }, { id: "opt_00000004", label: "Exports" }] },
      { id: DONE, label: "Onboarded", type: "checkbox", options: [{ id: "yes", label: "Yes" }] },
    ]);
    expect((await peopleFilters(ctx, db)).fields).toBeUndefined();
    expect(await fieldOptionCounts(ctx, PLAN, db)).toEqual({ opt_00000001: 1, opt_00000002: 2 });
    expect(await fieldOptionCounts(ctx, DONE, db)).toEqual({ yes: 1 });
    expect(await fieldOptionCounts(ctx, NOTES, db)).toBeNull();
  });

  it("hides an archived option's pill, keeps its tags, and a restore brings it back with nothing to run", async () => {
    const db = await withFields();
    await saveFieldListChange(ctx, "person", { baseRev: 4, change: { op: "archive_option", key: PLAN, optionId: "opt_00000001" }, by, nowIso: AT }, db);
    expect((await peopleFilters(ctx, db, { fields: true })).fields![0]!.options.map((o) => o.label)).toEqual(["Pro"]);
    expect(await emails(db, `field:${PLAN}:opt_00000001`)).toEqual(["cal@customer.test"]);
    await saveFieldListChange(ctx, "person", { baseRev: 5, change: { op: "restore_option", key: PLAN, optionId: "opt_00000001" }, by, nowIso: AT }, db);
    expect(await fieldOptionCounts(ctx, PLAN, db)).toEqual({ opt_00000001: 1, opt_00000002: 2 });
  });

  it("shows a product group, whose ids may hold . and :", async () => {
    const db = await world();
    seedUser(db, "ada", { email: "ada@customer.test", emailNormalized: "ada@customer.test", entities: { "org.acme:team-1": { kind: "workspace", name: "Acme Labs", parentId: null, role: "owner", steps: {}, facts: {}, activeAt: null, firstSeenAt: ISO(T0), updatedAt: ISO(T0) } } });
    await syncPerson(ctx, "ada@customer.test", { db, nowMs: T0 + 3_600_000 });
    expect(await emails(db, `group:${CONNECTION_ID}:org.acme:team-1`)).toEqual(["ada@customer.test"]);
    expect(await groupLabel(ctx, `group:${CONNECTION_ID}:org.acme:team-1`, db)).toBe("Acme Labs");
    expect(await groupLabel(ctx, `group:${CONNECTION_ID}:nobody`, db)).toBeNull();
    expect(await groupLabel({ ...ctx, tenantId: "ten_other" }, `group:${CONNECTION_ID}:org.acme:team-1`, db)).toBeNull();
  });

  it("accepts field and group tags as filters, and nothing like them", () => {
    for (const ok of [`field:${PLAN}:opt_00000001`, `field:${DONE}:yes`, "group:pcn_1:ws", "group:pcn_1:org.acme:team-1"]) expect(isFilterTag(ok), ok).toBe(true);
    for (const bad of ["field:plan:opt_00000001", `field:${PLAN}:maybe`, "group:pcn_1:", "group:pcn_1:-x", "group:pcn 1:ws", "group:pcn_1:a/b", "launch:camp1"]) {
      expect(isFilterTag(bad), bad).toBe(false);
    }
    expect(parseGroupTag("group:pcn_1:org.acme:team-1")).toEqual({ connectionId: "pcn_1", entityId: "org.acme:team-1" });
  });
});

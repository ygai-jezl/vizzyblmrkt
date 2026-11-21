import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { suppressEmail } from "@/lib/email/suppression";
import { deterministicCompanyId } from "@/lib/crm/identifiers";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import type { Contact } from "@/lib/types/contact";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import { saveFieldListChange } from "./fieldList";
import { addPerson, newPersonKey, recordHandConsent } from "./addPerson";
import { parseNewPerson, type NewPerson } from "./newPerson";
import { personIdOf, signupPersonKey, syncPerson } from "./personSync";

/** Made-up people at .test addresses, and a phone from Ofcom's drama range. */

const NOW = new Date(T0).toISOString();
const PLAN = "fld_000000000001";
const PRO = "opt_00000001";

function input(over: Record<string, unknown>): NewPerson {
  const r = parseNewPerson({ firstName: "Sam", lastName: "Rivera", ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function contact(db: FakeFirestore, key: string): Contact | undefined {
  const raw = db.raw("contacts", personIdOf(TENANT_ID, key));
  return raw ? ({ id: personIdOf(TENANT_ID, key), ...raw } as Contact) : undefined;
}

const events = (db: FakeFirestore) => db.dump("ontology_events") as unknown as StoredEvent[];

describe("addPerson", () => {
  it("adds someone by hand with their record.created event, and no consent until they agreed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await addPerson(ctx, input({ email: "Sam@Labs.test" }), { db, nowIso: NOW });
    expect(r).toEqual({ outcome: "created", personId: personIdOf(TENANT_ID, "sam@labs.test"), fields: "none" });
    expect(contact(db, "sam@labs.test")).toMatchObject({
      contactKey: "sam@labs.test",
      email: "sam@labs.test",
      firstName: "Sam",
      lastName: "Rivera",
      status: "active",
      consentStatus: "none",
      addedBy: { kind: "member", id: "usr_1", at: NOW, via: "form" },
      memberOf: ["added:hand", "all"],
      reach: "no",
      campaignIds: [],
      needsSync: false,
      activeAt: NOW,
      companyId: deterministicCompanyId(TENANT_ID, "labs.test"),
      enrichment: { status: "none" },
    });
    expect(contact(db, "sam@labs.test")!.consent).toBeUndefined();
    expect(contact(db, "sam@labs.test")!.searchTokens).toEqual(expect.arrayContaining(["sam", "rivera", "sam@labs.test"]));
    expect(events(db).map((e) => [e.kind, e.personId, e.properties])).toEqual([
      ["record.created", personIdOf(TENANT_ID, "sam@labs.test"), { object: "person", via: "form" }],
    ]);
  });

  it("records how they agreed with a consent.recorded event, so they can be emailed", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addPerson(ctx, input({ email: "kim@labs.test", agreed: { how: "signed_form" }, via: "palette" }), { db, nowIso: NOW });
    expect(contact(db, "kim@labs.test")).toMatchObject({
      reach: "yes",
      addedBy: { via: "palette" },
      consent: { marketing_email: { state: "granted", how: "signed_form", note: null, recordedBy: "usr_1", at: NOW, agreedAt: null } },
    });
    const consent = events(db).find((e) => e.kind === "consent.recorded")!;
    expect(consent).toMatchObject({ personId: personIdOf(TENANT_ID, "kim@labs.test"), actor: { type: "member", id: "usr_1" }, properties: { purpose: "marketing_email", how: "signed_form", recordedBy: "usr_1" } });
    expect(JSON.stringify(events(db))).not.toContain("kim@labs.test");
  });

  it("keeps an address that unsubscribed unreachable from the start", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await suppressEmail(system, { email: "kim@labs.test", reason: "unsubscribe", source: "footer" }, db);
    await addPerson(ctx, input({ email: "kim@labs.test", agreed: { how: "in_person" } }), { db, nowIso: NOW });
    expect(contact(db, "kim@labs.test")).toMatchObject({ reach: "no", optOuts: { blocked: "unsubscribe" } });
  });

  it("opens the person who already holds the address, writing nothing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addPerson(ctx, input({ email: "sam@labs.test" }), { db, nowIso: NOW });
    const before = { ...contact(db, "sam@labs.test") };
    const again = await addPerson(ctx, input({ email: " SAM@labs.test ", firstName: "Samuel", agreed: { how: "in_person" } }), { db, nowIso: new Date(T0 + 60_000).toISOString() });
    expect(again).toEqual({ outcome: "existing", personId: personIdOf(TENANT_ID, "sam@labs.test") });
    expect(contact(db, "sam@labs.test")).toEqual(before);
    expect(events(db)).toHaveLength(1);
  });

  it("keys someone with only a phone by the trimmed phone, as their sign-ups are", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const r = await addPerson(ctx, input({ phone: " +44 7700 900456 " }), { db, nowIso: NOW });
    expect(newPersonKey({ email: null, phone: " +44 7700 900456 " })).toBe(signupPersonKey({ email: null, phone: "+44 7700 900456 " }));
    expect(r.outcome === "created" && r.personId).toBe(personIdOf(TENANT_ID, "+44 7700 900456"));
    expect(contact(db, "+44 7700 900456")).toMatchObject({ email: null, phone: "+44 7700 900456", companyId: null, emailDomain: null });
  });

  it("keeps someone with only a phone off Only people we can email, though their agreement is recorded", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addPerson(ctx, input({ phone: "+44 7700 900457", agreed: { how: "in_person" } }), { db, nowIso: NOW });
    expect(contact(db, "+44 7700 900457")).toMatchObject({ reach: "no", consent: { marketing_email: { state: "granted", how: "in_person" } } });
    expect(events(db).filter((e) => e.kind === "consent.recorded")).toHaveLength(1);
    // A sync keeps it that way.
    await syncPerson(ctx, "+44 7700 900457", { db, nowMs: T0 + 60_000 });
    expect(contact(db, "+44 7700 900457")?.reach).toBe("no");
  });

  it("matches no company for a public email provider", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addPerson(ctx, input({ email: "sam.rivera@gmail.com" }), { db, nowIso: NOW });
    expect(contact(db, "sam.rivera@gmail.com")).toMatchObject({ companyId: null, isCorporateDomain: false, enrichment: { status: "skipped" } });
  });

  it("joins a product user no sync has reached yet, and the next sync writes nothing", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    seedUser(db, "lee", { firstName: "Lee", email: "lee@customer.test", emailNormalized: "lee@customer.test" });
    await addPerson(ctx, input({ email: "lee@customer.test", firstName: "Leanne" }), { db, nowIso: new Date(T0 + 3_600_000).toISOString() });
    const p = contact(db, "lee@customer.test")!;
    expect(p.products?.map((x) => x.connectionId)).toEqual([CONNECTION_ID]);
    expect(p).toMatchObject({ firstName: "Leanne" });
    expect(p.memberOf).toEqual(expect.arrayContaining(["added:hand", "all", `product:${CONNECTION_ID}`]));
    expect((await syncPerson(ctx, "lee@customer.test", { db, nowMs: T0 + 3_600_000 })).outcome).toBe("unchanged");
  });

  it("sets field values through the one writer once they are added, and checks them before adding anyone", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Plan", type: "select", options: ["Pro"] }, by: { type: "member", id: "usr_1" }, newFieldId: () => PLAN, newOptionId: () => PRO }, db);
    const r = await addPerson(ctx, input({ email: "sam@labs.test", fields: { [PLAN]: PRO } }), { db, nowIso: NOW, fields: true });
    expect(r).toMatchObject({ outcome: "created", fields: "saved" });
    expect(contact(db, "sam@labs.test")).toMatchObject({ fields: { [PLAN]: PRO } });
    expect(contact(db, "sam@labs.test")!.memberOf).toEqual(expect.arrayContaining(["added:hand", `field:${PLAN}:${PRO}`]));
    expect(events(db).map((e) => e.kind).sort()).toEqual(["record.created", "record.field_changed"]);

    expect(await addPerson(ctx, input({ email: "kim@labs.test", fields: { [PLAN]: "opt_99999999" } }), { db, nowIso: NOW, fields: true })).toEqual({
      outcome: "rejected",
      error: "invalid_value",
      fieldId: PLAN,
    });
    expect(await addPerson(ctx, input({ email: "kim@labs.test", fields: { fld_999999999999: 1 } }), { db, nowIso: NOW, fields: true })).toMatchObject({ error: "unknown_field" });
    expect(contact(db, "kim@labs.test")).toBeUndefined();
    // Fields off: the values are left out and the person is added.
    expect(await addPerson(ctx, input({ email: "kim@labs.test", fields: { [PLAN]: PRO } }), { db, nowIso: NOW })).toMatchObject({ outcome: "created", fields: "none" });
    expect(contact(db, "kim@labs.test")!.fields).toBeUndefined();
  });

  it("needs a team member to say who added them", async () => {
    const db = new FakeFirestore();
    expect(await addPerson({ ...ctx, userId: undefined }, input({ email: "sam@labs.test" }), { db, nowIso: NOW })).toEqual({ outcome: "rejected", error: "no_user" });
    expect(db.dump("contacts")).toHaveLength(0);
  });
});

describe("recordHandConsent", () => {
  it("records a later agreement for someone added by hand, once", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const added = await addPerson(ctx, input({ email: "sam@labs.test" }), { db, nowIso: NOW });
    const id = added.outcome === "created" ? added.personId : "";
    const later = new Date(T0 + 60_000).toISOString();
    const r = await recordHandConsent(ctx, id, { how: "other", note: "At our stand" }, { db, nowIso: later });
    expect(r).toMatchObject({ outcome: "recorded", consent: { how: "other", note: "At our stand", at: later } });
    expect(contact(db, "sam@labs.test")).toMatchObject({ reach: "yes", changedAt: later, memberOf: ["added:hand", "all"] });
    expect(events(db).filter((e) => e.kind === "consent.recorded")).toHaveLength(1);
    expect(await recordHandConsent(ctx, id, { how: "in_person", note: null }, { db, nowIso: later })).toMatchObject({ outcome: "unchanged", consent: { how: "other" } });
    expect(events(db).filter((e) => e.kind === "consent.recorded")).toHaveLength(1);
  });

  it("leaves everyone else's consent to their launch or product", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    const id = personIdOf(TENANT_ID, "ada@customer.test");
    db.seed("contacts", id, { tenantId: TENANT_ID, contactKey: "ada@customer.test", campaigns: [], memberOf: ["all"] });
    expect(await recordHandConsent(ctx, id, { how: "in_person", note: null }, { db, nowIso: NOW })).toEqual({ outcome: "rejected", error: "consent_elsewhere" });
    expect(await recordHandConsent(ctx, personIdOf(TENANT_ID, "nobody@customer.test"), { how: "in_person", note: null }, { db, nowIso: NOW })).toEqual({
      outcome: "rejected",
      error: "not_found",
    });
    expect(events(db)).toHaveLength(0);
  });
});

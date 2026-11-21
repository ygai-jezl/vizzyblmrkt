import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { processContactEraseJob } from "./eraseWorker";
import { eraseProductUser } from "@/lib/connect/erase";
import { appendEvents, proposeAgentAction } from "@/lib/tenant";
import { deterministicContactId } from "./identifiers";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import { productUserPersonId } from "@/lib/ontology/erase";
import type { ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey } from "@/lib/types/agentAction";

// The external audience is out of scope here (and reads the tenant registry directly).
vi.mock("@/lib/mailchimp", () => ({ removeSignupFromAudience: vi.fn(async () => ({ ok: true })) }));

/**
 * The GDPR erase cascade reaches everything keyed by the person's signups:
 * engagement events, invites, and their progress through waitlist journeys on
 * the lifecycle engine (engine move), then the signups themselves, on every
 * launch. Addresses are example.test; phone numbers are from Ofcom's drama range.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const job = { id: "erase_1", payload: { contactId: "ct_1" } } as unknown as EmailJob;

describe("processContactEraseJob", () => {
  it("erases the person's events, invites and waitlist journey progress, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [{ campaignId: "camp1", signupId: "s1" }] });
    db.seed("signups", "s1", { tenantId: "ten_A", campaignId: "camp1", email: "ada@example.test", firstName: "Ada" });
    db.seed("signups", "s2", { tenantId: "ten_A", campaignId: "camp1", email: "bob@example.test", firstName: "Bob" });
    db.seed("email_events", "ev1", { tenantId: "ten_A", signupId: "s1", journeyId: "j" });
    db.seed("invites", "inv1", { tenantId: "ten_A", signupId: "s1" });
    db.seed("waitlist_enrolments", "enr_1", { tenantId: "ten_A", signupId: "s1", campaignId: "camp1" });
    db.seed("waitlist_enrolments", "enr_2", { tenantId: "ten_A", signupId: "s2", campaignId: "camp1" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("contacts", "ct_1")).toBeUndefined();
    expect(db.raw("email_events", "ev1")).toBeUndefined();
    expect(db.raw("invites", "inv1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_1")).toBeUndefined();
    expect(db.raw("waitlist_enrolments", "enr_2")).toBeDefined();
    expect(db.raw("signups", "s1")).toBeUndefined();
    expect(db.raw("signups", "s2")).toBeDefined();
  });

  it("erases their sign-ups on every launch, including ones the contact doesn't link yet", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "Ada@Example.test", companyId: null, campaigns: [{ campaignId: "camp1", signupId: "s1" }] });
    db.seed("signups", "s1", { tenantId: "ten_A", campaignId: "camp1", email: "ada@example.test" });
    // An unconfirmed sign-up from the brand's own site: it joins the contact only on confirm.
    db.seed("signups", "s3", { tenantId: "ten_A", campaignId: "camp2", email: "ada@example.test", status: "unverified", joinedVia: "site" });
    db.seed("email_events", "ev3", { tenantId: "ten_A", signupId: "s3", type: "send" });
    // The same address on another brand belongs to that brand.
    db.seed("signups", "other", { tenantId: "ten_B", campaignId: "campB", email: "ada@example.test" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "s1")).toBeUndefined();
    expect(db.raw("signups", "s3")).toBeUndefined();
    expect(db.raw("email_events", "ev3")).toBeUndefined();
    expect(db.raw("signups", "other")).toBeDefined();
  });

  it("keeps their opt-outs holding, with the address blanked", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [] });
    db.seed("email_suppressions", "sup_ada", { tenantId: "ten_A", email: "ada@example.test", normalizedEmail: "ada@example.test", reason: "unsubscribe", scope: "all" });
    db.seed("email_suppressions", "sup_bob", { tenantId: "ten_A", email: "bob@example.test", normalizedEmail: "bob@example.test", reason: "unsubscribe", scope: "all" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("email_suppressions", "sup_ada")).toMatchObject({ email: "", normalizedEmail: "", reason: "unsubscribe" });
    expect(db.raw("email_suppressions", "sup_bob")).toMatchObject({ normalizedEmail: "bob@example.test" });
  });

  it("finds a phone-only person's sign-ups by their phone", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: null, phone: "+447700900123", companyId: null, campaigns: [] });
    db.seed("signups", "p1", { tenantId: "ten_A", campaignId: "camp1", email: null, phone: "+447700900123" });
    db.seed("signups", "p2", { tenantId: "ten_A", campaignId: "camp1", email: null, phone: "+447700900456" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "p1")).toBeUndefined();
    expect(db.raw("signups", "p2")).toBeDefined();
  });

  it("finishes a retry after a partial run, when some sign-ups are already gone", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", {
      tenantId: "ten_A",
      email: "ada@example.test",
      companyId: null,
      campaigns: [{ campaignId: "camp1", signupId: "gone" }, { campaignId: "camp2", signupId: "s2" }],
    });
    db.seed("signups", "s2", { tenantId: "ten_A", campaignId: "camp2", email: "ada@example.test" });
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("signups", "s2")).toBeUndefined();
    expect(db.raw("contacts", "ct_1")).toBeUndefined();
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
  });

  describe("with the one view on (Erase everywhere)", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("erases their user in every product too, linked or found by address, and nobody else's", async () => {
      vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
      vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
      const db = new FakeFirestore();
      db.seed("contacts", "ct_1", {
        tenantId: "ten_A",
        email: "ada@example.test",
        consentStatus: "verified_active",
        companyId: null,
        campaigns: [],
        products: [{ connectionId: "pcn_1", productUserId: "pu_linked" }],
      });
      const user = (connectionId: string, email: string) => ({ tenantId: "ten_A", connectionId, email, emailNormalized: email, status: "active", firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-01T00:00:00.000Z" });
      db.seed("product_users", "pu_linked", user("pcn_1", "ada@example.test"));
      db.seed("product_users", "pu_found", user("pcn_2", "ada@example.test"));
      db.seed("product_users", "pu_bob", user("pcn_1", "bob@example.test"));
      expect(await processContactEraseJob(ctx, job, db)).toBe("done");
      expect(db.raw("product_users", "pu_linked")).toMatchObject({ status: "deleted" });
      expect(db.raw("product_users", "pu_found")).toMatchObject({ status: "deleted" });
      expect(db.raw("product_users", "pu_bob")).toMatchObject({ status: "active", email: "bob@example.test" });
      expect(db.raw("contacts", "ct_1")).toBeUndefined();
    });

    it("leaves product users alone while it's off", async () => {
      const db = new FakeFirestore();
      db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [], products: [{ connectionId: "pcn_1", productUserId: "pu_linked" }] });
      db.seed("product_users", "pu_linked", { tenantId: "ten_A", connectionId: "pcn_1", email: "ada@example.test", emailNormalized: "ada@example.test", status: "active" });
      expect(await processContactEraseJob(ctx, job, db)).toBe("done");
      expect(db.raw("product_users", "pu_linked")).toMatchObject({ status: "active" });
    });
  });
});

describe("person moves on an erase", () => {
  const move = (over: Record<string, unknown>) => ({
    tenantId: "ten_A",
    kind: "record.repointed",
    productUserId: "pu_x",
    connectionId: "pcn_1",
    repoint: "done",
    at: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...over,
  });

  it("go with the person: moves to them and moves from them, and nobody else's", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", "ct_1", { tenantId: "ten_A", email: "ada@example.test", companyId: null, campaigns: [] });
    db.seed("person_moves", "mv_to", move({ personId: "ct_1", fromPersonId: "ct_9" }));
    db.seed("person_moves", "mv_from", move({ personId: "ct_9", fromPersonId: "ct_1" }));
    db.seed("person_moves", "mv_other", move({ personId: "ct_8", fromPersonId: "ct_9" }));
    db.seed("person_moves", "mv_theirs", move({ tenantId: "ten_B", personId: "ct_1", fromPersonId: "ct_9" }));
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("person_moves", "mv_to")).toBeUndefined();
    expect(db.raw("person_moves", "mv_from")).toBeUndefined();
    expect(db.raw("person_moves", "mv_other")).toBeDefined();
    expect(db.raw("person_moves", "mv_theirs")).toBeDefined();
  });

  it("go with the person on a retry, when the contact is already gone", async () => {
    const db = new FakeFirestore();
    db.seed("person_moves", "mv_to", move({ personId: "ct_1", fromPersonId: "ct_9" }));
    db.seed("person_moves", "mv_from", move({ personId: "ct_9", fromPersonId: "ct_1" }));
    db.seed("person_moves", "mv_other", move({ personId: "ct_8", fromPersonId: "ct_9" }));
    expect(await processContactEraseJob(ctx, job, db)).toBe("done");
    expect(db.raw("person_moves", "mv_to")).toBeUndefined();
    expect(db.raw("person_moves", "mv_from")).toBeUndefined();
    expect(db.raw("person_moves", "mv_other")).toBeDefined();
  });

  it("go with the product user", async () => {
    const db = new FakeFirestore();
    db.seed("product_users", "pu_x", { tenantId: "ten_A", connectionId: "pcn_1", email: "ada@example.test", emailNormalized: "ada@example.test", status: "active" });
    db.seed("person_moves", "mv_1", move({ personId: "ct_1", fromPersonId: "ct_9" }));
    db.seed("person_moves", "mv_2", move({ productUserId: "pu_y", personId: "ct_1", fromPersonId: "ct_9" }));
    expect(await eraseProductUser(ctx, "pcn_1", "pu_x", db)).toBe(true);
    expect(db.raw("person_moves", "mv_1")).toBeUndefined();
    expect(db.raw("person_moves", "mv_2")).toBeDefined();
  });
});

describe("event history and agent actions on an erase, with every switch off", () => {
  const demo: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
  const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
  const ADA = deterministicContactId("ten_demo", "ada@example.test") as ContactPersonId;
  const BOB = deterministicContactId("ten_demo", "bob@example.test") as ContactPersonId;
  const AT = "2026-11-01T10:00:00.000Z";
  const MEMBER = { type: "member" as const, id: "uid_1" };
  const eraseAda = { id: "erase_ada", payload: { contactId: ADA } } as unknown as EmailJob;

  beforeEach(() => {
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "false");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A field change and an open suggestion about a person (three rows: the change, the action, its proposed row). */
  async function rowsAbout(db: FakeFirestore, c: TenantContext, personId: ContactPersonId, key: string) {
    await appendEvents(c, [fieldChangedEvent({ subject: { type: "person", id: personId }, personId, fieldId: "plan", object: "person", before: null, after: "pro", source: "editor", actor: MEMBER, at: AT, nonce: () => key })], { db });
    await proposeAgentAction(
      c,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", key),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: personId },
        personId,
        proposal: null,
        basis: null,
        signals: [],
        review: null,
        requestedBy: MEMBER,
        expiresAt: "2026-12-01T10:00:00.000Z",
        at: AT,
      },
      { db },
    );
  }
  const held = (db: FakeFirestore, tenantId: string, personId: string) =>
    [...db.dump("ontology_events"), ...db.dump("agent_actions")].filter((r) => r.tenantId === tenantId && r.personId === personId).length;
  const companyRows = (db: FakeFirestore, companyId: string) => db.dump("ontology_events").filter((r) => r.subjectKey === `company:${companyId}`).length;
  async function companyChange(db: FakeFirestore, companyId: string) {
    await appendEvents(demo, [fieldChangedEvent({ subject: { type: "company", id: companyId }, personId: null, fieldId: "size", object: "company", before: 1, after: 2, source: "editor", actor: MEMBER, at: AT, nonce: () => companyId })], { db });
  }

  it("deletes the person's rows, and keeps another person's and another brand's", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.test", companyId: null, campaigns: [] });
    await rowsAbout(db, demo, ADA, "ada");
    await rowsAbout(db, demo, BOB, "bob");
    await rowsAbout(db, other, ADA, "theirs");
    expect(await processContactEraseJob(demo, eraseAda, db)).toBe("done");
    expect(held(db, "ten_demo", ADA)).toBe(0);
    expect(held(db, "ten_demo", BOB)).toBe(3);
    expect(held(db, "ten_other", ADA)).toBe(3);
  });

  it("deletes rows under the pu: person of a product user they link, and keeps the product user", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.test", companyId: null, campaigns: [], products: [{ connectionId: "pcn_1", productUserId: "pu_ada" }] });
    db.seed("product_users", "pu_ada", { tenantId: "ten_demo", connectionId: "pcn_1", email: "ada@example.test", emailNormalized: "ada@example.test", status: "active" });
    const puPerson = productUserPersonId("ten_demo", "pu_ada");
    await rowsAbout(db, demo, puPerson, "before_merge");
    expect(await processContactEraseJob(demo, eraseAda, db)).toBe("done");
    expect(held(db, "ten_demo", puPerson)).toBe(0);
    expect(db.raw("product_users", "pu_ada")).toMatchObject({ status: "active" });
  });

  it("still deletes leftover rows when the contact is already gone", async () => {
    const db = new FakeFirestore();
    await rowsAbout(db, demo, ADA, "left");
    expect(await processContactEraseJob(demo, eraseAda, db)).toBe("done");
    expect(held(db, "ten_demo", ADA)).toBe(0);
  });

  it("deletes the company's rows when it goes, and keeps them while it has people", async () => {
    const db = new FakeFirestore();
    db.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.test", companyId: "co_solo", campaigns: [] });
    db.seed("companies", "co_solo", { tenantId: "ten_demo", domain: "solo.test", contactCount: 1 });
    await companyChange(db, "co_solo");
    expect(await processContactEraseJob(demo, eraseAda, db)).toBe("done");
    expect(db.raw("companies", "co_solo")).toBeUndefined();
    expect(companyRows(db, "co_solo")).toBe(0);

    const shared = new FakeFirestore();
    shared.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.test", companyId: "co_team", campaigns: [] });
    shared.seed("contacts", BOB, { tenantId: "ten_demo", email: "bob@example.test", companyId: "co_team", campaigns: [] });
    shared.seed("companies", "co_team", { tenantId: "ten_demo", domain: "team.test", contactCount: 2 });
    await companyChange(shared, "co_team");
    expect(await processContactEraseJob(demo, eraseAda, shared)).toBe("done");
    expect(shared.raw("companies", "co_team")).toBeDefined();
    expect(companyRows(shared, "co_team")).toBe(1);
  });
});

describe("field values on an erase, with every switch off", () => {
  const demo: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
  const ADA = deterministicContactId("ten_demo", "ada@example.test");
  const BOB = deterministicContactId("ten_demo", "bob@example.test");
  const AT = "2026-11-01T10:00:00.000Z";
  const by = { type: "member" as const, id: "uid_1" };

  afterEach(() => vi.unstubAllEnvs());

  it("go with the person and their company, with every field change", async () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    const { saveFieldListChange } = await import("@/lib/audience/fieldList");
    const { setRecordFieldValues } = await import("@/lib/tenant");
    const db = new FakeFirestore();
    db.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.test", companyId: "co_solo", campaigns: [] });
    db.seed("contacts", BOB, { tenantId: "ten_demo", email: "bob@example.test", companyId: null, campaigns: [] });
    db.seed("companies", "co_solo", { tenantId: "ten_demo", domain: "solo.test", contactCount: 1 });
    await saveFieldListChange(demo, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, nowIso: AT, newFieldId: () => "fld_000000000001" }, db);
    await saveFieldListChange(demo, "company", { baseRev: 0, change: { op: "add", label: "Region", type: "text" }, by, nowIso: AT, newFieldId: () => "fld_000000000002" }, db);
    for (const id of [ADA, BOB]) await setRecordFieldValues(demo, { object: "person", recordId: id, changes: { fld_000000000001: 3 }, by, source: "editor", nowIso: AT }, { db });
    await setRecordFieldValues(demo, { object: "company", recordId: "co_solo", changes: { fld_000000000002: "Europe" }, by, source: "editor", nowIso: AT }, { db });

    const eraseAda = { id: "erase_ada", payload: { contactId: ADA } } as unknown as EmailJob;
    expect(await processContactEraseJob(demo, eraseAda, db)).toBe("done");
    expect(db.raw("contacts", ADA)).toBeUndefined();
    expect(db.raw("companies", "co_solo")).toBeUndefined();
    const left = db.dump("ontology_events").filter((r) => r.kind === "record.field_changed");
    expect(left.map((r) => r.personId)).toEqual([BOB]);
    expect((db.raw("contacts", BOB) as { fields?: unknown }).fields).toEqual({ fld_000000000001: 3 });
  });
});

describe("someone added by hand on an erase, with every switch off", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("goes in full: the record, who added them, their consent and both events", async () => {
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "false");
    const { addPerson } = await import("@/lib/audience/addPerson");
    const { parseNewPerson } = await import("@/lib/audience/newPerson");
    const admin: TenantContext = { tenantId: "ten_demo", region: "us", source: "idtoken", role: "admin", userId: "uid_1" };
    const demo: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
    const db = new FakeFirestore();
    for (const email of ["sam@labs.test", "kim@labs.test"]) {
      const p = parseNewPerson({ email, agreed: { how: "in_person" } });
      if (!p.ok) throw new Error(p.error);
      await addPerson(admin, p.value, { db, nowIso: "2026-11-01T10:00:00.000Z" });
    }
    const SAM = deterministicContactId("ten_demo", "sam@labs.test");
    const KIM = deterministicContactId("ten_demo", "kim@labs.test");
    expect(db.dump("ontology_events")).toHaveLength(4);

    expect(await processContactEraseJob(demo, { id: "erase_sam", payload: { contactId: SAM } } as unknown as EmailJob, db)).toBe("done");
    expect(db.raw("contacts", SAM)).toBeUndefined();
    expect(db.dump("ontology_events").map((r) => r.personId)).toEqual([KIM, KIM]);
    expect(JSON.stringify(db.dump("ontology_events"))).not.toContain("sam@labs.test");
    expect(db.raw("contacts", KIM)).toMatchObject({ addedBy: { id: "uid_1" } });
  });
});

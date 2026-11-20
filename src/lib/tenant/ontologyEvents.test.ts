import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { readsFirst } from "./testing/readsFirst";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";
import {
  appendEvents,
  blankFieldEvents,
  countFieldEvents,
  prepareEventsTx,
  repointHistoryPage,
  stageEvent,
  writeRecordWithEvents,
  type PreparedEvent,
} from "./ontologyEvents";
import { deterministicAgentActionId, deterministicContactId, deterministicEventId } from "@/lib/crm/identifiers";
import { consentRecordedEvent, fieldChangedEvent, recordCreatedEvent } from "@/lib/ontology/eventBuilders";
import type { ContactPersonId } from "@/lib/ontology/person";
import type { EventWrite } from "@/lib/types/ontologyEvent";
import type { Contact } from "@/lib/types/contact";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const ADA = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const BO = deterministicContactId("ten_demo", "bo@example.com") as ContactPersonId;
const AT = "2026-11-20T10:00:00.000Z";
const NOW = "2026-11-20T10:00:05.000Z";
const MEMBER = { type: "member" as const, id: "uid_1" };

let seq = 0;
function change(person: ContactPersonId, fieldId = "plan", over: Partial<Parameters<typeof fieldChangedEvent>[0]> = {}): EventWrite {
  seq += 1;
  return fieldChangedEvent({
    subject: { type: "person", id: person },
    personId: person,
    fieldId,
    object: "person",
    before: "free",
    after: "pro",
    source: "editor",
    actor: MEMBER,
    at: AT,
    nonce: () => `n${seq}`,
    ...over,
  });
}

function world() {
  const fake = new FakeFirestore();
  return { fake, db: readsFirst(fake) };
}

const rows = (fake: FakeFirestore) => fake.dump("ontology_events");

describe("stageEvent", () => {
  it("refuses agent.* kinds, and takes only prepared events", async () => {
    const { fake, db } = world();
    const aa = deterministicAgentActionId("ten_demo", "person_fields.suggest|x");
    const agentWrite: EventWrite = {
      key: `agent|${aa}|1`,
      kind: "agent.proposed",
      at: AT,
      subject: { type: "agent_action", id: aa },
      personId: ADA,
      agentActionId: aa,
      source: { system: "agent" },
      actor: { type: "agent", id: "vizzy" },
      properties: { agentActionId: aa, agent: "vizzy", action: "person_fields.suggest", state: "proposed" },
    };
    await expect(
      db.runTransaction(async (txn) => {
        const { fresh } = await prepareEventsTx(txn, db, ctx, [agentWrite]);
        return stageEvent(txn, db, ctx, fresh[0]!);
      }),
    ).rejects.toThrow(TenantValidationError);
    expect(rows(fake)).toEqual([]);
    await db.runTransaction(async (txn) => {
      // @ts-expect-error an EventWrite that was never prepared is not a PreparedEvent
      expect(() => stageEvent(txn, db, ctx, change(ADA))).toThrow();
      return null;
    });
  });

  it("refuses an event prepared for another brand", async () => {
    const { db } = world();
    await expect(
      db.runTransaction(async (txn) => {
        const { fresh } = await prepareEventsTx(txn, db, ctx, [change(ADA)]);
        return stageEvent(txn, db, other, fresh[0] as PreparedEvent);
      }),
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe("appendEvents", () => {
  it("writes ev_ ids with the tenant, subject key and nulls, and a second call writes nothing", async () => {
    const { fake, db } = world();
    const writes = [change(ADA), change(BO)];
    const first = await appendEvents(ctx, writes, { db, nowIso: NOW });
    expect(first.duplicates).toEqual([]);
    expect(first.written.map((e) => e.id)).toEqual(writes.map((w) => deterministicEventId("ten_demo", w.key)));
    for (const e of first.written) expect(e.id).toMatch(/^ev_[0-9a-f]{40}$/);
    const stored = fake.raw("ontology_events", first.written[0]!.id)!;
    expect(stored).toMatchObject({
      tenantId: "ten_demo",
      subjectKey: `person:${ADA}`,
      personId: ADA,
      productUserId: null,
      agentActionId: null,
      identity: null,
      refs: null,
      createdAt: NOW,
      blankedAt: null,
      blankedReason: null,
    });
    const counts = () => first.written.map((e) => fake.writeCountFor("ontology_events", e.id));
    const before = counts();
    const again = await appendEvents(ctx, writes, { db, nowIso: NOW });
    expect(again.written).toEqual([]);
    expect(again.duplicates).toEqual(writes.map((w) => w.key));
    expect(counts()).toEqual(before);
  });

  it("throws for a key stored by another brand, and leaves that row alone", async () => {
    const { fake, db } = world();
    const w = change(ADA);
    const id = deterministicEventId("ten_demo", w.key);
    fake.seed("ontology_events", id, { tenantId: "ten_other", kind: "record.created", note: "theirs" });
    await expect(appendEvents(ctx, [w], { db })).rejects.toThrow(TenantIsolationError);
    expect(fake.raw("ontology_events", id)).toEqual({ tenantId: "ten_other", kind: "record.created", note: "theirs" });
  });

  it("refuses more than 200, an agent kind, or one key twice", async () => {
    const { db } = world();
    await expect(appendEvents(ctx, Array.from({ length: 201 }, () => change(ADA)), { db })).rejects.toThrow(TenantValidationError);
    const w = change(ADA);
    await expect(appendEvents(ctx, [w, w], { db })).rejects.toThrow(TenantValidationError);
    await expect(appendEvents(ctx, [{ ...w, kind: "agent.acted" }], { db })).rejects.toThrow(TenantValidationError);
    await expect(appendEvents(ctx, [{ ...w, key: "field|ada@example.com" }], { db })).rejects.toThrow(/bad_event/);
  });

  it("leaves each key exactly once when another writer creates one of them meanwhile", async () => {
    const { fake, db } = world();
    const writes = [change(ADA), change(BO)];
    fake.onBeforeCommit = async () => {
      await appendEvents(ctx, [writes[0]!], { db: fake, nowIso: NOW });
    };
    const out = await appendEvents(ctx, writes, { db, nowIso: NOW });
    expect(out.duplicates).toEqual([writes[0]!.key]);
    expect(out.written.map((e) => e.key)).toEqual([writes[1]!.key]);
    for (const w of writes) expect(fake.writeCountFor("ontology_events", deterministicEventId("ten_demo", w.key))).toBe(1);
    expect(rows(fake)).toHaveLength(2);
  });
});

describe("writeRecordWithEvents", () => {
  const contact = (over: Partial<Contact> = {}) =>
    ({ email: "ada@example.com", campaigns: [], consentStatus: "none", status: "active", createdAt: AT, updatedAt: AT, ...over }) as unknown as Omit<Contact, "id" | "tenantId">;

  it("creates a contact and its record.created event in one commit", async () => {
    const { fake, db } = world();
    const created = recordCreatedEvent({ subject: { type: "person", id: ADA }, personId: ADA, via: "form", actor: MEMBER, at: AT });
    const out = await writeRecordWithEvents(ctx, "contacts", ADA, (cur) => (cur ? null : { create: contact(), events: [created] }), { db, nowIso: NOW });
    expect(out.outcome).toBe("created");
    expect(fake.raw("contacts", ADA)).toMatchObject({ tenantId: "ten_demo", email: "ada@example.com" });
    expect(fake.raw("ontology_events", deterministicEventId("ten_demo", created.key))).toMatchObject({ kind: "record.created", personId: ADA });
  });

  it("patches consent with its consent.recorded event, and keeps tenant, id and createdAt", async () => {
    const { fake, db } = world();
    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com", consentStatus: "none", createdAt: AT });
    const consent = consentRecordedEvent({ personId: ADA, purpose: "marketing_email", how: "verbal", note: null, recordedBy: "uid_1", agreedAt: null, at: AT, actor: MEMBER });
    const out = await writeRecordWithEvents(
      ctx,
      "contacts",
      ADA,
      () => ({ patch: { consentStatus: "verified_active", tenantId: "ten_other", createdAt: "x" } as never, events: [consent] }),
      { db, nowIso: NOW },
    );
    expect(out.outcome).toBe("updated");
    expect(fake.raw("contacts", ADA)).toMatchObject({ tenantId: "ten_demo", consentStatus: "verified_active", createdAt: AT });
    expect(rows(fake).map((r) => r.kind)).toEqual(["consent.recorded"]);
  });

  it("writes nothing for a null plan or a rejection, and says why", async () => {
    const { fake, db } = world();
    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com" });
    const before = fake.writeCountFor("contacts", ADA);
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => null, { db })).toMatchObject({ outcome: "unchanged" });
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => ({ reject: "no_change" }), { db })).toEqual({ outcome: "rejected", reason: "no_change" });
    expect(fake.writeCountFor("contacts", ADA)).toBe(before);
    expect(rows(fake)).toEqual([]);
  });

  it("rejects a patch on nothing, a create on something, and a create on companies or launches", async () => {
    const { fake, db } = world();
    expect(await writeRecordWithEvents(ctx, "contacts", BO, () => ({ patch: { consentStatus: "verified_active" as const }, events: [change(BO)] }), { db })).toEqual({ outcome: "rejected", reason: "not_found" });
    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com" });
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => ({ create: contact(), events: [] }), { db })).toEqual({ outcome: "rejected", reason: "exists" });
    const createCompany = (() => ({ create: { domain: "example.com" }, events: [] })) as never;
    expect(await writeRecordWithEvents(ctx, "companies", "co_1", createCompany, { db })).toEqual({ outcome: "rejected", reason: "create_not_allowed" });
    expect(await writeRecordWithEvents(ctx, "campaigns", "spring-launch", createCompany, { db })).toEqual({ outcome: "rejected", reason: "create_not_allowed" });
    expect(rows(fake)).toEqual([]);
    expect(fake.raw("contacts", BO)).toBeUndefined();
  });

  it("throws for another brand's record and leaves it alone", async () => {
    const { fake, db } = world();
    fake.seed("contacts", ADA, { tenantId: "ten_other", email: "ada@example.com" });
    await expect(writeRecordWithEvents(ctx, "contacts", ADA, () => ({ patch: { consentStatus: "verified_active" as const }, events: [] }), { db })).rejects.toThrow(TenantIsolationError);
    expect(fake.raw("contacts", ADA)).toEqual({ tenantId: "ten_other", email: "ada@example.com" });
  });

  it("skips an event key already stored instead of failing", async () => {
    const { fake, db } = world();
    fake.seed("companies", "co_1", { tenantId: "ten_demo", domain: "example.com", contactCount: 1 });
    const e = change(ADA, "size", { subject: { type: "company", id: "co_1" }, personId: null, object: "company" });
    await appendEvents(ctx, [e], { db });
    const out = await writeRecordWithEvents(ctx, "companies", "co_1", () => ({ patch: { contactCount: 2 }, events: [e] }), { db });
    expect(out).toMatchObject({ outcome: "updated", events: [] });
    expect(fake.raw("companies", "co_1")).toMatchObject({ contactCount: 2 });
    expect(rows(fake)).toHaveLength(1);
  });

  it("refuses agent kinds in a plan, too many events, and collections outside the list", async () => {
    const { fake, db } = world();
    fake.seed("contacts", ADA, { tenantId: "ten_demo" });
    const w = change(ADA);
    await expect(writeRecordWithEvents(ctx, "contacts", ADA, () => ({ patch: {}, events: [{ ...w, kind: "agent.acted" }] }), { db })).rejects.toThrow(TenantValidationError);
    await expect(writeRecordWithEvents(ctx, "contacts", ADA, () => ({ patch: {}, events: Array.from({ length: 101 }, () => change(ADA)) }), { db })).rejects.toThrow(TenantValidationError);
    await expect(writeRecordWithEvents(ctx, "signups" as never, "s1", () => null, { db })).rejects.toThrow(TenantValidationError);
    expect(rows(fake)).toEqual([]);
  });
});

describe("blankFieldEvents and countFieldEvents", () => {
  async function seeded() {
    const w = world();
    const plan = [change(ADA, "plan"), change(BO, "plan"), change(ADA, "plan")];
    await appendEvents(ctx, [...plan, change(ADA, "tier")], { db: w.db, nowIso: NOW });
    await appendEvents(other, [change(deterministicContactId("ten_other", "ada@example.com") as ContactPersonId, "plan")], { db: w.db, nowIso: NOW });
    return { ...w, plan };
  }

  it("blanks only that field's rows in this brand, keeping kind, time, actor and field id", async () => {
    const { fake, db, plan } = await seeded();
    expect(await countFieldEvents(ctx, "plan", { db })).toEqual({ total: 3, toBlank: 3 });
    const out = await blankFieldEvents(ctx, "plan", { db, nowIso: "2026-11-21T09:00:00.000Z" });
    expect(out).toMatchObject({ scanned: 3, blanked: 3, already: 0, gone: 0, more: false });
    for (const w of plan) {
      const row = fake.raw("ontology_events", deterministicEventId("ten_demo", w.key))!;
      expect(row).toMatchObject({
        kind: "record.field_changed",
        at: AT,
        actor: MEMBER,
        fieldId: "plan",
        properties: { fieldId: "plan", object: "person", before: null, after: null, source: "editor" },
        blankedAt: "2026-11-21T09:00:00.000Z",
        blankedReason: "field_erased",
      });
    }
    expect(rows(fake).filter((r) => r.fieldId === "tier")[0]).toMatchObject({ properties: { before: "free", after: "pro" }, blankedAt: null });
    expect(rows(fake).filter((r) => r.tenantId === "ten_other")[0]).toMatchObject({ properties: { before: "free", after: "pro" }, blankedAt: null });
    expect(await countFieldEvents(ctx, "plan", { db })).toEqual({ total: 3, toBlank: 0 });
    expect(await countFieldEvents(other, "plan", { db })).toEqual({ total: 1, toBlank: 1 });
    expect(await blankFieldEvents(ctx, "plan", { db, nowIso: NOW })).toMatchObject({ scanned: 3, blanked: 0, already: 3 });
  });

  it("pages across a boundary with every row once", async () => {
    const { db } = await seeded();
    const first = await blankFieldEvents(ctx, "plan", { db, nowIso: NOW, limit: 2 });
    expect(first).toMatchObject({ scanned: 2, blanked: 2, more: true });
    const second = await blankFieldEvents(ctx, "plan", { db, nowIso: NOW, limit: 2, startAfter: first.last });
    expect(second).toMatchObject({ scanned: 1, blanked: 1, more: false });
    expect(await countFieldEvents(ctx, "plan", { db })).toEqual({ total: 3, toBlank: 0 });
  });

  it("counts a row deleted between the page read and its transaction as gone", async () => {
    const { fake, plan } = await seeded();
    const goneId = deterministicEventId("ten_demo", plan[1]!.key);
    const racing: FirestoreLike = {
      collection: (name) => fake.collection(name),
      runTransaction: async (fn) => {
        fake.cols.get("ontology_events")!.delete(goneId);
        return readsFirst(fake).runTransaction(fn);
      },
    };
    expect(await blankFieldEvents(ctx, "plan", { db: racing, nowIso: NOW })).toMatchObject({ scanned: 3, blanked: 2, gone: 1 });
    expect(fake.raw("ontology_events", goneId)).toBeUndefined();
  });

  it("writes nothing in a dry run, and refuses system and dotted field ids", async () => {
    const { fake, db, plan } = await seeded();
    const id = deterministicEventId("ten_demo", plan[0]!.key);
    const before = fake.writeCountFor("ontology_events", id);
    expect(await blankFieldEvents(ctx, "plan", { db, nowIso: NOW, dryRun: true })).toMatchObject({ scanned: 3, blanked: 3, already: 0 });
    expect(fake.writeCountFor("ontology_events", id)).toBe(before);
    for (const bad of ["sys.stage.pcn_1", "a.b", ""]) {
      await expect(blankFieldEvents(ctx, bad, { db, nowIso: NOW }), bad).rejects.toThrow(TenantValidationError);
      await expect(countFieldEvents(ctx, bad, { db }), bad).rejects.toThrow(TenantValidationError);
    }
  });
});

describe("repointHistoryPage on the event history", () => {
  const OLD = deterministicContactId("ten_demo", "pu:pu_1") as ContactPersonId;
  const NEW = deterministicContactId("ten_demo", "ada@new.example.com") as ContactPersonId;

  async function seeded() {
    const w = world();
    const aboutOld = change(OLD, "plan", { productUserId: "pu_1" });
    const aboutOldAgain = change(OLD, "tier", { productUserId: "pu_1" });
    const filedUnderOld = change(OLD, "note");
    const otherUser = change(BO, "plan", { productUserId: "pu_2" });
    const company = change(OLD, "size", { subject: { type: "company", id: "co_1" }, personId: null, object: "company", productUserId: "pu_1" });
    await appendEvents(ctx, [aboutOld, aboutOldAgain, filedUnderOld, otherUser, company], { db: w.db, nowIso: NOW });
    await appendEvents(other, [change(deterministicContactId("ten_other", "pu:pu_1") as ContactPersonId, "plan", { productUserId: "pu_1" })], { db: w.db, nowIso: NOW });
    const row = (e: EventWrite) => w.fake.raw("ontology_events", deterministicEventId("ten_demo", e.key))!;
    return { ...w, row, aboutOld, aboutOldAgain, filedUnderOld, otherUser, company };
  }

  it("moves a product user's rows to the target, with a person subject, and leaves everyone else's", async () => {
    const { fake, db, row, aboutOld, aboutOldAgain, filedUnderOld, otherUser, company } = await seeded();
    const out = await repointHistoryPage(ctx, { store: "ontologyEvents", by: { productUserId: "pu_1" }, target: NEW }, { db });
    expect(out).toMatchObject({ scanned: 3, moved: 3, unchanged: 0, gone: 0, more: false });
    for (const e of [aboutOld, aboutOldAgain]) expect(row(e)).toMatchObject({ personId: NEW, subject: { type: "person", id: NEW }, subjectKey: `person:${NEW}` });
    // A company's row about the product user follows on personId only: its subject is the company.
    expect(row(company)).toMatchObject({ personId: NEW, subject: { type: "company", id: "co_1" }, subjectKey: "company:co_1" });
    expect(row(filedUnderOld)).toMatchObject({ personId: OLD });
    expect(row(otherUser)).toMatchObject({ personId: BO });
    expect(fake.dump("ontology_events").filter((r) => r.tenantId === "ten_other")[0]).toMatchObject({ personId: deterministicContactId("ten_other", "pu:pu_1") });
    expect(await repointHistoryPage(ctx, { store: "ontologyEvents", by: { productUserId: "pu_1" }, target: NEW }, { db })).toMatchObject({ moved: 0, unchanged: 3 });
  });

  it("moves every row filed under a person, a page at a time", async () => {
    const { db, row, aboutOld, aboutOldAgain, filedUnderOld } = await seeded();
    const first = await repointHistoryPage(ctx, { store: "ontologyEvents", by: { personId: OLD }, target: NEW }, { db, limit: 2 });
    expect(first).toMatchObject({ scanned: 2, moved: 2, more: true });
    const second = await repointHistoryPage(ctx, { store: "ontologyEvents", by: { personId: OLD }, target: NEW }, { db, limit: 2, after: first.last });
    expect(second).toMatchObject({ moved: 1, more: false });
    for (const e of [aboutOld, aboutOldAgain, filedUnderOld]) expect(row(e).personId).toBe(NEW);
  });

  it("writes nothing in a dry run", async () => {
    const { fake, db, aboutOld } = await seeded();
    const id = deterministicEventId("ten_demo", aboutOld.key);
    const before = fake.writeCountFor("ontology_events", id);
    expect(await repointHistoryPage(ctx, { store: "ontologyEvents", by: { productUserId: "pu_1" }, target: NEW }, { db, dryRun: true })).toMatchObject({ scanned: 3, moved: 3 });
    expect(fake.writeCountFor("ontology_events", id)).toBe(before);
    await expect(repointHistoryPage(ctx, { store: "contacts" as never, by: { productUserId: "pu_1" }, target: NEW }, { db })).rejects.toThrow(TenantValidationError);
  });
});

import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { forTenant, proposeAgentAction, setRecordFieldValues } from "./index";
import { RECORD_BYTE_BUDGET } from "./recordFieldWrites";
import type { TenantContext } from "./types";
import { saveFieldListChange, type FieldListChange } from "@/lib/audience/fieldList";
import { deterministicCompanyId, deterministicContactId } from "@/lib/crm/identifiers";
import { agentDedupeKey } from "@/lib/types/agentAction";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "idtoken", role: "admin", userId: "u_admin" };
const other: TenantContext = { ...ctx, tenantId: "ten_B" };
const by = { type: "member", id: "u_admin" } as const;
const T0 = "2026-11-21T09:00:00.000Z";
const T1 = "2026-11-21T10:00:00.000Z";
const PERSON = deterministicContactId("ten_A", "sam@example.com");
const COMPANY = deterministicCompanyId("ten_A", "example.com");

const PLAN = "fld_000000000001";
const SEATS = "fld_000000000002";
const DONE = "fld_000000000003";
const TOPICS = "fld_000000000004";
const OWNER = "fld_000000000005";
const NOTES = "fld_000000000006";
const REGION = "fld_000000000007";

/** Two People fields of each kind the tests need, and one Company field. */
async function world(db: FakeFirestore) {
  let f = 0;
  let o = 0;
  const fld = () => `fld_${String((f += 1)).padStart(12, "0")}`;
  const opt = () => `opt_${String((o += 1)).padStart(8, "0")}`;
  const people: FieldListChange[] = [
    { op: "add", label: "Plan", type: "select", options: ["Free", "Pro"] },
    { op: "add", label: "Seats", type: "number" },
    { op: "add", label: "Onboarded", type: "checkbox" },
    { op: "add", label: "Interests", type: "multi_select", options: ["Analytics", "Exports"] },
    { op: "add", label: "Owner", type: "team_member" },
    { op: "add", label: "Notes", type: "text" },
  ];
  for (const [i, change] of people.entries()) {
    const r = await saveFieldListChange(ctx, "person", { baseRev: i, change, by, nowIso: T0, newFieldId: fld, newOptionId: opt }, db);
    if (!r.ok) throw new Error(r.error);
  }
  await saveFieldListChange(ctx, "company", { baseRev: 0, change: { op: "add", label: "Region", type: "text" }, by, nowIso: T0, newFieldId: fld }, db);
  await db.collection("contacts").doc(PERSON).set({ tenantId: "ten_A", contactKey: "sam@example.com", email: "sam@example.com", memberOf: ["all", "launch:any"], updatedAt: T0 });
  await db.collection("companies").doc(COMPANY).set({ tenantId: "ten_A", domain: "example.com", updatedAt: T0 });
}

let n = 0;
const nonce = () => `n${(n += 1)}`;
const set = (db: FakeFirestore, changes: Record<string, unknown>, over: Partial<Parameters<typeof setRecordFieldValues>[1]> = {}) =>
  setRecordFieldValues(ctx, { object: "person", recordId: PERSON, changes, by, source: "editor", nowIso: T1, nonce, ...over }, { db });

describe("setRecordFieldValues", () => {
  it("writes the values, their tags and one event per changed value, together", async () => {
    const db = new FakeFirestore();
    await world(db);
    const r = await set(db, { [PLAN]: "opt_00000002", [SEATS]: 12, [DONE]: true, [TOPICS]: ["opt_00000003", "opt_00000004"] });
    expect(r).toMatchObject({ ok: true, outcome: "updated", changed: [PLAN, SEATS, DONE, TOPICS] });
    const contact = await forTenant(ctx, db).contacts.getById(PERSON);
    expect(contact?.fields).toEqual({ [PLAN]: "opt_00000002", [SEATS]: 12, [DONE]: true, [TOPICS]: ["opt_00000003", "opt_00000004"] });
    expect(contact?.memberOf).toEqual(
      ["all", "launch:any", `field:${PLAN}:opt_00000002`, `field:${DONE}:yes`, `field:${TOPICS}:opt_00000003`, `field:${TOPICS}:opt_00000004`].sort(),
    );
    expect(contact?.changedAt).toBe(T1);
    const events = await forTenant(ctx, db).ontologyEvents.find({ where: [["personId", "==", PERSON]] });
    expect(events).toHaveLength(4);
    const seats = events.find((e) => e.fieldId === SEATS)!;
    expect(seats).toMatchObject({
      kind: "record.field_changed",
      subject: { type: "person", id: PERSON },
      actor: by,
      at: T1,
      properties: { fieldId: SEATS, object: "person", before: null, after: 12, source: "editor" },
    });
  });

  it("writes nothing for an unchanged value, and clears with null", async () => {
    const db = new FakeFirestore();
    await world(db);
    await set(db, { [PLAN]: "opt_00000001", [DONE]: true });
    expect(await set(db, { [PLAN]: "opt_00000001" })).toMatchObject({ ok: true, outcome: "unchanged", events: [] });
    const cleared = await set(db, { [PLAN]: null, [DONE]: false });
    expect(cleared).toMatchObject({ ok: true, outcome: "updated", changed: [PLAN, DONE] });
    const contact = await forTenant(ctx, db).contacts.getById(PERSON);
    expect(contact?.fields).toEqual({ [DONE]: false });
    expect(contact?.memberOf).toEqual(["all", "launch:any"]);
    const events = await forTenant(ctx, db).ontologyEvents.find({ where: [["fieldId", "==", PLAN]] });
    const pairs = events.map((e) => [e.properties.before, e.properties.after]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(expect.arrayContaining([["opt_00000001", null], [null, "opt_00000001"]]));
  });

  it("refuses unknown and archived fields, bad values and someone not on the team, writing nothing", async () => {
    const db = new FakeFirestore();
    await world(db);
    expect(await set(db, { fld_999999999999: "x" })).toEqual({ ok: false, error: "unknown_field", fieldId: "fld_999999999999" });
    expect(await set(db, { "fields.x": "x" })).toMatchObject({ ok: false, error: "unknown_field" });
    expect(await set(db, { [SEATS]: "twelve" })).toMatchObject({ ok: false, error: "invalid_value", fieldId: SEATS });
    expect(await set(db, { [PLAN]: "opt_00000003" })).toMatchObject({ ok: false, error: "invalid_value", fieldId: PLAN });
    expect(await set(db, { [OWNER]: "u_gone" }, { members: new Set(["u_admin"]) })).toMatchObject({ ok: false, error: "invalid_value", reason: "not_on_team" });
    expect(await set(db, { [OWNER]: "u_admin" }, { members: new Set(["u_admin"]) })).toMatchObject({ ok: true, outcome: "updated" });
    await saveFieldListChange(ctx, "person", { baseRev: 6, change: { op: "archive", key: NOTES }, by, nowIso: T1 }, db);
    expect(await set(db, { [NOTES]: "hello", [SEATS]: 3 })).toEqual({ ok: false, error: "archived_field", fieldId: NOTES });
    const contact = await forTenant(ctx, db).contacts.getById(PERSON);
    expect(contact?.fields).toEqual({ [OWNER]: "u_admin" });
    expect(await set(db, { [SEATS]: 1 }, { recordId: deterministicContactId("ten_A", "nobody@example.com") })).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses with stale, writing nothing, when a field no longer holds what the caller expects", async () => {
    const db = new FakeFirestore();
    await world(db);
    await set(db, { [SEATS]: 12 });
    expect(await set(db, { [SEATS]: 15 }, { expect: { [SEATS]: 10 } })).toEqual({ ok: false, error: "stale", fieldId: SEATS });
    expect(await set(db, { [SEATS]: 15 }, { expect: { [PLAN]: "opt_00000001" } })).toEqual({ ok: false, error: "stale", fieldId: PLAN });
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.fields).toEqual({ [SEATS]: 12 });
    // null expects no value; a multi select compares as a set.
    await set(db, { [TOPICS]: ["opt_00000003", "opt_00000004"] });
    expect(await set(db, { [SEATS]: 15, [PLAN]: "opt_00000002" }, { expect: { [SEATS]: 12, [PLAN]: null, [TOPICS]: ["opt_00000004", "opt_00000003"] } })).toMatchObject({
      ok: true,
      changed: [SEATS, PLAN],
    });
  });

  it("lets a value keep an option archived since, so it can still be edited, but never pick one again", async () => {
    const db = new FakeFirestore();
    await world(db);
    await set(db, { [TOPICS]: ["opt_00000003", "opt_00000004"], [PLAN]: "opt_00000001" });
    const change = (baseRev: number, c: FieldListChange) => saveFieldListChange(ctx, "person", { baseRev, change: c, by, nowIso: T1, newOptionId: () => "opt_00000009" }, db);
    await change(6, { op: "archive_option", key: TOPICS, optionId: "opt_00000004" });
    await change(7, { op: "archive_option", key: PLAN, optionId: "opt_00000001" });
    await change(8, { op: "add_option", key: TOPICS, label: "Billing" });
    // Ticking another option with the archived one still ticked.
    expect(await set(db, { [TOPICS]: ["opt_00000003", "opt_00000004", "opt_00000009"] })).toMatchObject({ ok: true, changed: [TOPICS] });
    // Saving another field while a select still holds its archived option.
    expect(await set(db, { [PLAN]: "opt_00000001", [SEATS]: 3 })).toMatchObject({ ok: true, changed: [SEATS] });
    // Taking the archived one off works; picking it again doesn't.
    expect(await set(db, { [TOPICS]: ["opt_00000003"] })).toMatchObject({ ok: true, changed: [TOPICS] });
    expect(await set(db, { [TOPICS]: ["opt_00000003", "opt_00000004"] })).toMatchObject({ ok: false, error: "invalid_value", fieldId: TOPICS, reason: "option" });
    expect(await set(db, { [PLAN]: "opt_00000002" })).toMatchObject({ ok: true, changed: [PLAN] });
    expect(await set(db, { [PLAN]: "opt_00000001" })).toMatchObject({ ok: false, error: "invalid_value", fieldId: PLAN });
    // An undo puts back what the record held before, archived options and all.
    expect(await set(db, { [PLAN]: "opt_00000001" }, { restoring: true })).toMatchObject({ ok: true, changed: [PLAN] });
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.fields).toEqual({ [TOPICS]: ["opt_00000003"], [PLAN]: "opt_00000001", [SEATS]: 3 });
  });

  it("refuses a value for a field archived in a racing transaction", async () => {
    const db = new FakeFirestore();
    await world(db);
    // The archive lands between this write's reads and its commit: the write runs again and sees it.
    db.onBeforeCommit = async () => {
      await saveFieldListChange(ctx, "person", { baseRev: 6, change: { op: "archive", key: NOTES }, by, nowIso: T1 }, db);
    };
    expect(await set(db, { [NOTES]: "hello" })).toEqual({ ok: false, error: "archived_field", fieldId: NOTES });
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.fields).toBeUndefined();
    expect(await forTenant(ctx, db).ontologyEvents.find({ where: [["fieldId", "==", NOTES]] })).toEqual([]);
  });

  it("writes company values with their events, and no tags", async () => {
    const db = new FakeFirestore();
    await world(db);
    const r = await setRecordFieldValues(ctx, { object: "company", recordId: COMPANY, changes: { [REGION]: "Europe" }, by, source: "editor", nowIso: T1 }, { db });
    expect(r).toMatchObject({ ok: true, outcome: "updated", changed: [REGION] });
    const company = await forTenant(ctx, db).companies.getById(COMPANY);
    expect(company?.fields).toEqual({ [REGION]: "Europe" });
    expect((company as unknown as { memberOf?: unknown }).memberOf).toBeUndefined();
    const events = await forTenant(ctx, db).ontologyEvents.find({ where: [["subjectKey", "==", `company:${COMPANY}`]] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personId: null, properties: { object: "company", after: "Europe" } });
    // A People field is unknown on a company.
    expect(await setRecordFieldValues(ctx, { object: "company", recordId: COMPANY, changes: { [PLAN]: "opt_00000001" }, by, source: "editor" }, { db })).toMatchObject({
      ok: false,
      error: "unknown_field",
    });
  });

  it("keeps the whole record under its budget", async () => {
    const db = new FakeFirestore();
    await world(db);
    await db.collection("contacts").doc(PERSON).update({ padding: "x".repeat(RECORD_BYTE_BUDGET - 1000) });
    expect(await set(db, { [NOTES]: "y".repeat(2000) })).toEqual({ ok: false, error: "record_too_large" });
    expect(await set(db, { [SEATS]: 1 })).toMatchObject({ ok: true, outcome: "updated" });
  });

  it("commits an agent action's decision with the values, or refuses when it can't move", async () => {
    const db = new FakeFirestore();
    await world(db);
    const { action } = await proposeAgentAction(
      ctx,
      {
        dedupeKey: agentDedupeKey("person_fields.suggest", "t1"),
        agent: "vizzy",
        action: "person_fields.suggest",
        target: { type: "person", id: PERSON },
        personId: PERSON as `ct_${string}`,
        proposal: { fields: { [SEATS]: 15 } },
        basis: null,
        fieldIds: [SEATS],
        signals: [],
        review: null,
        requestedBy: { type: "agent", id: "vizzy" },
        expiresAt: "2026-11-28T10:00:00.000Z",
        at: T0,
      },
      { db },
    );
    const transition = { to: "acted" as const, by, at: T1 };
    const r = await set(db, { [SEATS]: 15 }, { source: "agent", agentAction: { id: action.id, transition } });
    expect(r).toMatchObject({ ok: true, outcome: "updated", agentAction: { state: "acted" } });
    const events = await forTenant(ctx, db).ontologyEvents.find({ where: [["personId", "==", PERSON]] });
    expect(events.map((e) => e.kind).sort()).toEqual(["agent.acted", "agent.approved", "agent.proposed", "record.field_changed"]);
    expect(events.find((e) => e.kind === "record.field_changed")).toMatchObject({ agentActionId: action.id, source: { system: "agent" } });
    // Deciding it again can't happen: nothing is written.
    expect(await set(db, { [SEATS]: 16 }, { agentAction: { id: action.id, transition } })).toEqual({ ok: false, error: "agent_action_wrong_state" });
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.fields).toEqual({ [SEATS]: 15 });
  });

  it("never reads or writes another brand's record or list", async () => {
    const db = new FakeFirestore();
    await world(db);
    await expect(setRecordFieldValues(other, { object: "person", recordId: PERSON, changes: {}, by, source: "editor" }, { db })).rejects.toThrow(/another tenant/);
    // Brand B has no list of its own: every field is unknown to it, whatever A's list says.
    const otherPerson = deterministicContactId("ten_B", "sam@example.com");
    await db.collection("contacts").doc(otherPerson).set({ tenantId: "ten_B", contactKey: "sam@example.com" });
    expect(await setRecordFieldValues(other, { object: "person", recordId: otherPerson, changes: { [SEATS]: 3 }, by, source: "editor" }, { db })).toMatchObject({
      ok: false,
      error: "unknown_field",
    });
  });
});

describe("repairFieldTags", () => {
  it("rebuilds a person's field tags from their values, writes nothing on a dry run, and is safe to repeat", async () => {
    const { repairFieldTags } = await import("./recordFieldWrites");
    const db = new FakeFirestore();
    await world(db);
    // Values from before the tags existed.
    await db.collection("contacts").doc(PERSON).update({ fields: { [PLAN]: "opt_00000002", [DONE]: true }, memberOf: ["all", "launch:any"] });
    expect(await repairFieldTags(ctx, PERSON, { db, dryRun: true })).toBe("updated");
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.memberOf).toEqual(["all", "launch:any"]);
    expect(await repairFieldTags(ctx, PERSON, { db })).toBe("updated");
    expect((await forTenant(ctx, db).contacts.getById(PERSON))?.memberOf).toEqual(["all", `field:${DONE}:yes`, `field:${PLAN}:opt_00000002`, "launch:any"].sort());
    expect(await repairFieldTags(ctx, PERSON, { db })).toBe("unchanged");
    expect(await repairFieldTags(ctx, deterministicContactId("ten_A", "nobody@example.com"), { db })).toBe("missing");
    await expect(repairFieldTags(other, PERSON, { db })).rejects.toThrow(/another tenant/);
  });
});

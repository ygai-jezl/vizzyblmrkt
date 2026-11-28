import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { addPerson } from "@/lib/audience/addPerson";
import { readFieldList, saveFieldListChange } from "@/lib/audience/fieldList";
import { parseNewPerson } from "@/lib/audience/newPerson";
import { personIdOf } from "@/lib/audience/personSync";
import { deterministicCompanyId } from "@/lib/crm/identifiers";
import { ctx, seedWorld, T0, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import type { AgentAction } from "@/lib/types/agentAction";
import type { Company } from "@/lib/types/company";
import type { Contact } from "@/lib/types/contact";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import { addPasteBatch } from "./apply";
import { readPaste } from "./batch";
import { DONE_WHEN_TSV } from "./testing/samples";
import { addField, F, optionId } from "./testing/world";

const DAY = 86_400_000;
const NOW = new Date(T0 + 60_000).toISOString();
const other = { ...ctx, tenantId: "ten_other", userId: "usr_9" };
const contact = (db: FakeFirestore, key: string) => db.raw("contacts", personIdOf(TENANT_ID, key)) as unknown as Contact | undefined;
const company = (db: FakeFirestore, domain: string) => db.raw("companies", deterministicCompanyId(TENANT_ID, domain)) as unknown as Company | undefined;
const events = (db: FakeFirestore) => db.dump("ontology_events") as unknown as StoredEvent[];
const action = (db: FakeFirestore, id: string) => db.raw("agent_actions", id) as unknown as AgentAction;

async function pasted(text = DONE_WHEN_TSV, opts: { fields?: boolean; db?: FakeFirestore } = {}) {
  const db = opts.db ?? new FakeFirestore();
  if (!opts.db) seedWorld(db);
  const r = await readPaste(ctx, { text, source: "Our advisers' sheet", from: "box" }, { db, nowMs: T0, fields: opts.fields });
  if (!r.ok || r.outcome !== "ready") throw new Error(JSON.stringify(r));
  return { db, id: r.batch.id, rev: r.batch.rev };
}

describe("addPasteBatch", () => {
  it("adds 10 people at Not yet and 3 companies, each with where the list is from, then closes the card", async () => {
    const { db, id, rev } = await pasted();
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(r).toEqual({ ok: true, added: { people: 10, companies: 3 }, already: { people: 0, companies: 0 }, fieldsNotSaved: 0 });

    expect(db.dump("contacts")).toHaveLength(10);
    const jo = contact(db, "jo@northfield-ventures.test")!;
    expect(jo).toMatchObject({
      email: "jo@northfield-ventures.test",
      firstName: "Jo",
      lastName: "Example",
      status: "active",
      consentStatus: "none",
      reach: "no",
      addedBy: { kind: "member", id: "usr_1", at: NOW, via: "paste", source: "Our advisers' sheet" },
      memberOf: ["added:hand", "all"],
      companyId: deterministicCompanyId(TENANT_ID, "northfield-ventures.test"),
    });
    expect(jo.consent).toBeUndefined();

    expect(db.dump("companies")).toHaveLength(3);
    expect(company(db, "meadow-seed.test")).toMatchObject({
      domain: "meadow-seed.test",
      name: "Meadow Seed Fund",
      source: "import",
      enrichmentStatus: "manual",
      profile: null,
      contactCount: 0,
      addedBy: { kind: "member", id: "usr_1", at: NOW, via: "paste", source: "Our advisers' sheet" },
      searchTokens: expect.arrayContaining(["meadow", "seed", "fund", "meadow-seed.test"]),
    });

    const created = events(db).filter((e) => e.kind === "record.created");
    expect(created).toHaveLength(13);
    for (const e of created) expect(e).toMatchObject({ agentActionId: id, actor: { type: "member", id: "usr_1" }, properties: { via: "paste", source: "Our advisers' sheet" } });
    expect(created.filter((e) => e.subject.type === "company")).toHaveLength(3);
    expect(created.find((e) => e.personId === personIdOf(TENANT_ID, "jo@northfield-ventures.test"))?.properties).toEqual({ object: "person", via: "paste", source: "Our advisers' sheet" });
    // No consent anywhere.
    expect(events(db).filter((e) => e.kind === "consent.recorded")).toHaveLength(0);

    expect(action(db, id)).toMatchObject({
      state: "acted",
      proposal: null,
      basis: null,
      actedBy: { type: "member", id: "usr_1" },
      result: { people: { added: 10, already: 0 }, companies: { added: 3, already: 0 }, fieldsNotSaved: 0 },
    });
    // Add again: the card is gone, and nobody is added twice.
    expect(await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 120_000 })).toEqual({ ok: false, error: "paste_gone" });
    expect(db.dump("contacts")).toHaveLength(10);
  });

  it("sets each row's own field values, on people and companies, through the one writer", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addField(ctx, db, "company", F.stage, "Stage", "multi_select", ["Seed", "Series A"]);
    await addField(ctx, db, "person", F.title, "Title", "text");
    const text = ["Email\tTitle\tWebsite\tStages\tCompany", "jo@example.com\tPartner\t\tSeed\t", "\tPartner\tmeadow-seed.test\tSeed, Series A\tMeadow Seed Fund"].join("\n");
    const { id, rev } = await pasted(text, { db, fields: true });
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000, fields: true });
    expect(r).toMatchObject({ ok: true, added: { people: 1, companies: 1 }, fieldsNotSaved: 0 });
    expect(contact(db, "jo@example.com")?.fields).toEqual({ [F.title]: "Partner" });
    expect(company(db, "meadow-seed.test")?.fields).toEqual({ [F.stage]: [optionId(F.stage, 0), optionId(F.stage, 1)] });
    const changes = events(db).filter((e) => e.kind === "record.field_changed");
    expect(changes.map((e) => [e.subject.type, (e.properties as { source: string }).source]).sort()).toEqual([
      ["company", "import"],
      ["person", "import"],
    ]);
  });

  it("drops a value whose field was archived since, and still adds the person", async () => {
    const db = new FakeFirestore();
    seedWorld(db);
    await addField(ctx, db, "person", F.title, "Title", "text");
    const { id, rev } = await pasted("Email\tTitle\njo@example.com\tPartner", { db, fields: true });
    const list = await readFieldList(ctx, "person", db);
    const archived = await saveFieldListChange(ctx, "person", { baseRev: list.rev, change: { op: "archive", key: F.title }, by: { type: "member", id: "usr_1" } }, db);
    expect(archived.ok).toBe(true);
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000, fields: true });
    expect(r).toMatchObject({ ok: true, added: { people: 1, companies: 0 }, fieldsNotSaved: 1 });
    expect(contact(db, "jo@example.com")).toMatchObject({ addedBy: { via: "paste" } });
    expect(contact(db, "jo@example.com")?.fields).toBeUndefined();
  });

  it("leaves someone added since the paste as they are, and counts them as already here", async () => {
    const { db, id, rev } = await pasted();
    const p = parseNewPerson({ email: "jo@northfield-ventures.test", firstName: "Joanna" });
    if (!p.ok) throw new Error(p.error);
    await addPerson({ ...ctx, userId: "usr_2" }, p.value, { db, nowIso: new Date(T0 + 1000).toISOString() });
    const before = { ...contact(db, "jo@northfield-ventures.test") };
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(r).toMatchObject({ ok: true, added: { people: 9, companies: 3 }, already: { people: 1, companies: 0 } });
    expect(contact(db, "jo@northfield-ventures.test")).toEqual(before);
    expect(contact(db, "jo@northfield-ventures.test")).toMatchObject({ firstName: "Joanna", addedBy: { via: "form", id: "usr_2" } });
  });

  it("never overwrites a company made since the paste", async () => {
    const { db, id, rev } = await pasted();
    const coId = deterministicCompanyId(TENANT_ID, "meadow-seed.test");
    db.seed("companies", coId, { tenantId: TENANT_ID, domain: "meadow-seed.test", name: "Meadow (enriched)", enrichmentStatus: "enriched", contactCount: 0, searchTokens: [] });
    const r = await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(r).toMatchObject({ added: { companies: 2 }, already: { companies: 1 } });
    expect(company(db, "meadow-seed.test")).toMatchObject({ name: "Meadow (enriched)", enrichmentStatus: "enriched" });
    expect(company(db, "meadow-seed.test")?.addedBy).toBeUndefined();
  });

  it("counts the people at a company the list made", async () => {
    const text = ["Email\tWebsite\tCompany", "jo@meadow-seed.test\t\t", "kim@meadow-seed.test\t\t", "\tmeadow-seed.test\tMeadow Seed Fund"].join("\n");
    const { db, id, rev } = await pasted(text);
    await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(company(db, "meadow-seed.test")).toMatchObject({ contactCount: 2 });
  });

  it("answers changed for an old rev, and gone once dismissed or past its 7 days", async () => {
    const one = await pasted();
    expect(await addPasteBatch(ctx, one.id, one.rev + 1, { db: one.db, nowMs: T0 + 60_000 })).toEqual({ ok: false, error: "changed" });
    expect(one.db.dump("contacts")).toHaveLength(0);

    const late = await pasted();
    expect(await addPasteBatch(ctx, late.id, late.rev, { db: late.db, nowMs: T0 + 7 * DAY })).toEqual({ ok: false, error: "paste_gone" });
    expect(action(late.db, late.id)).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null });
    expect(late.db.dump("contacts")).toHaveLength(0);

    expect(await addPasteBatch(ctx, "aa_nope", 1, { db: late.db })).toEqual({ ok: false, error: "paste_gone" });
    expect(await addPasteBatch({ ...ctx, userId: undefined }, one.id, one.rev, { db: one.db })).toEqual({ ok: false, error: "no_user" });
  });

  it("is not found from another brand, and leaves another brand's people and companies alone", async () => {
    const { db, id, rev } = await pasted();
    const theirs = deterministicCompanyId("ten_other", "meadow-seed.test");
    db.seed("companies", theirs, { tenantId: "ten_other", domain: "meadow-seed.test", name: "Theirs", enrichmentStatus: "manual", contactCount: 5, searchTokens: [] });
    db.seed("contacts", personIdOf("ten_other", "jo@northfield-ventures.test"), { tenantId: "ten_other", contactKey: "jo@northfield-ventures.test", firstName: "Theirs" });
    expect(await addPasteBatch(other, id, rev, { db, nowMs: T0 + 60_000 })).toEqual({ ok: false, error: "paste_gone" });
    expect(db.dump("contacts")).toHaveLength(1);
    await addPasteBatch(ctx, id, rev, { db, nowMs: T0 + 60_000 });
    expect(db.raw("companies", theirs)).toMatchObject({ name: "Theirs", contactCount: 5 });
    expect(db.raw("contacts", personIdOf("ten_other", "jo@northfield-ventures.test"))).toMatchObject({ firstName: "Theirs" });
  });
});

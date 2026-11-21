import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Vizzy's suggestions on a person's page (AUDIENCE_VIZZY_FIELDS_ENABLED): anyone reads, admins decide.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const route = await import("./route");
const { saveFieldListChange } = await import("@/lib/audience/fieldList");
const { suggestFieldChanges } = await import("@/lib/audience/fieldSuggestions");
const { setFieldValues } = await import("@/lib/audience/fields");
const { getAgentAction } = await import("@/lib/ontology/agentActions");
const { listPersonEvents } = await import("@/lib/ontology/timeline");
const { deterministicContactId } = await import("@/lib/crm/identifiers");
const { SUGGESTION_MESSAGES, suggestionErrorText } = await import("@/lib/audience/suggestionWords");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const vizzy = { ...admin, source: "agent" } as const;
const by = { type: "member", id: "u_admin" } as const;
const PERSON = deterministicContactId("ten_A", "jo@example.com");
const SEATS = "fld_ddddddddddd1";
const PLAN = "fld_ddddddddddd2";

const params = { params: Promise.resolve({ personId: PERSON }) };
const get = () => route.GET(new Request("http://localhost/x"), params);
const post = (body: unknown) => route.POST(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params);

let db: FakeFirestore;
async function suggestion(changes: Record<string, unknown>) {
  const r = await suggestFieldChanges(vizzy, { personId: PERSON, changes, why: "Their team grew." }, { db });
  if (!r.ok) throw new Error(r.error);
  return r.action;
}
const fields = () => (db.raw("contacts", PERSON) as { fields?: Record<string, unknown> }).fields;

beforeEach(async () => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
  await saveFieldListChange(admin, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, newFieldId: () => SEATS }, db);
  let o = 0;
  await saveFieldListChange(admin, "person", { baseRev: 1, change: { op: "add", label: "Plan", type: "select", options: ["Starter", "Pro"] }, by, newFieldId: () => PLAN, newOptionId: () => ["opt_dddddd01", "opt_dddddd02"][o++]! }, db);
  db.seed("contacts", PERSON, { tenantId: "ten_A", contactKey: "jo@example.com", memberOf: ["all"], fields: { [SEATS]: 12, [PLAN]: "opt_dddddd01" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("a person's suggestions from Vizzy", () => {
  it("don't exist while the switch is off; members read, admins decide", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    expect((await get()).status).toBe(404);
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(member);
    const read = await get();
    expect(read.status).toBe(200);
    expect((await read.json()).open).toHaveLength(1);
    const refused = await post({ id: a.id, rev: a.rev, decision: "confirm" });
    expect(refused.status).toBe(403);
    expect(fields()).toEqual({ [SEATS]: 12, [PLAN]: "opt_dddddd01" });
  });

  it("show each open one in words, with the values it changes from", async () => {
    await suggestion({ [SEATS]: 15, [PLAN]: "opt_dddddd02" });
    const body = await (await get()).json();
    expect(body.open).toHaveLength(1);
    expect(body.open[0]).toMatchObject({
      state: "proposed",
      why: "Their team grew.",
      lines: [
        { fieldId: SEATS, label: "Seats", type: "number", before: "12", after: "15" },
        { fieldId: PLAN, label: "Plan", type: "select", before: "Starter", after: "Pro" },
      ],
    });
    expect(body.confirmed).toEqual([]);
  });

  it("confirm writes through the field writer with its events, and undo puts the earlier values back", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    const res = await post({ id: a.id, rev: a.rev, decision: "confirm" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "acted" });
    expect(fields()).toEqual({ [SEATS]: 15, [PLAN]: "opt_dddddd01" });
    const acted = await getAgentAction(admin, a.id, { db });
    expect(acted).toMatchObject({ state: "acted", actedBy: by, result: { fields: { [SEATS]: 15 } }, undo: { before: { [SEATS]: 12 } } });
    let events = (await listPersonEvents(admin, PERSON as `ct_${string}`, { db })).events;
    expect(events.map((e) => e.kind).sort()).toEqual(["agent.acted", "agent.approved", "agent.proposed", "record.field_changed"]);
    expect(events.find((e) => e.kind === "record.field_changed")).toMatchObject({ actor: by, agentActionId: a.id, properties: { before: 12, after: 15, source: "agent" } });

    const after = await (await get()).json();
    expect(after.open).toEqual([]);
    expect(after.confirmed[0]).toMatchObject({ id: a.id, state: "acted", lines: [{ before: "12", after: "15" }] });

    const undone = await post({ id: a.id, rev: acted!.rev, decision: "undo" });
    expect(await undone.json()).toEqual({ state: "undone" });
    expect(fields()).toEqual({ [SEATS]: 12, [PLAN]: "opt_dddddd01" });
    events = (await listPersonEvents(admin, PERSON as `ct_${string}`, { db })).events;
    expect(events.filter((e) => e.kind === "agent.undone")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "record.field_changed").map((e) => e.properties.source).sort()).toEqual(["agent", "undo"]);
    expect((await (await get()).json()).confirmed).toEqual([]);
  });

  it("refuses a stale one with a plain message and sets it aside", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    await setFieldValues(admin, { object: "person", recordId: PERSON, changes: { [SEATS]: 13 }, by, source: "editor" }, { db });
    const res = await post({ id: a.id, rev: a.rev, decision: "confirm" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "stale", fieldId: SEATS });
    expect(suggestionErrorText(body)).toBe(SUGGESTION_MESSAGES.stale);
    expect(fields()).toMatchObject({ [SEATS]: 13 });
    expect(await getAgentAction(admin, a.id, { db })).toMatchObject({ state: "declined", declined: { reason: "stale" } });
  });

  it("undo puts back an option archived after the confirm", async () => {
    const a = await suggestion({ [PLAN]: "opt_dddddd02" });
    await post({ id: a.id, rev: a.rev, decision: "confirm" });
    await saveFieldListChange(admin, "person", { baseRev: 2, change: { op: "archive_option", key: PLAN, optionId: "opt_dddddd01" }, by }, db);
    const acted = await getAgentAction(admin, a.id, { db });
    expect(await (await post({ id: a.id, rev: acted!.rev, decision: "undo" })).json()).toEqual({ state: "undone" });
    expect(fields()).toEqual({ [SEATS]: 12, [PLAN]: "opt_dddddd01" });
  });

  it("won't undo once a field was changed again", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    await post({ id: a.id, rev: a.rev, decision: "confirm" });
    await setFieldValues(admin, { object: "person", recordId: PERSON, changes: { [SEATS]: 20 }, by, source: "editor" }, { db });
    const acted = await getAgentAction(admin, a.id, { db });
    const res = await post({ id: a.id, rev: acted!.rev, decision: "undo" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "edited_since" });
    expect(fields()).toMatchObject({ [SEATS]: 20 });
  });

  it("dismiss closes it and changes nothing; a decision on an old rev answers changed", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    expect(await (await post({ id: a.id, rev: a.rev, decision: "dismiss" })).json()).toEqual({ state: "declined" });
    expect(await getAgentAction(admin, a.id, { db })).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, decidedBy: by });
    expect(fields()).toEqual({ [SEATS]: 12, [PLAN]: "opt_dddddd01" });
    const again = await post({ id: a.id, rev: a.rev, decision: "confirm" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "changed" });
  });

  it("finds nothing for another person's suggestion, a bad id or bad input", async () => {
    const a = await suggestion({ [SEATS]: 15 });
    const other = deterministicContactId("ten_A", "kim@example.com");
    const wrongPerson = await route.POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ id: a.id, rev: 1, decision: "confirm" }) }),
      { params: Promise.resolve({ personId: other }) },
    );
    expect(wrongPerson.status).toBe(404);
    expect((await post({ id: "aa_nothere", rev: 1, decision: "confirm" })).status).toBe(404);
    expect((await post({ id: a.id, rev: 1, decision: "approve" })).status).toBe(400);
  });
});

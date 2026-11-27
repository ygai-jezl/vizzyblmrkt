import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { transitionAgentAction, type TenantContext } from "@/lib/tenant";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { listPersonEvents } from "@/lib/ontology/timeline";
import { readFieldList, saveFieldListChange, type FieldListChange } from "@/lib/audience/fieldList";
import { decideFieldSuggestion, openFieldSuggestions, PERSON_FIELDS_ACTION } from "@/lib/audience/fieldSuggestions";
import type { AgentActionId } from "@/lib/types/agentAction";
import { authorPersonFields } from "./personFields";
import { getCanvasKind } from "../registry";

/** The canvas route's stamp with LOOPS_ENABLED off (learning loops step 5). */
const LOOPS_OFF = { unstamped: "loops_off" } as const;

const admin: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const member: TenantContext = { ...admin, userId: "u_member", role: "member" };
const by = { type: "member", id: "u_admin" } as const;
const PRIYA = deterministicContactId("ten_A", "priya.shah@example.com");
const SEATS = "fld_ccccccccccc1";
const PLAN = "fld_ccccccccccc2";
const NOTES = "fld_ccccccccccc3";
const OLD = "fld_ccccccccccc4";
const TITLE = "fld_ccccccccccc5";
const T0 = Date.parse("2026-11-21T10:00:00.000Z");

let db: FakeFirestore;
/** Turns on text fields an admin let Vizzy read (AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED, which needs Vizzy's fields). */
function textFieldsOn(on = true) {
  for (const k of ["AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
  vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", on ? "true" : "false");
}
async function add(id: string, change: FieldListChange, options: string[] = []) {
  const { rev } = await readFieldList(admin, "person", db);
  let n = 0;
  const r = await saveFieldListChange(admin, "person", { baseRev: rev, change, by, newFieldId: () => id, newOptionId: () => options[n++]! }, db);
  if (!r.ok) throw new Error(r.error);
}
const author = (input: Record<string, unknown>, ctx: TenantContext = admin, nowMs = T0) => authorPersonFields({ ctx, input, made: LOOPS_OFF, brief: "" }, { db, nowMs });
const suggest = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) => author({ kind: "person_fields", action: "save_draft", scope: { personId: PRIYA }, changes, ...extra });

beforeEach(async () => {
  __resetRateLimitState();
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  await add(SEATS, { op: "add", label: "Seats", type: "number" });
  await add(PLAN, { op: "add", label: "Plan", type: "select", options: ["Starter", "Pro"] }, ["opt_cccccc01", "opt_cccccc02"]);
  await add(NOTES, { op: "add", label: "Notes", type: "text" });
  await add(OLD, { op: "add", label: "Old seats", type: "number" });
  await add(OLD, { op: "archive", key: OLD });
  await add(TITLE, { op: "add", label: "Job Title", type: "text", vizzyReads: true });
  db.seed("contacts", PRIYA, {
    tenantId: "ten_A",
    contactKey: "priya.shah@example.com",
    email: "priya.shah@example.com",
    firstName: "Priya",
    lastName: "Shah",
    memberOf: ["all"],
    fields: { [SEATS]: 12, [PLAN]: "opt_cccccc01" },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("the person_fields kind", () => {
  it("is registered", () => {
    expect(getCanvasKind("person_fields")?.label).toMatch(/field changes/);
  });

  it("answers unavailable while the switch is off, and is for admins only", async () => {
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    expect(await suggest({ [SEATS]: 15 })).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    expect(await author({ scope: { personId: PRIYA }, changes: { [SEATS]: 15 } }, member)).toMatchObject({ ok: false, status: 403 });
    expect(await author({ scope: { personId: PRIYA }, changes: { [SEATS]: 15 } }, { ...admin, role: undefined })).toMatchObject({ ok: false, status: 403 });
  });

  it("saves a suggestion with the values it changes from, and changes nothing", async () => {
    const r = await suggest({ [SEATS]: 15, [PLAN]: "opt_cccccc01" }, { why: "Their workspace has had 15 members since 18 Nov." });
    expect(r).toMatchObject({ ok: true, status: "suggested", url: `/admin/crm/people/${PRIYA}#vizzy` });
    if (!r.ok) throw new Error("not saved");
    expect(r.card).toMatchObject({ kind: "person_fields", title: "Field changes for this person", stats: [{ label: "field", value: 1 }] });
    expect(JSON.stringify(r.card)).not.toMatch(/Priya|Shah|example\.com/);
    const action = await getAgentAction(admin, r.id as AgentActionId, { db });
    expect(action).toMatchObject({
      action: PERSON_FIELDS_ACTION,
      agent: "vizzy",
      state: "proposed",
      personId: PRIYA,
      target: { type: "person", id: PRIYA },
      // The plan already is Starter: only the seats are suggested.
      proposal: { fields: { [SEATS]: 15 }, why: "Their workspace has had 15 members since 18 Nov." },
      basis: { fields: { [SEATS]: 12 } },
      fieldIds: [SEATS],
      review: { kind: "person_suggestion", href: `/admin/crm/people/${PRIYA}#vizzy` },
      requestedBy: { type: "member", id: "u_admin" },
      expiresAt: new Date(T0 + 30 * 86_400_000).toISOString(),
    });
    expect(db.raw("contacts", PRIYA)?.fields).toEqual({ [SEATS]: 12, [PLAN]: "opt_cccccc01" });
    const events = await listPersonEvents(admin, PRIYA as `ct_${string}`, { db });
    expect(events.events.map((e) => e.kind)).toEqual(["agent.proposed"]);
  });

  it("refuses a field that isn't there, is archived, isn't one Vizzy may suggest, or a value that doesn't fit", async () => {
    expect(await suggest({ fld_zzzzzzzzzzzz: 1 })).toMatchObject({ ok: false, status: 400, error: "unknown_field" });
    expect(await suggest({ [OLD]: 1 })).toMatchObject({ ok: false, status: 400, error: "archived_field" });
    expect(await suggest({ [NOTES]: "Call her on Friday" })).toMatchObject({ ok: false, status: 400, error: "field_not_allowed" });
    expect(await suggest({ [PLAN]: "opt_nothere1" })).toMatchObject({ ok: false, status: 400, error: "invalid_value", issues: [PLAN] });
    expect(await suggest({ [SEATS]: 12 })).toMatchObject({ ok: false, status: 409, error: "no_change" });
    expect(await suggest({})).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect(await author({ scope: { personId: "pu_1" }, changes: { [SEATS]: 1 } })).toMatchObject({ ok: false, status: 404, error: "person_not_found" });
    expect(await author({ scope: { personId: PRIYA }, changes: { [SEATS]: 1 } }, { ...admin, tenantId: "ten_B" })).toMatchObject({ ok: false, status: 404 });
  });

  it("suggests a text field an admin let Vizzy read, only while its switch is on", async () => {
    expect(await suggest({ [TITLE]: "Head of Sales" })).toMatchObject({ ok: false, status: 400, error: "field_not_allowed" });
    textFieldsOn();
    const r = await suggest({ [TITLE]: " Head of Sales " });
    if (!r.ok) throw new Error(r.error);
    const action = await getAgentAction(admin, r.id as AgentActionId, { db });
    expect(action).toMatchObject({ proposal: { fields: { [TITLE]: "Head of Sales" } }, basis: { fields: { [TITLE]: null } }, fieldIds: [TITLE] });
    // A text field nobody ticked stays out.
    expect(await suggest({ [NOTES]: "Call her on Friday" })).toMatchObject({ ok: false, status: 400, error: "field_not_allowed" });
  });

  it("refuses text over 500 characters, or holding a mark the scrubber leaves, so a scrubbed value never goes back over the real one", async () => {
    textFieldsOn();
    expect(await suggest({ [TITLE]: "x".repeat(500) })).toMatchObject({ ok: true });
    expect(await suggest({ [TITLE]: "y".repeat(501) })).toMatchObject({ ok: false, status: 400, error: "invalid_value", issues: [TITLE] });
    for (const marked of ["Head of Sales, reports to [name]", "Write to [email]", "Account [ID] owner"]) {
      expect(await suggest({ [TITLE]: marked }), marked).toMatchObject({ ok: false, status: 400, error: "invalid_value", issues: [TITLE] });
    }
  });

  it("lets Vizzy clear a text value it read cut, but never write over it", async () => {
    textFieldsOn();
    // 600 characters: Vizzy read only the first 500.
    db.seed("contacts", PRIYA, { ...db.raw("contacts", PRIYA), fields: { [SEATS]: 12, [TITLE]: "t".repeat(600) } });
    expect(await suggest({ [TITLE]: "Head of Sales" })).toMatchObject({ ok: false, status: 400, error: "invalid_value", issues: [TITLE] });
    expect(await suggest({ [TITLE]: null })).toMatchObject({ ok: true, status: "suggested" });
    // 500 characters as stored, but longer once their name is taken out: Vizzy read it cut too.
    db.seed("contacts", PRIYA, { ...db.raw("contacts", PRIYA), fields: { [SEATS]: 12, [TITLE]: `${"t".repeat(489)} Priya Shah` } });
    expect(await suggest({ [TITLE]: "Head of Sales" })).toMatchObject({ ok: false, status: 400, error: "invalid_value", issues: [TITLE] });
    // Whole as Vizzy read it: a new value is fine.
    db.seed("contacts", PRIYA, { ...db.raw("contacts", PRIYA), fields: { [SEATS]: 12, [TITLE]: "t".repeat(500) } });
    expect(await suggest({ [TITLE]: "Head of Sales" })).toMatchObject({ ok: true, status: "suggested" });
  });

  it("answers too_large for a suggestion too big to save, and leaves the one waiting in place", async () => {
    textFieldsOn();
    // Six text fields Vizzy may read, each holding 2000 characters that take 6 bytes each as JSON.
    const big = ["fld_ccccccccccd1", "fld_ccccccccccd2", "fld_ccccccccccd3", "fld_ccccccccccd4", "fld_ccccccccccd5", "fld_ccccccccccd6"];
    for (const [i, id] of big.entries()) await add(id, { op: "add", label: `Long ${i}`, type: "text", vizzyReads: true });
    db.seed("contacts", PRIYA, { ...db.raw("contacts", PRIYA), fields: { [SEATS]: 12, ...Object.fromEntries(big.map((id) => [id, "\u0001".repeat(2000)])) } });
    // Vizzy read each one cut, so it can only clear them, and clearing all six keeps a basis over the limit.
    const waiting = await suggest({ [big[0]!]: null });
    if (!waiting.ok) throw new Error(waiting.error);
    const r = await suggest(Object.fromEntries(big.map((id) => [id, null])));
    expect(r).toMatchObject({ ok: false, status: 400, error: "too_large" });
    expect((await openFieldSuggestions(admin, PRIYA as `ct_${string}`, db)).map((a) => a.id)).toEqual([waiting.id]);
  });

  it("sets aside a text suggestion once an admin stops Vizzy reading the field, or text fields are off, and never applies it", async () => {
    textFieldsOn();
    const decide = (id: string, rev: number) => decideFieldSuggestion(admin, PRIYA, { id, rev, decision: "confirm" }, { db, nowMs: T0 + 1000 });
    const first = await suggest({ [TITLE]: "Head of Sales" });
    if (!first.ok) throw new Error(first.error);
    await add(TITLE, { op: "vizzy_reads", key: TITLE, on: false });
    expect(await decide(first.id, 1)).toEqual({ ok: false, error: "stale", fieldId: TITLE });
    expect(await getAgentAction(admin, first.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "stale" } });
    expect(db.raw("contacts", PRIYA)?.fields).toEqual({ [SEATS]: 12, [PLAN]: "opt_cccccc01" });

    await add(TITLE, { op: "vizzy_reads", key: TITLE, on: true });
    const second = await suggest({ [TITLE]: "Head of Sales" });
    if (!second.ok) throw new Error(second.error);
    textFieldsOn(false);
    expect(await decide(second.id, 1)).toEqual({ ok: false, error: "stale", fieldId: TITLE });
    expect(db.raw("contacts", PRIYA)?.fields).not.toHaveProperty(TITLE);
    textFieldsOn();

    // Still read and switched on: it is confirmed.
    const third = await suggest({ [TITLE]: "Head of Partnerships" });
    if (!third.ok) throw new Error(third.error);
    expect(await decide(third.id, 1)).toEqual({ ok: true, state: "acted" });
    expect(db.raw("contacts", PRIYA)?.fields).toMatchObject({ [TITLE]: "Head of Partnerships" });
  });

  it("sets aside a text suggestion when Vizzy is stopped reading the field while the confirm is being written", async () => {
    textFieldsOn();
    const r = await suggest({ [TITLE]: "Head of Sales" });
    if (!r.ok) throw new Error(r.error);
    // The untick lands between the confirm's reads and its commit: the write runs again and sees it.
    db.onBeforeCommit = async () => {
      await add(TITLE, { op: "vizzy_reads", key: TITLE, on: false });
    };
    expect(await decideFieldSuggestion(admin, PRIYA, { id: r.id, rev: 1, decision: "confirm" }, { db, nowMs: T0 + 1000 })).toEqual({ ok: false, error: "stale", fieldId: TITLE });
    expect(db.onBeforeCommit).toBeUndefined();
    expect(await getAgentAction(admin, r.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "stale" } });
    expect(db.raw("contacts", PRIYA)?.fields).toEqual({ [SEATS]: 12, [PLAN]: "opt_cccccc01" });
  });

  it("takes their name and address out of the reason", async () => {
    const r = await suggest({ [SEATS]: 20 }, { why: "Priya Shah (priya.shah@example.com) said the team grew to 20." });
    if (!r.ok) throw new Error("not saved");
    const action = await getAgentAction(admin, r.id as AgentActionId, { db });
    expect((action?.proposal as { why: string }).why).toBe("[name] [name] ([email]) said the team grew to 20.");
  });

  it("answers with the one waiting for the same suggestion, replaces one for the same field, and won't raise a decided one again", async () => {
    const first = await suggest({ [SEATS]: 15 });
    const again = await suggest({ [SEATS]: 15 });
    // The one waiting is no new suggestion: made counts once, for the first (decision 20).
    expect(first).toMatchObject({ ok: true, saved: "created" });
    expect(again).toMatchObject({ ok: true, id: first.ok ? first.id : "", saved: "none" });
    if (again.ok) expect(again.summary).toMatch(/already waiting/);

    const newer = await suggest({ [SEATS]: 16 });
    if (!first.ok || !newer.ok) throw new Error("not saved");
    expect(await getAgentAction(admin, first.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
    expect((await openFieldSuggestions(admin, PRIYA as `ct_${string}`, db)).map((a) => a.id)).toEqual([newer.id]);

    await transitionAgentAction(admin, newer.id as AgentActionId, { to: "declined", reason: "dismissed", by, at: new Date(T0 + 1000).toISOString() }, { db });
    expect(await suggest({ [SEATS]: 16 })).toMatchObject({ ok: false, status: 409, error: "already_decided" });
  });

  it("can make a suggestion again that nobody decided: replaced, out of time or out of date", async () => {
    const first = await suggest({ [SEATS]: 15 });
    if (!first.ok) throw new Error("not saved");
    // Replaced by a newer one for the same field, which then runs out of time.
    const newer = await suggest({ [SEATS]: 16 });
    if (!newer.ok) throw new Error("not saved");
    await transitionAgentAction(admin, newer.id as AgentActionId, { to: "declined", reason: "expired", by: { type: "system", id: "agent_action_expiry" }, at: new Date(T0 + 1000).toISOString() }, { db });
    const back = await suggest({ [SEATS]: 15 });
    expect(back).toMatchObject({ ok: true, status: "suggested" });
    if (!back.ok) throw new Error("not saved");
    expect(back.id).not.toBe(first.id);
    // A retry answers with it, and the expired one can come back too.
    expect(await suggest({ [SEATS]: 15 })).toMatchObject({ ok: true, id: back.id });
    const again16 = await suggest({ [SEATS]: 16 });
    expect(again16).toMatchObject({ ok: true, status: "suggested" });
    // Once a person dismisses it, it stays decided.
    if (!again16.ok) throw new Error("not saved");
    await transitionAgentAction(admin, again16.id as AgentActionId, { to: "declined", reason: "dismissed", by, at: new Date(T0 + 2000).toISOString() }, { db });
    expect(await suggest({ [SEATS]: 16 })).toMatchObject({ ok: false, status: 409, error: "already_decided" });
  });

  it("is rate limited", async () => {
    let last: unknown;
    for (let i = 0; i < 12; i++) last = await suggest({ [SEATS]: 100 + i });
    expect(last).toMatchObject({ ok: false, status: 429 });
  });
});

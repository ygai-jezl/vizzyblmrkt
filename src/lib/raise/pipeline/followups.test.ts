import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { blankFieldInAgentActions, eraseHistory, proposeAgentAction } from "@/lib/tenant";
import { getAgentAction, listOpenAgentActions } from "@/lib/ontology/agentActions";
import { setFieldValues } from "@/lib/audience/fields";
import { readFieldList } from "@/lib/audience/fieldList";
import type { TenantContext } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import { readPipeline, type BoardCard } from "./board";
import {
  clearFollowUpsAfterWrite,
  decideFollowUp,
  followUpChange,
  followUpProposal,
  followUpReviewItems,
  openFollowUpPeople,
  personValues,
  proposeFollowUps,
  RAISE_FOLLOWUP_ACTION,
  reconcileFollowUps,
} from "./followups";
import { boardWorld, type BoardWorld } from "./testing/world";

const NOW = new Date("2026-11-26T07:00:00.000Z");
const loadTenant = async () => ({ id: "ten_a", timeZone: "Europe/London" }) as never;
const member = { type: "member", id: "u_admin" } as const;

let db: FakeFirestore;
let w: BoardWorld;
const cards = async (at = NOW): Promise<BoardCard[]> => {
  const r = await readPipeline(w.ctx, { cap: 500 }, { db, loadTenant, now: () => at });
  if (!r.setUp) throw new Error("not set up");
  return r.columns.flatMap((c) => c.cards);
};
const fields = () => ({ stage: w.ids.stage, lastTouch: w.ids.lastTouch, nextStepDate: w.ids.nextStepDate });
const propose = async (at = NOW) => proposeFollowUps(w.ctx, (await cards(at)).filter((c) => c.due.length), { fields: fields(), now: at, openNow: 0, maxOpen: 50, maxNew: 25 }, db);
const open = () => listOpenAgentActions(w.ctx, { action: RAISE_FOLLOWUP_ACTION, limit: 200, now: NOW.toISOString(), db });
const all = () => db.dump("agent_actions").filter((a) => a.action === RAISE_FOLLOWUP_ACTION) as unknown as AgentAction[];

beforeEach(async () => {
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED", "RAISE_FOLLOWUPS_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  w = await boardWorld(db);
});
afterEach(() => vi.unstubAllEnvs());

describe("raising follow-ups", () => {
  it("raises one per person per due reason, keyed by the day it came from", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10", nextStepDate: "2026-11-20" });
    await w.add({ email: "priya@example.test", stage: "contacted", lastTouch: "2026-11-20" });
    await w.add({ email: "lee@example.com", stage: "money_in", lastTouch: "2026-10-01", nextStepDate: "2026-10-01" });
    expect(await propose()).toEqual({ created: 2, open: 2 });
    const rows = all();
    expect(rows.map((a) => a.dedupeKey).sort()).toEqual([`raise_followup.suggest|next_step|${sam}|2026-11-20`, `raise_followup.suggest|quiet|${sam}|2026-11-10`]);
    const quiet = rows.find((a) => a.dedupeKey.includes("|quiet|"))!;
    expect(quiet).toMatchObject({
      agent: "raise_followups",
      target: { type: "person", id: sam },
      proposal: { due: "quiet", rule: "investor_quiet", ruleVersion: 1, quietAfterDays: 14 },
      basis: { fields: { [w.ids.stage]: w.stage("contacted"), [w.ids.lastTouch]: "2026-11-10" } },
      fieldIds: [w.ids.stage, w.ids.lastTouch],
      review: { kind: "raise_followup", href: `/admin/crm/people/${sam}` },
      requestedBy: { type: "system", id: "raise_followups" },
      expiresAt: "2026-12-10T07:00:00.000Z",
      clearDetailsOnClose: true,
    });
  });

  it("gives one follow-up for a past Next step date, however often it runs, the next day too", async () => {
    await w.add({ email: "sam@example.com", stage: "first_meeting", nextStepDate: "2026-11-25" });
    expect((await propose()).created).toBe(1);
    expect((await propose()).created).toBe(0);
    const tomorrow = new Date("2026-11-27T07:00:00.000Z");
    expect((await propose(tomorrow)).created).toBe(0);
    expect(all()).toHaveLength(1);
    // Dismissed: the same date never raises another.
    const [a] = await open();
    await decideFollowUp(w.ctx, a!.id, { op: "dismiss", rev: a!.rev }, { db, loadTenant, now: () => NOW, forget: () => {} });
    expect((await propose(tomorrow)).created).toBe(0);
    expect(all()).toHaveLength(1);
  });

  it("stops at the open and new caps", async () => {
    for (let i = 0; i < 4; i++) await w.add({ email: `p${i}@example.com`, stage: "contacted", lastTouch: "2026-11-01" });
    const due = (await cards()).filter((c) => c.due.length);
    expect((await proposeFollowUps(w.ctx, due, { fields: fields(), now: NOW, openNow: 0, maxOpen: 50, maxNew: 2 }, db)).created).toBe(2);
    expect((await proposeFollowUps(w.ctx, due, { fields: fields(), now: NOW, openNow: 3, maxOpen: 3, maxNew: 25 }, db)).created).toBe(0);
  });
});

describe("clearing follow-ups", () => {
  async function both() {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10", nextStepDate: "2026-11-20" });
    await propose();
    return sam;
  }

  it("marks the quiet ones acted when Last touch changes, by whoever changed it", async () => {
    const sam = await both();
    const r = await clearFollowUpsAfterWrite(w.ctx, sam, [w.ids.lastTouch], member, { db, now: NOW });
    expect(r).toEqual({ acted: 1, cleared: 0 });
    const left = await open();
    expect(left.map((a) => a.proposal?.due)).toEqual(["next_step"]);
    const acted = all().find((a) => a.dedupeKey.includes("|quiet|"))!;
    expect(acted).toMatchObject({ state: "acted", actedBy: member, proposal: null, basis: null });
  });

  it("sets every open one aside as stale when Stage changes", async () => {
    const sam = await both();
    expect(await clearFollowUpsAfterWrite(w.ctx, sam, [w.ids.stage, w.ids.lastTouch], member, { db, now: NOW })).toEqual({ acted: 0, cleared: 2 });
    expect(await open()).toEqual([]);
    expect(all().map((a) => a.declined?.reason)).toEqual(["stale", "stale"]);
  });

  it("reads nothing with follow-ups off, or for a change to another field", async () => {
    const sam = await both();
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "false");
    const before = db.collectionCalls("agent_actions");
    expect(await clearFollowUpsAfterWrite(w.ctx, sam, [w.ids.stage], member, { db })).toEqual({ acted: 0, cleared: 0 });
    expect(db.collectionCalls("agent_actions")).toBe(before);
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    expect(await clearFollowUpsAfterWrite(w.ctx, sam, [w.ids.firm], member, { db })).toEqual({ acted: 0, cleared: 0 });
    expect(await open()).toHaveLength(2);
  });

  it("puts open ones in step with their people, and lets one go after 14 days", async () => {
    const sam = await both();
    const priya = await w.add({ email: "priya@example.test", stage: "contacted", lastTouch: "2026-11-01" });
    const lee = await w.add({ email: "lee@example.com", stage: "replied", nextStepDate: "2026-11-01" });
    await propose();
    // Another writer: a new Last touch for Sam, a new Stage for Priya; Lee unchanged.
    await setFieldValues(w.ctx, { object: "person", recordId: sam, changes: { [w.ids.lastTouch]: "2026-11-25" }, by: member, source: "editor" }, { db });
    await setFieldValues(w.ctx, { object: "person", recordId: priya, changes: { [w.ids.stage]: w.stage("passed") }, by: member, source: "editor" }, { db });
    const r = await reconcileFollowUps(w.ctx, { now: NOW, valuesOf: (id) => personValues(w.ctx, id, db) }, db);
    expect(r).toMatchObject({ acted: 1, cleared: 1, expired: 0, open: 2 });
    expect([...r.openPeople].sort()).toEqual([lee, sam].sort());
    const later = new Date("2026-12-11T07:00:00.000Z");
    const gone = await reconcileFollowUps(w.ctx, { now: later, valuesOf: (id) => personValues(w.ctx, id, db) }, db);
    expect(gone).toMatchObject({ expired: 2, open: 0 });
  });

  it("says what became of one from its person's values", () => {
    const a = followUpProposal({ personId: "ct_1", due: "quiet", day: "2026-11-10", stageOptionId: "opt_aaaaaaaa", stageField: "fld_stage0000001", dateField: "fld_touch0000001", at: NOW.toISOString() });
    const parts = { proposal: a.proposal, basis: a.basis, signals: a.signals } as Pick<AgentAction, "proposal" | "basis" | "signals">;
    expect(followUpChange(parts, (id) => ({ fld_stage0000001: "opt_aaaaaaaa", fld_touch0000001: "2026-11-10" })[id])).toBeNull();
    expect(followUpChange(parts, (id) => ({ fld_stage0000001: "opt_aaaaaaaa", fld_touch0000001: "2026-11-25" })[id])).toBe("acted");
    expect(followUpChange(parts, (id) => ({ fld_stage0000001: "opt_bbbbbbbb", fld_touch0000001: "2026-11-25" })[id])).toBe("stale");
  });
});

describe("follow-ups in Review", () => {
  it("say the stage's name and a day count, never who", async () => {
    await w.add({ email: "sam.okafor@example.com", first: "Sam", last: "Okafor", stage: "contacted", firm: "Fern Capital", lastTouch: "2026-11-10", nextStepDate: "2026-11-20" });
    await propose();
    const items = await followUpReviewItems(w.ctx, db, { loadTenant, now: () => NOW });
    expect(items.map((i) => [i.kind, i.title, i.detail, i.action, i.followUp?.quiet])).toEqual(
      expect.arrayContaining([
        ["raise_followup", "Quiet for 16 days", "In Contacted. Open their page to follow up.", "Open", true],
        ["raise_followup", "Next step date passed", "In Contacted. Open their page to set the next step.", "Open", false],
      ]),
    );
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toMatch(/Sam|Okafor|example\.com|Fern|2026-11-10|2026-11-20/);
  });

  it("read Quiet for a while once the day it came from was erased", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    const r = await blankFieldInAgentActions(w.ctx, w.ids.lastTouch, { nowIso: NOW.toISOString(), db });
    expect(r.blanked).toBe(1);
    const [a] = all();
    expect((a!.basis!.fields as Record<string, unknown>)[w.ids.lastTouch]).toBeNull();
    const items = await followUpReviewItems(w.ctx, db, { loadTenant, now: () => NOW });
    expect(items.map((i) => i.title)).toEqual(["Quiet for a while"]);
  });

  it("go with the person's erase", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    expect(all()).toHaveLength(1);
    const erased = await eraseHistory(w.ctx, { personId: sam }, { db });
    expect(erased.agentActions).toBe(1);
    expect(all()).toHaveLength(0);
  });

  it("show on the board as Follow up chips", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    expect([...(await openFollowUpPeople(w.ctx, db))]).toEqual([sam]);
  });
});

describe("decideFollowUp", () => {
  const decide = (id: string, body: unknown, ctx: TenantContext = w.ctx) => decideFollowUp(ctx, id, body, { db, loadTenant, now: () => NOW, forget: () => {} });

  it("I followed up today sets Last touch to today and closes it in one transaction", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    const [a] = await open();
    const before = db.dump("ontology_events").length;
    expect(await decide(a!.id, { op: "followed_up", rev: a!.rev })).toEqual({ status: 200, body: { ok: true } });
    expect((db.raw("contacts", sam)!.fields as Record<string, unknown>)[w.ids.lastTouch]).toBe("2026-11-26");
    expect(await getAgentAction(w.ctx, a!.id, { db })).toMatchObject({ state: "acted", actedBy: member });
    const fresh = db.dump("ontology_events").slice(before);
    // The value's change and the decision's two steps, all naming the follow-up.
    expect(fresh.map((e) => e.kind).sort()).toEqual(["agent.acted", "agent.approved", "record.field_changed"]);
    expect(fresh.every((e) => e.agentActionId === a!.id)).toBe(true);
    expect(await decide(a!.id, { op: "followed_up", rev: a!.rev })).toEqual({ status: 409, body: { error: "stale" } });
  });

  it("answers stale when Last touch moved since, and writes nothing", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    const [a] = await open();
    db.seed("contacts", sam, { ...db.raw("contacts", sam)!, fields: { ...(db.raw("contacts", sam)!.fields as object), [w.ids.lastTouch]: "2026-11-24" } });
    expect(await decide(a!.id, { op: "followed_up", rev: a!.rev })).toEqual({ status: 409, body: { error: "stale" } });
    expect((await getAgentAction(w.ctx, a!.id, { db }))!.state).toBe("proposed");
  });

  it("dismisses one, and only a quiet one can be followed up", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", nextStepDate: "2026-11-20" });
    await propose();
    const [a] = await open();
    expect((await decide(a!.id, { op: "followed_up", rev: a!.rev })).status).toBe(400);
    expect((await decide(a!.id, { op: "dismiss", rev: a!.rev + 1 })).status).toBe(409);
    expect(await decide(a!.id, { op: "dismiss", rev: a!.rev })).toEqual({ status: 200, body: { ok: true } });
    expect(await getAgentAction(w.ctx, a!.id, { db })).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, decidedBy: member });
  });

  it("finds nothing for a bad id, another kind of action or another brand's follow-up", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-10" });
    await propose();
    const [a] = await open();
    expect((await decide("aa_nope", { op: "dismiss", rev: 1 })).status).toBe(404);
    expect((await decide(a!.id, { op: "dismiss", rev: a!.rev }, { ...w.ctx, tenantId: "ten_b" })).status).toBe(404);
    expect((await decide(a!.id, { op: "snooze", rev: a!.rev })).status).toBe(400);
    const list = await readFieldList(w.ctx, "person", db);
    const other = await proposeAgentAction(
      w.ctx,
      { ...followUpProposal({ personId: a!.personId!, due: "quiet", day: "2026-01-01", stageOptionId: w.stage("contacted"), stageField: w.ids.stage, dateField: w.ids.lastTouch, at: NOW.toISOString() }), dedupeKey: "person_fields.suggest|x", action: "person_fields.suggest", agent: "vizzy" },
      { db },
    );
    expect(list.items.length).toBe(10);
    expect((await decide(other.action.id, { op: "dismiss", rev: 1 })).status).toBe(404);
  });
});

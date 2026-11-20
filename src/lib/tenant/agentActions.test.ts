import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { readsFirst } from "./testing/readsFirst";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";
import {
  blankFieldInAgentActions,
  clearAgentActionDetails,
  countFieldAgentActions,
  expireAgentActions,
  planAgentTransition,
  proposeAgentAction,
  readAgentActionTx,
  stageAgentTransition,
  transitionAgentAction,
  type AgentProposal,
} from "./agentActions";
import { regionalStoreFor, repointHistoryPage, writeRecordWithEvents } from "./ontologyEvents";
import { deterministicAgentActionId, deterministicContactId, deterministicEventId } from "@/lib/crm/identifiers";
import { fieldChangedEvent } from "@/lib/ontology/eventBuilders";
import type { ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_other", region: "us", source: "system" };
const ADA = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const AT = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-21T10:00:00.000Z";
const MEMBER = { type: "member" as const, id: "uid_1" };

function proposal(over: Partial<AgentProposal> = {}): AgentProposal {
  return {
    dedupeKey: agentDedupeKey("person_fields.suggest", ADA, "plan", "a1b2"),
    agent: "vizzy",
    action: "person_fields.suggest",
    target: { type: "person", id: ADA },
    personId: ADA,
    proposal: { fields: { plan: "pro" } },
    basis: { fields: { plan: "free" } },
    fieldIds: ["plan"],
    signals: [{ kind: "field_value", ref: "plan" }],
    review: { kind: "agent_draft", href: "/admin/crm/people/x" },
    requestedBy: MEMBER,
    expiresAt: "2026-12-20T10:00:00.000Z",
    at: AT,
    ...over,
  };
}

function world() {
  const fake = new FakeFirestore();
  return { fake, db: readsFirst(fake) };
}

const trail = (fake: FakeFirestore, id: string) =>
  fake
    .dump("ontology_events")
    .filter((r) => r.agentActionId === id)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

async function proposed(over: Partial<AgentProposal> = {}) {
  const w = world();
  const { action } = await proposeAgentAction(ctx, proposal(over), { db: w.db });
  return { ...w, id: action.id };
}

describe("proposeAgentAction", () => {
  it("creates the record at rev 1 and exactly one agent.proposed row", async () => {
    const { fake, db } = world();
    const out = await proposeAgentAction(ctx, proposal({ productUserId: null }), { db });
    expect(out.outcome).toBe("created");
    expect(out.action.id).toBe(deterministicAgentActionId("ten_demo", proposal().dedupeKey));
    expect(fake.raw("agent_actions", out.action.id)).toMatchObject({ tenantId: "ten_demo", state: "proposed", rev: 1, mode: "suggest", targetKey: `person:${ADA}`, clearDetailsOnClose: false });
    const rows = trail(fake, out.action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `agent|${out.action.id}|1`,
      kind: "agent.proposed",
      personId: ADA,
      productUserId: null,
      agentActionId: out.action.id,
      subject: { type: "agent_action", id: out.action.id },
      actor: { type: "agent", id: "vizzy" },
      properties: { state: "proposed", agent: "vizzy", action: "person_fields.suggest" },
    });
  });

  it("answers open for the same key, and decided once it was declined or undone, writing nothing", async () => {
    const { fake, db, id } = await proposed();
    expect((await proposeAgentAction(ctx, proposal(), { db })).outcome).toBe("open");
    expect(trail(fake, id)).toHaveLength(1);
    await transitionAgentAction(ctx, id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db });
    const again = await proposeAgentAction(ctx, proposal(), { db });
    expect(again.outcome).toBe("decided");
    expect(again.action.state).toBe("declined");
    expect(trail(fake, id)).toHaveLength(2);

    const undone = await proposed();
    await transitionAgentAction(ctx, undone.id, { to: "acted", by: MEMBER, at: LATER }, { db: undone.db });
    await transitionAgentAction(ctx, undone.id, { to: "undone", by: MEMBER, at: "2026-11-22T10:00:00.000Z" }, { db: undone.db });
    expect((await proposeAgentAction(ctx, proposal(), { db: undone.db })).outcome).toBe("decided");
    expect(trail(undone.fake, undone.id)).toHaveLength(4);
  });

  it("throws for an id another brand holds", async () => {
    const { fake, db } = world();
    const id = deterministicAgentActionId("ten_demo", proposal().dedupeKey);
    fake.seed("agent_actions", id, { tenantId: "ten_other", state: "proposed" });
    await expect(proposeAgentAction(ctx, proposal(), { db })).rejects.toThrow(TenantIsolationError);
    expect(fake.raw("agent_actions", id)).toEqual({ tenantId: "ten_other", state: "proposed" });
  });

  it("refuses a bad proposal before it writes", async () => {
    const { fake, db } = world();
    for (const bad of [
      proposal({ expiresAt: "2027-03-20T10:00:00.000Z" }),
      proposal({ expiresAt: AT }),
      proposal({ productUserId: "pu_1" }),
      proposal({ target: { type: "brand_map_question" as never, id: "q1" } }),
      proposal({ signals: [{ kind: "metric", ref: "people asked about pricing" }] }),
      proposal({ dedupeKey: "person_fields.suggest|ada@example.com" }),
    ]) {
      await expect(proposeAgentAction(ctx, bad, { db })).rejects.toThrow(TenantValidationError);
    }
    expect(fake.dump("agent_actions")).toEqual([]);
    expect(fake.dump("ontology_events")).toEqual([]);
  });
});

describe("transitionAgentAction", () => {
  it("appends one row per step and bumps rev; proposed to acted is approved then acted 1 ms later", async () => {
    const { fake, db, id } = await proposed();
    const acted = await transitionAgentAction(ctx, id, { to: "acted", by: MEMBER, at: LATER, result: { fields: { plan: "pro" } }, undo: { before: { plan: "free" } } }, { db });
    expect(acted.ok).toBe(true);
    expect(fake.raw("agent_actions", id)).toMatchObject({
      state: "acted",
      rev: 3,
      decidedBy: MEMBER,
      decidedAt: LATER,
      actedBy: MEMBER,
      actedAt: "2026-11-21T10:00:00.001Z",
      undo: { before: { plan: "free" } },
    });
    expect(trail(fake, id).map((r) => [r.kind, r.at])).toEqual([
      ["agent.proposed", AT],
      ["agent.approved", LATER],
      ["agent.acted", "2026-11-21T10:00:00.001Z"],
    ]);
    await transitionAgentAction(ctx, id, { to: "undone", by: MEMBER, at: "2026-11-22T10:00:00.000Z" }, { db });
    expect(fake.raw("agent_actions", id)).toMatchObject({ state: "undone", rev: 4, undoneBy: MEMBER });
    expect(trail(fake, id).map((r) => r.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted", "agent.undone"]);
  });

  it("approves, then acts, one row each", async () => {
    const { fake, db, id } = await proposed();
    expect(await transitionAgentAction(ctx, id, { to: "approved", by: MEMBER, at: LATER }, { db })).toMatchObject({ ok: true, action: { state: "approved", rev: 2 } });
    expect(await transitionAgentAction(ctx, id, { to: "acted", by: MEMBER, at: "2026-11-22T10:00:00.000Z" }, { db })).toMatchObject({ ok: true, action: { state: "acted", rev: 3 } });
    expect(trail(fake, id).map((r) => r.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted"]);
  });

  it("refuses a move the state doesn't allow, a stale rev or an unknown id, writing nothing", async () => {
    const { fake, db, id } = await proposed();
    const before = fake.writeCountFor("agent_actions", id);
    expect(await transitionAgentAction(ctx, id, { to: "undone", by: MEMBER, at: LATER }, { db })).toEqual({ ok: false, error: "wrong_state", state: "proposed" });
    expect(await transitionAgentAction(ctx, id, { to: "approved", by: MEMBER, at: LATER, expectRev: 2 }, { db })).toEqual({ ok: false, error: "changed", state: "proposed" });
    const unknown = deterministicAgentActionId("ten_demo", "nothing.here");
    expect(await transitionAgentAction(ctx, unknown, { to: "approved", by: MEMBER, at: LATER }, { db })).toEqual({ ok: false, error: "not_found" });
    expect(fake.writeCountFor("agent_actions", id)).toBe(before);
    expect(trail(fake, id)).toHaveLength(1);
    await transitionAgentAction(ctx, id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db });
    expect(await transitionAgentAction(ctx, id, { to: "acted", by: MEMBER, at: LATER }, { db })).toEqual({ ok: false, error: "wrong_state", state: "declined" });
  });

  it("throws for a decline with no reason", async () => {
    const { db, id } = await proposed();
    await expect(transitionAgentAction(ctx, id, { to: "declined", by: MEMBER, at: LATER }, { db })).rejects.toThrow(TenantValidationError);
  });

  it("keeps one decision when an approve and a decline race", async () => {
    const { fake, db, id } = await proposed();
    let declined: unknown;
    fake.onBeforeCommit = async () => {
      declined = await transitionAgentAction(ctx, id, { to: "declined", reason: "dismissed", by: { type: "member", id: "uid_2" }, at: LATER }, { db: fake });
    };
    const approved = await transitionAgentAction(ctx, id, { to: "approved", by: MEMBER, at: LATER }, { db });
    expect(declined).toMatchObject({ ok: true });
    expect(approved).toEqual({ ok: false, error: "wrong_state", state: "declined" });
    expect(trail(fake, id).map((r) => r.kind)).toEqual(["agent.proposed", "agent.declined"]);
  });

  it("clears proposal and basis with an acted or declined end when the record asks, never on approve", async () => {
    const a = await proposed({ clearDetailsOnClose: true });
    await transitionAgentAction(ctx, a.id, { to: "approved", by: MEMBER, at: LATER }, { db: a.db });
    expect(a.fake.raw("agent_actions", a.id)).toMatchObject({ proposal: { fields: { plan: "pro" } }, detailsClearedAt: null });
    await transitionAgentAction(ctx, a.id, { to: "acted", by: MEMBER, at: "2026-11-22T10:00:00.000Z" }, { db: a.db });
    expect(a.fake.raw("agent_actions", a.id)).toMatchObject({ proposal: null, basis: null, detailsClearedAt: "2026-11-22T10:00:00.000Z" });

    const d = await proposed({ clearDetailsOnClose: true });
    await transitionAgentAction(ctx, d.id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db: d.db });
    expect(d.fake.raw("agent_actions", d.id)).toMatchObject({ proposal: null, basis: null, detailsClearedAt: LATER });

    const asked = await proposed();
    await transitionAgentAction(ctx, asked.id, { to: "declined", reason: "stale", by: MEMBER, at: LATER, clearDetails: true }, { db: asked.db });
    expect(asked.fake.raw("agent_actions", asked.id)).toMatchObject({ proposal: null, basis: null, detailsClearedAt: LATER, declined: { reason: "stale" } });

    const kept = await proposed();
    await transitionAgentAction(ctx, kept.id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db: kept.db });
    expect(kept.fake.raw("agent_actions", kept.id)).toMatchObject({ proposal: { fields: { plan: "pro" } }, detailsClearedAt: null });
  });
});

describe("the transaction helpers inside a caller's transaction", () => {
  it("commit a contact and the decision together, and neither when the state is wrong", async () => {
    const { fake, db, id } = await proposed();
    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com" });
    const store = regionalStoreFor(ctx, db);
    const run = () =>
      store.runTransaction(async (txn) => {
        const plan = planAgentTransition(await readAgentActionTx(txn, store, ctx, id), { to: "acted", by: MEMBER, at: LATER });
        if (!plan.ok) return plan.error;
        txn.update(store.collection("contacts").doc(ADA), { plan: "pro" });
        stageAgentTransition(txn, store, ctx, plan);
        return "ok";
      });
    expect(await run()).toBe("ok");
    expect(fake.raw("contacts", ADA)).toMatchObject({ plan: "pro" });
    expect(fake.raw("agent_actions", id)).toMatchObject({ state: "acted", rev: 3 });
    const contactWrites = fake.writeCountFor("contacts", ADA);
    expect(await run()).toBe("wrong_state");
    expect(fake.writeCountFor("contacts", ADA)).toBe(contactWrites);
    expect(trail(fake, id)).toHaveLength(3);
  });

  it("writeRecordWithEvents commits the record, its events and the action's move together", async () => {
    const { fake, db, id } = await proposed({ clearDetailsOnClose: true });
    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com" });
    const change = fieldChangedEvent({ subject: { type: "person", id: ADA }, personId: ADA, fieldId: "plan", object: "person", before: "free", after: "pro", source: "agent", actor: MEMBER, at: LATER, agentActionId: id, nonce: () => "n1" });
    let seen: AgentAction | null = null;
    const out = await writeRecordWithEvents(
      ctx,
      "contacts",
      ADA,
      (_cur, action) => {
        seen = action;
        return { patch: { firstName: "Ada" }, events: [change] };
      },
      { db, nowIso: LATER, agentAction: { id, transition: { to: "acted", by: MEMBER, at: LATER, undo: { before: { plan: "free" } } } } },
    );
    expect(seen).toMatchObject({ id, state: "proposed" });
    expect(out).toMatchObject({ outcome: "updated", agentAction: { state: "acted", proposal: null } });
    expect(fake.raw("contacts", ADA)).toMatchObject({ firstName: "Ada" });
    expect(fake.raw("ontology_events", deterministicEventId("ten_demo", change.key))).toMatchObject({ kind: "record.field_changed", agentActionId: id });
    expect(trail(fake, id).map((r) => r.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted", "record.field_changed"]);
    expect(fake.raw("agent_actions", id)).toMatchObject({ state: "acted", proposal: null, basis: null });

    const again = await writeRecordWithEvents(ctx, "contacts", ADA, () => ({ patch: { firstName: "X" }, events: [] }), { db, agentAction: { id, transition: { to: "acted", by: MEMBER, at: LATER } } });
    expect(again).toEqual({ outcome: "rejected", reason: "agent_action_wrong_state" });
    expect(fake.raw("contacts", ADA)).toMatchObject({ firstName: "Ada" });
    const missing = deterministicAgentActionId("ten_demo", "nothing.here");
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => ({ patch: { firstName: "X" }, events: [] }), { db, agentAction: { id: missing, transition: { to: "acted", by: MEMBER, at: LATER } } })).toEqual({
      outcome: "rejected",
      reason: "agent_action_not_found",
    });
  });

  it("writeRecordWithEvents records the decision when the plan has nothing to change, and rejects it with no record", async () => {
    const { fake, db, id } = await proposed();
    const decide = { id, transition: { to: "acted" as const, by: MEMBER, at: LATER } };
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => null, { db, agentAction: decide })).toEqual({ outcome: "rejected", reason: "not_found" });
    expect(fake.raw("agent_actions", id)).toMatchObject({ state: "proposed" });

    fake.seed("contacts", ADA, { tenantId: "ten_demo", email: "ada@example.com", plan: "pro" });
    const writes = fake.writeCountFor("contacts", ADA);
    // The suggested value is already in place: the plan changes nothing, and the decision still counts.
    const out = await writeRecordWithEvents(ctx, "contacts", ADA, () => null, { db, agentAction: decide });
    expect(out).toMatchObject({ outcome: "updated", doc: { plan: "pro" }, events: [{ kind: "agent.approved" }, { kind: "agent.acted" }], agentAction: { state: "acted" } });
    expect(fake.raw("agent_actions", id)).toMatchObject({ state: "acted" });
    expect(fake.writeCountFor("contacts", ADA)).toBe(writes);
    // Without an action, a null plan is still unchanged.
    expect(await writeRecordWithEvents(ctx, "contacts", ADA, () => null, { db })).toMatchObject({ outcome: "unchanged" });
  });
});

describe("expireAgentActions", () => {
  it("declines only proposed actions past their expiry, from any agent, in this brand", async () => {
    const { fake, db } = world();
    const make = (key: string, over: Partial<AgentProposal> = {}, c: TenantContext = ctx) =>
      proposeAgentAction(c, proposal({ dedupeKey: agentDedupeKey("person_fields.suggest", key), expiresAt: "2026-11-25T10:00:00.000Z", ...over }), { db }).then((r) => r.action.id);
    const due = await make("due");
    const dueOther = await make("due_autopilot", { agent: "autopilot", clearDetailsOnClose: true });
    const notYet = await make("later", { expiresAt: "2026-12-30T10:00:00.000Z" });
    const approved = await make("approved");
    await transitionAgentAction(ctx, approved, { to: "approved", by: MEMBER, at: LATER }, { db });
    const theirs = await make("theirs", { target: { type: "company", id: "co_1" }, personId: null, signals: [], fieldIds: [] }, other);

    const out = await expireAgentActions(ctx, { now: "2026-11-26T00:00:00.000Z", db });
    expect(out).toEqual({ declined: 2, changed: 0, more: false });
    expect(fake.raw("agent_actions", due)).toMatchObject({ state: "declined", declined: { reason: "expired" }, decidedBy: { type: "system", id: "agent_action_expiry" } });
    expect(fake.raw("agent_actions", dueOther)).toMatchObject({ state: "declined", proposal: null, basis: null });
    expect(fake.raw("agent_actions", notYet)).toMatchObject({ state: "proposed" });
    expect(fake.raw("agent_actions", approved)).toMatchObject({ state: "approved" });
    expect(fake.raw("agent_actions", theirs)).toMatchObject({ state: "proposed" });
    expect(trail(fake, due).map((r) => r.kind)).toEqual(["agent.proposed", "agent.declined"]);
  });

  it("honours the limit, says there may be more, and counts a row that moved meanwhile", async () => {
    const { fake, db } = world();
    const ids: AgentActionId[] = [];
    for (const k of ["a", "b", "c"]) {
      ids.push((await proposeAgentAction(ctx, proposal({ dedupeKey: agentDedupeKey("person_fields.suggest", k), expiresAt: "2026-11-25T10:00:00.000Z" }), { db })).action.id);
    }
    const first = await expireAgentActions(ctx, { now: "2026-11-26T00:00:00.000Z", limit: 2, db });
    expect(first).toEqual({ declined: 2, changed: 0, more: true });
    const left = ids.find((id) => fake.raw("agent_actions", id)?.state === "proposed")!;
    // Someone approves the last one between the sweep's read and its decline.
    let hooked = false;
    const racing: FirestoreLike = {
      collection: (n) => fake.collection(n),
      runTransaction: (fn) => {
        if (!hooked) {
          hooked = true;
          fake.onBeforeCommit = async () => {
            await transitionAgentAction(ctx, left, { to: "approved", by: MEMBER, at: LATER }, { db: fake });
          };
        }
        return db.runTransaction(fn);
      },
    };
    expect(await expireAgentActions(ctx, { now: "2026-11-26T00:00:00.000Z", db: racing })).toEqual({ declined: 0, changed: 1, more: false });
    expect(fake.raw("agent_actions", left)).toMatchObject({ state: "approved" });
  });
});

describe("clearAgentActionDetails", () => {
  it("nulls proposal and basis, keeps state and rev, and writes no row", async () => {
    const { fake, db, id } = await proposed();
    expect(await clearAgentActionDetails(ctx, id, { at: LATER, db })).toBe(true);
    expect(fake.raw("agent_actions", id)).toMatchObject({ proposal: null, basis: null, detailsClearedAt: LATER, state: "proposed", rev: 1 });
    expect(trail(fake, id)).toHaveLength(1);
    expect(await clearAgentActionDetails(ctx, deterministicAgentActionId("ten_demo", "none"), { at: LATER, db })).toBe(false);
  });
});

describe("blankFieldInAgentActions", () => {
  it("nulls only that field where it is held, moves it to blankedFieldIds, and resumes cleanly", async () => {
    const { fake, db } = world();
    const { action } = await proposeAgentAction(
      ctx,
      proposal({ proposal: { fields: { plan: "pro", tier: "gold" } }, basis: { fields: { plan: "free" }, note: "kept" }, fieldIds: ["plan", "tier"] }),
      { db },
    );
    await transitionAgentAction(ctx, action.id, { to: "acted", by: MEMBER, at: LATER, result: { fields: { plan: "pro" } }, undo: { before: { plan: "free", tier: null } } }, { db });
    const otherBrand = await proposeAgentAction(other, proposal({ personId: deterministicContactId("ten_other", "ada@example.com") as ContactPersonId, target: { type: "person", id: deterministicContactId("ten_other", "ada@example.com") } }), { db });
    expect(await countFieldAgentActions(ctx, "plan", { db })).toBe(1);

    const dry = await blankFieldInAgentActions(ctx, "plan", { db, nowIso: LATER, dryRun: true });
    expect(dry).toMatchObject({ scanned: 1, blanked: 1 });
    expect(await countFieldAgentActions(ctx, "plan", { db })).toBe(1);

    expect(await blankFieldInAgentActions(ctx, "plan", { db, nowIso: LATER })).toMatchObject({ scanned: 1, blanked: 1, already: 0, gone: 0 });
    expect(fake.raw("agent_actions", action.id)).toMatchObject({
      proposal: { fields: { plan: null, tier: "gold" } },
      basis: { fields: { plan: null }, note: "kept" },
      result: { fields: { plan: null } },
      undo: { before: { plan: null, tier: null } },
      fieldIds: ["tier"],
      blankedFieldIds: ["plan"],
    });
    expect(await countFieldAgentActions(ctx, "plan", { db })).toBe(0);
    expect(await blankFieldInAgentActions(ctx, "plan", { db, nowIso: LATER })).toMatchObject({ scanned: 0, blanked: 0 });
    expect(fake.raw("agent_actions", otherBrand.action.id)).toMatchObject({ proposal: { fields: { plan: "pro" } }, fieldIds: ["plan"] });
    await expect(blankFieldInAgentActions(ctx, "sys.stage.x", { db, nowIso: LATER })).rejects.toThrow(TenantValidationError);
  });
});

describe("repointHistoryPage on agent actions", () => {
  it("moves a person's actions and their rows to the target, with a person target, and nobody else's", async () => {
    const OLD = deterministicContactId("ten_demo", "pu:pu_1") as ContactPersonId;
    const NEW = deterministicContactId("ten_demo", "ada@new.example.com") as ContactPersonId;
    const { fake, db } = world();
    const personal = (await proposeAgentAction(ctx, proposal({ dedupeKey: agentDedupeKey("person_fields.suggest", "old"), target: { type: "person", id: OLD }, personId: OLD }), { db })).action.id;
    const about = await proposeAgentAction(
      ctx,
      proposal({ dedupeKey: agentDedupeKey("company_fields.suggest", "co_1"), action: "company_fields.suggest", target: { type: "company", id: "co_1" }, personId: OLD, productUserId: "pu_1" }),
      { db },
    );
    const someoneElse = (await proposeAgentAction(ctx, proposal({ dedupeKey: agentDedupeKey("person_fields.suggest", "ada") }), { db })).action.id;

    expect(await repointHistoryPage(ctx, { store: "agentActions", by: { personId: OLD }, target: NEW }, { db })).toMatchObject({ scanned: 2, moved: 2 });
    expect(await repointHistoryPage(ctx, { store: "ontologyEvents", by: { personId: OLD }, target: NEW }, { db })).toMatchObject({ moved: 2 });
    expect(fake.raw("agent_actions", personal)).toMatchObject({ personId: NEW, target: { type: "person", id: NEW }, targetKey: `person:${NEW}` });
    expect(fake.raw("agent_actions", about.action.id)).toMatchObject({ personId: NEW, target: { type: "company", id: "co_1" }, targetKey: "company:co_1" });
    expect(fake.raw("agent_actions", someoneElse)).toMatchObject({ personId: ADA });
    expect(trail(fake, personal)[0]).toMatchObject({ personId: NEW, subject: { type: "agent_action", id: personal } });
    // The moved action still reads, and still moves on.
    expect(await transitionAgentAction(ctx, personal, { to: "approved", by: MEMBER, at: LATER }, { db })).toMatchObject({ ok: true, action: { personId: NEW } });
  });
});

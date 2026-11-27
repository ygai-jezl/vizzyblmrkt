import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeAgentAction, transitionAgentAction, type AgentProposal } from "@/lib/tenant/agentActions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { readsFirst } from "@/lib/tenant/testing/readsFirst";
import type { TenantContext } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import type { ContactPersonId } from "@/lib/ontology/person";
import { agentDedupeKey, type AgentAction } from "@/lib/types/agentAction";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { loopWeekOf } from "./count";
import { agentDecisionSignals, lineDecisionSignal } from "./decisions";
import { sumWeek } from "./testing/sumWeek";

/** What a decision on a made thing counts (src/lib/loops/decisions.ts, learning loops step 5, 4.4). */

const lumen: TenantContext = { tenantId: "ten_lumen", region: "us", source: "system" };
const MAYA = deterministicContactId("ten_lumen", "maya@example.com") as ContactPersonId;
const AT = "2026-11-20T10:00:00.000Z";
const LATER = "2026-11-21T10:00:00.000Z";
const MEMBER = { type: "member" as const, id: "uid_priya" };
const stamp: LoopStamp = {
  made: "m1.canvas.person_fields.0.n",
  kind: "canvas.person_fields",
  scope: "canvas.person_fields",
  v: 0,
  arm: "none",
  items: [],
  prompt: null,
  tokens: { rules: 0, examples: 0 },
  by: "vizzy",
  at: AT,
};

const action = (over: Partial<AgentAction>): AgentAction =>
  ({ state: "proposed", proposal: { fields: { plan: "pro" } }, result: null, declined: null, made: stamp, ...over }) as AgentAction;

describe("a decision on an agent action", () => {
  it("counts acted as kept, or edited when the values acted on differ from the ones proposed", () => {
    expect(agentDecisionSignals(action({}), action({ state: "acted", result: { fields: { plan: "pro" } } }))).toEqual({ kept: 1 });
    expect(agentDecisionSignals(action({}), action({ state: "acted", result: { fields: { plan: "team" } } }))).toEqual({ edited: 1 });
    // Keys in another order hold the same values.
    const two = action({ proposal: { fields: { plan: "pro", seats: 3 } } });
    expect(agentDecisionSignals(two, action({ state: "acted", result: { fields: { seats: 3, plan: "pro" } } }))).toEqual({ kept: 1 });
    // A result that holds other data, such as a new person's id, can't say: kept.
    expect(agentDecisionSignals(action({ proposal: { name: "Sam" } }), action({ state: "acted", result: { personId: MAYA } }))).toEqual({ kept: 1 });
  });

  it("counts a recorded draft kept after a person's edits as edited, from the agent record's result (ADR-0026)", () => {
    const draft = action({ proposal: { label: "Welcome", fingerprint: "0123456789abcdef" } });
    expect(agentDecisionSignals(draft, action({ state: "acted", result: { label: "Welcome", edited: true } }))).toEqual({ edited: 1 });
    expect(agentDecisionSignals(draft, action({ state: "acted", result: { label: "Welcome", edited: false } }))).toEqual({ kept: 1 });
    // Closed by the catch-up, which can't tell: kept.
    expect(agentDecisionSignals(draft, action({ state: "acted", result: { label: "Welcome" } }))).toEqual({ kept: 1 });
    // Superseded, stale and expired are the system's: nothing.
    for (const reason of ["superseded", "stale", "expired"] as const) {
      expect(agentDecisionSignals(draft, action({ state: "declined", declined: { reason } }))).toBeNull();
    }
  });

  it("counts undone, and a person's dismissal with the why they gave", () => {
    expect(agentDecisionSignals(action({ state: "acted" }), action({ state: "undone" }))).toEqual({ undone: 1 });
    expect(agentDecisionSignals(action({}), action({ state: "declined", declined: { reason: "dismissed" } }))).toEqual({ declined: 1 });
    // Work's declined.why, read as given.
    const why = { reason: "dismissed", why: "not_for_us" } as AgentAction["declined"];
    expect(agentDecisionSignals(action({}), action({ state: "declined", declined: why }))).toEqual({ declined: 1, "declined.not_for_us": 1 });
  });

  it("counts nothing for expiry, staleness, being superseded, approval alone or no move", () => {
    for (const reason of ["expired", "stale", "superseded"] as const) {
      expect(agentDecisionSignals(action({}), action({ state: "declined", declined: { reason } })), reason).toBeNull();
    }
    expect(agentDecisionSignals(action({}), action({ state: "approved" }))).toBeNull();
    expect(agentDecisionSignals(action({}), action({}))).toBeNull();
  });
});

describe("a decision on an AI line", () => {
  const line = { aiLine: "Maya, your team shipped 12 releases this month.", subjectVariant: "Your month at Lumen", decidedAt: null };

  it("counts approve as written as kept, a changed line or subject as edited, and the rest as declined", () => {
    expect(lineDecisionSignal(line, { action: "approve", line: `${line.aiLine} `, subject: "Your month at Lumen" })).toBe("kept");
    expect(lineDecisionSignal(line, { action: "approve", line: "Maya, your team shipped 12 releases.", subject: "Your month at Lumen" })).toBe("edited");
    expect(lineDecisionSignal(line, { action: "approve", line: line.aiLine, subject: null })).toBe("edited");
    expect(lineDecisionSignal({ ...line, subjectVariant: null }, { action: "approve", line: line.aiLine, subject: null })).toBe("kept");
    expect(lineDecisionSignal(line, { action: "fallback" })).toBe("declined");
    expect(lineDecisionSignal(line, { action: "skip" })).toBe("declined");
  });

  it("counts only the first decision on a line", () => {
    expect(lineDecisionSignal({ ...line, decidedAt: AT }, { action: "skip" })).toBeNull();
  });
});

describe("transitionAgentAction counts once a move is saved", () => {
  const proposal = (made?: LoopStamp): AgentProposal => ({
    dedupeKey: agentDedupeKey("person_fields.suggest", MAYA, "plan", "a1b2"),
    agent: "vizzy",
    action: "person_fields.suggest",
    target: { type: "person", id: MAYA },
    personId: MAYA,
    proposal: { fields: { plan: "pro" } },
    basis: { fields: { plan: "free" } },
    fieldIds: ["plan"],
    signals: [{ kind: "field_value", ref: "plan" }],
    review: { kind: "agent_draft", href: "/admin/crm/people/x" },
    requestedBy: MEMBER,
    expiresAt: "2026-12-20T10:00:00.000Z",
    at: AT,
    ...(made ? { made } : {}),
  });
  const week = loopWeekOf(new Date());

  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("counts a dismissal against the action's stamp, and a refused move not at all", async () => {
    const fake = new FakeFirestore();
    const db = readsFirst(fake);
    const { action: a } = await proposeAgentAction(lumen, proposal(stamp), { db });
    const r = await transitionAgentAction(lumen, a.id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER, expectRev: 1 }, { db });
    expect(r.ok).toBe(true);
    // A second move on a final state is refused, and counts nothing.
    expect((await transitionAgentAction(lumen, a.id, { to: "acted", by: MEMBER, at: LATER }, { db })).ok).toBe(false);
    expect(sumWeek(fake, lumen.tenantId, week)).toEqual({ c: { "canvas.person_fields": { "canvas.person_fields": { v0: { none: { declined: 1 } } } } } });
  });

  it("counts acted then undone, and nothing for an action with no stamp", async () => {
    const fake = new FakeFirestore();
    const db = readsFirst(fake);
    const { action: a } = await proposeAgentAction(lumen, proposal(stamp), { db });
    await transitionAgentAction(lumen, a.id, { to: "acted", by: MEMBER, at: LATER, result: { fields: { plan: "team" } }, undo: { before: { plan: "free" } } }, { db });
    await transitionAgentAction(lumen, a.id, { to: "undone", by: MEMBER, at: LATER }, { db });
    const { action: plain } = await proposeAgentAction(lumen, { ...proposal(), dedupeKey: agentDedupeKey("person_fields.suggest", MAYA, "plan", "c3d4") }, { db });
    await transitionAgentAction(lumen, plain.id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db });
    expect(sumWeek(fake, lumen.tenantId, week)).toEqual({ c: { "canvas.person_fields": { "canvas.person_fields": { v0: { none: { edited: 1, undone: 1 } } } } } });
  });

  it("with LOOPS_ENABLED off keeps no stamp and counts nothing (decision 22)", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    const fake = new FakeFirestore();
    const db = readsFirst(fake);
    const { action: a } = await proposeAgentAction(lumen, proposal(stamp), { db });
    await transitionAgentAction(lumen, a.id, { to: "declined", reason: "dismissed", by: MEMBER, at: LATER }, { db });
    expect(fake.raw("agent_actions", a.id)).not.toHaveProperty("made");
    expect(fake.dump("loop_days")).toEqual([]);
  });
});

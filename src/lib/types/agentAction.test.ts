import { describe, expect, it } from "vitest";
import { deterministicAgentActionId, deterministicContactId, deterministicEventId } from "@/lib/crm/identifiers";
import type { ContactPersonId } from "@/lib/ontology/person";
import {
  AGENT_ACTION_LIMITS,
  AGENT_ACTION_STATES,
  AGENT_TRANSITIONS,
  AgentActionIdSchema,
  AgentActionSchema,
  agentDedupeKey,
  canTransition,
  isAgentActionId,
  SignalRefSchema,
  type AgentAction,
} from "./agentAction";

const PERSON = deterministicContactId("ten_demo", "ada@example.com") as ContactPersonId;
const KEY = "person_fields.suggest|plan|a1b2";

function action(over: Partial<AgentAction> = {}): AgentAction {
  return {
    id: deterministicAgentActionId("ten_demo", KEY),
    tenantId: "ten_demo",
    dedupeKey: KEY,
    agent: "vizzy",
    action: "person_fields.suggest",
    mode: "suggest",
    target: { type: "person", id: PERSON },
    targetKey: `person:${PERSON}`,
    personId: PERSON,
    productUserId: null,
    state: "proposed",
    rev: 1,
    proposal: { fields: { plan: "pro" } },
    basis: { fields: { plan: "free" } },
    fieldIds: ["plan"],
    signals: [{ kind: "field_value", ref: "plan" }, { kind: "metric", ref: "openRate", meaning: "openRate", value: 0.4 }],
    draft: null,
    review: { kind: "agent_draft", href: "/admin/crm/people/x" },
    requestedBy: { type: "member", id: "uid_1" },
    decidedBy: null,
    decidedAt: null,
    actedBy: null,
    actedAt: null,
    result: null,
    undo: null,
    undoneBy: null,
    undoneAt: null,
    declined: null,
    expiresAt: "2026-12-20T10:00:00.000Z",
    clearDetailsOnClose: false,
    detailsClearedAt: null,
    blankedFieldIds: [],
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    ...over,
  };
}

const ok = (a: unknown) => AgentActionSchema.safeParse(a).success;
const big = (bytes: number) => ({ fields: { note: "x".repeat(bytes) } });

describe("agent action states", () => {
  it("allow exactly the listed moves", () => {
    const allowed = AGENT_ACTION_STATES.flatMap((from) => AGENT_ACTION_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`));
    expect(allowed.sort()).toEqual(["acted>undone", "approved>acted", "approved>declined", "proposed>acted", "proposed>approved", "proposed>declined"]);
    expect(AGENT_TRANSITIONS.undone).toEqual([]);
    expect(AGENT_TRANSITIONS.declined).toEqual([]);
  });
});

describe("signals", () => {
  it("are ids, never text", () => {
    expect(SignalRefSchema.safeParse({ kind: "data_signal", ref: "sig_1", meaning: "openRate", value: 0.2 }).success).toBe(true);
    expect(SignalRefSchema.safeParse({ kind: "data_signal", ref: "people asked about pricing" }).success).toBe(false);
    expect(SignalRefSchema.safeParse({ kind: "data_signal", ref: "ada@example.com" }).success).toBe(false);
    expect(SignalRefSchema.safeParse({ kind: "metric", ref: "x", meaning: "notAMeaning" }).success).toBe(false);
  });

  it("keep a field's value out of a field_value signal, and name one of the action's fields", () => {
    expect(ok(action())).toBe(true);
    expect(ok(action({ signals: [{ kind: "field_value", ref: "plan", value: 3 }] }))).toBe(false);
    expect(ok(action({ signals: [{ kind: "field_value", ref: "tier" }] }))).toBe(false);
    // Once the field is blanked, its signal still names one of the action's fields.
    expect(ok(action({ fieldIds: [], blankedFieldIds: ["plan"] }))).toBe(true);
  });

  it("are at most 20", () => {
    const signals = Array.from({ length: AGENT_ACTION_LIMITS.signals + 1 }, (_, i) => ({ kind: "metric" as const, ref: `m${i}` }));
    expect(ok(action({ signals }))).toBe(false);
    expect(ok(action({ signals: signals.slice(0, AGENT_ACTION_LIMITS.signals) }))).toBe(true);
  });
});

describe("AgentActionSchema", () => {
  it("caps proposal, basis, result and undo at 64 KB each", () => {
    expect(ok(action({ proposal: big(AGENT_ACTION_LIMITS.proposalBytes) }))).toBe(false);
    expect(ok(action({ basis: big(AGENT_ACTION_LIMITS.basisBytes) }))).toBe(false);
    expect(ok(action({ state: "acted", result: big(AGENT_ACTION_LIMITS.resultBytes) }))).toBe(false);
    expect(ok(action({ state: "acted", undo: { before: big(AGENT_ACTION_LIMITS.undoBytes) } }))).toBe(false);
    expect(ok(action({ proposal: big(60_000) }))).toBe(true);
  });

  it("only suggests", () => {
    expect(ok({ ...action(), mode: "act" })).toBe(false);
  });

  it("ties a person target to its personId, with no product user", () => {
    const other = deterministicContactId("ten_demo", "bo@example.com") as ContactPersonId;
    expect(ok(action({ personId: other }))).toBe(false);
    expect(ok(action({ productUserId: "pu_1" }))).toBe(false);
    expect(ok(action({ target: { type: "company", id: "co_1" }, targetKey: "company:co_1", personId: null, productUserId: null }))).toBe(true);
    expect(ok(action({ target: { type: "company", id: "co_1" }, targetKey: "company:co_2", personId: null }))).toBe(false);
  });

  it("refuses a target type it doesn't know", () => {
    expect(ok({ ...action(), target: { type: "brand_map_question", id: "q1" }, targetKey: "brand_map_question:q1", personId: null })).toBe(false);
  });

  it("needs an expiry after it was made and at most 90 days on", () => {
    const { expiresAt: _e, ...missing } = action();
    expect(ok(missing)).toBe(false);
    expect(ok(action({ expiresAt: "2026-11-19T10:00:00.000Z" }))).toBe(false);
    expect(ok(action({ expiresAt: "2026-11-20T10:00:00.000Z" }))).toBe(false);
    expect(ok(action({ expiresAt: "2027-02-18T10:00:00.000Z" }))).toBe(true);
    expect(ok(action({ expiresAt: "2027-02-18T10:00:00.001Z" }))).toBe(false);
  });
});

describe("dedupe keys and ids", () => {
  it("join the action and its parts, and refuse spaces, addresses and long keys", () => {
    expect(agentDedupeKey("person_fields.suggest", PERSON, "plan", "a1b2c3")).toBe(`person_fields.suggest|${PERSON}|plan|a1b2c3`);
    expect(agentDedupeKey("new_person.fill", "req_1")).toBe("new_person.fill|req_1");
    expect(() => agentDedupeKey("person_fields.suggest", "Ada Lovelace")).toThrow();
    expect(() => agentDedupeKey("person_fields.suggest", "ada@example.com")).toThrow();
    expect(() => agentDedupeKey("person_fields.suggest", "a|b")).toThrow();
    expect(() => agentDedupeKey("Suggest", "x")).toThrow();
    expect(() => agentDedupeKey("person_fields.suggest", ...Array.from({ length: 3 }, () => "x".repeat(110)))).toThrow();
  });

  it("accept only the id deterministicAgentActionId gives", () => {
    const id = deterministicAgentActionId("ten_demo", KEY);
    expect(AgentActionIdSchema.safeParse(id).success).toBe(true);
    expect(isAgentActionId(id)).toBe(true);
    for (const bad of [deterministicEventId("ten_demo", KEY), `aa_${"A".repeat(40)}`, "aa_1", PERSON]) expect(AgentActionIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});

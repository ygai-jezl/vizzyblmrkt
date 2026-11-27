import { beforeEach, describe, expect, it } from "vitest";
import { WORK_LOG } from "@/lib/tenant";
import { readsFirst } from "@/lib/tenant/testing/readsFirst";
import type { TenantContext } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import type { Region } from "@/lib/types/tenant";
import { DRAFT_DAYS, WORK_DECISION_DRAFT_ACTION, WORK_LOG_DRAFT_ACTION } from "./draft";
import { draftWorkDecision, draftWorkLog, readDecisionDraft, readLogDraft, saveDecisionDraft, saveLogDraft } from "./drafts";
import type { WorkResult } from "./result";
import { addTask } from "./service";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "./testing/fixtures";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import type { WorkLogRowOf, WorkTask } from "./types";

// The Log notes and decisions Vizzy drafts in chat, and a person's save of one. Made-up Lumen
// (Lumen Notes in the United States, Lumen Europe) and Fernhill Plants.
let w: World;
let t: WorkTask;

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const action = (id: string, db = w.us) => db.raw("agent_actions", id) as unknown as AgentAction;
const trail = (id: string, db = w.us) => db.dump("ontology_events").filter((r) => r.agentActionId === id);

beforeEach(async () => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
  t = value(await addTask(await w.scope(PEOPLE.nina), { title: "Pick a pottery supplier", brandId: LUMEN_US }, w.deps)).task.task;
});

const logDraft = async (input: unknown = { workstream: "Pricing page", state: "doing", note: "Copy done, waiting on screenshots" }, who: TenantContext = PEOPLE.nina) =>
  value(await draftWorkLog(await w.scope(who), input, w.deps));
const decisionDraft = async (over: Record<string, unknown> = {}, who: TenantContext = PEOPLE.nina, ref = t.ref) =>
  value(await draftWorkDecision(await w.scope(who), { ref, question: "Which supplier first?", options: ["Clay and Co", "Fernhill Pots"], recommended: "b", reason: "They deliver weekly.", ...over }, w.deps));

describe("drafting a Log note", () => {
  it("keeps it as an open agent action in the session brand, aimed at the log row it would become", async () => {
    const d = await logDraft();
    expect(d.outcome).toBe("created");
    expect(action(d.action.id)).toMatchObject({
      tenantId: LUMEN_US,
      agent: "vizzy",
      action: WORK_LOG_DRAFT_ACTION,
      state: "proposed",
      target: { type: "work_log", id: expect.stringMatching(/^wl_[0-9a-f]{24}$/) },
      proposal: { entry: { workstream: "Pricing page", state: "doing", note: "Copy done, waiting on screenshots", links: [], taskId: null, ref: null, brandId: LUMEN_US } },
      fieldIds: [],
      review: null,
      requestedBy: { type: "member", id: NINA },
      clearDetailsOnClose: false,
      expiresAt: new Date(Date.parse("2026-11-20T15:00:00.000Z") + DRAFT_DAYS * 86_400_000).toISOString(),
    });
    // Nothing is in the Log until a person saves it.
    expect(w.us.dump(WORK_LOG).filter((r) => r.kind === "entry")).toEqual([]);
    // The same draft again is the one waiting.
    expect((await logDraft()).outcome).toBe("open");
    expect(w.us.dump("agent_actions")).toHaveLength(1);
  });

  it("checks the task and the brand as an entry would", async () => {
    const onTask = await logDraft({ workstream: "Supplier calls", ref: t.ref });
    expect(onTask.draft).toMatchObject({ taskId: t.id, ref: t.ref, brandId: LUMEN_US });
    // Sam, a member in a two brand organisation, logs for Lumen Notes only.
    expect(await draftWorkLog(await w.scope(PEOPLE.sam), { workstream: "Europe launch", brandId: LUMEN_EU }, w.deps)).toMatchObject({ ok: false, error: "brand_not_yours" });
    expect(await draftWorkLog(await w.scope(PEOPLE.sam), { workstream: "Everything", brandId: null }, w.deps)).toMatchObject({ ok: false, error: "whole_business_owners" });
    expect(await draftWorkLog(await w.scope(PEOPLE.nina), { workstream: "Nothing", ref: 999 }, w.deps)).toMatchObject({ ok: false, error: "not_found" });
    expect(await draftWorkLog(await w.scope(PEOPLE.nina), { workstream: "A\nB" }, w.deps)).toMatchObject({ ok: false, error: "invalid_input" });
  });
});

describe("saving a drafted note", () => {
  it("writes the entry under the draft's id, as the person left it, and moves the draft with what they changed", async () => {
    const d = await logDraft();
    const scope = await w.scope(PEOPLE.nina);
    const open = value(await readLogDraft(scope, d.action.id, w.deps));
    const saved = value(await saveLogDraft(scope, { workstream: "Pricing page", state: "done", note: "Copy and screenshots done", draft: { id: d.action.id, rev: open.rev } }, w.deps));
    expect(saved.row).toMatchObject({ id: d.action.target.id, kind: "entry", workstream: "Pricing page", state: "done", source: { who: { kind: "person", id: NINA }, tool: "draft_work_log", session: null } });
    const a = action(d.action.id);
    expect(a).toMatchObject({ state: "acted", result: { logId: d.action.target.id, edited: ["state", "note"] }, actedBy: { type: "member", id: NINA } });
    // What Vizzy drafted stays beside what was saved.
    expect(a.proposal).toMatchObject({ entry: { state: "doing", note: "Copy done, waiting on screenshots" } });
    expect(trail(d.action.id).map((e) => e.kind).sort()).toEqual(["agent.acted", "agent.approved", "agent.proposed"]);
    // Saved once: again, it is gone.
    expect(await saveLogDraft(scope, { workstream: "Pricing page", state: "done", draft: { id: d.action.id, rev: open.rev } }, w.deps)).toMatchObject({ ok: false, error: "draft_decided" });
    expect(w.us.dump(WORK_LOG).filter((r) => r.kind === "entry")).toHaveLength(1);
  });

  it("refuses a draft that moved since it was read, and one nobody can see", async () => {
    const d = await logDraft();
    const scope = await w.scope(PEOPLE.nina);
    expect(await saveLogDraft(scope, { workstream: "Pricing page", state: "doing", draft: { id: d.action.id, rev: 7 } }, w.deps)).toMatchObject({ ok: false, error: "draft_changed" });
    expect(await readLogDraft(scope, `aa_${"0".repeat(40)}`, w.deps)).toMatchObject({ ok: false, error: "draft_missing" });
    // Lumen Europe's session reads Lumen Europe's agent actions: Nina's Lumen Notes draft isn't there.
    expect(await readLogDraft(await w.scope(PEOPLE.ninaEu), d.action.id, w.deps)).toMatchObject({ ok: false, error: "draft_missing" });
  });

  it("reads before it writes in its one transaction", async () => {
    const d = await logDraft();
    const deps = { ...w.deps, regionDb: (r: Region) => (r === "us" ? readsFirst(w.us) : w.dbOf(r)) };
    value(await saveLogDraft(await w.scope(PEOPLE.nina), { workstream: "Pricing page", state: "doing", note: "Copy done, waiting on screenshots", draft: { id: d.action.id, rev: 1 } }, deps));
    expect(action(d.action.id)).toMatchObject({ state: "acted", result: { edited: [] } });
  });

  it("writes neither the entry nor the draft's move when the commit fails", async () => {
    const d = await logDraft();
    w.us.onBeforeCommit = () => {
      throw new Error("the region didn't answer");
    };
    await expect(saveLogDraft(await w.scope(PEOPLE.nina), { workstream: "Pricing page", state: "doing", draft: { id: d.action.id, rev: 1 } }, w.deps)).rejects.toThrow("the region didn't answer");
    w.us.onBeforeCommit = undefined;
    expect(w.us.dump(WORK_LOG).filter((r) => r.kind === "entry")).toEqual([]);
    expect(action(d.action.id).state).toBe("proposed");
  });
});

describe("drafting a decision", () => {
  it("keeps the question, the options and Vizzy's pick with why, aimed at the decision row it would become", async () => {
    const d = await decisionDraft();
    expect(action(d.action.id)).toMatchObject({
      action: WORK_DECISION_DRAFT_ACTION,
      target: { type: "work_log", id: expect.stringMatching(/^wl_/) },
      proposal: {
        decision: {
          taskId: t.id,
          ref: t.ref,
          question: "Which supplier first?",
          options: [
            { id: "a", label: "Clay and Co" },
            { id: "b", label: "Fernhill Pots" },
          ],
          recommended: { option: "b", reason: "They deliver weekly." },
        },
      },
      review: null,
      clearDetailsOnClose: false,
    });
    // A pick by its words is the same option.
    expect((await decisionDraft({ question: "Which supplier second?", recommended: "clay and co" })).draft.recommended).toEqual({ option: "a", reason: "They deliver weekly." });
  });

  it("never drafts Approve the plan, in any case or spacing, and writes nothing", async () => {
    for (const question of ["Approve the plan", "approve the plan?", "  APPROVE THE  plan. "]) {
      expect(await draftWorkDecision(await w.scope(PEOPLE.nina), { ref: t.ref, question, options: ["Approve", "Change it", "Not now"], recommended: "a", reason: "It is ready." }, w.deps)).toMatchObject({
        ok: false,
        error: "plan_drafted",
      });
    }
    expect(await draftWorkDecision(await w.scope(PEOPLE.nina), { ref: t.ref, question: "Ship it?", options: ["Yes", "No"], plan: { url: "https://plans.lumen.example/p" } }, w.deps)).toMatchObject({ ok: false, error: "plan_drafted" });
    expect(w.us.dump("agent_actions")).toEqual([]);
  });

  it("refuses a pick that isn't an option, a pick with no reason, and a task the person can't see", async () => {
    const scope = await w.scope(PEOPLE.nina);
    expect(await draftWorkDecision(scope, { ref: t.ref, question: "Which?", options: ["A", "B"], recommended: "c", reason: "Because." }, w.deps)).toMatchObject({ ok: false, error: "pick_unknown" });
    expect(await draftWorkDecision(scope, { ref: t.ref, question: "Which?", options: ["A", "B"], recommended: "a" }, w.deps)).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await draftWorkDecision(scope, { ref: t.ref, question: "Which?", options: ["A"] }, w.deps)).toMatchObject({ ok: false, error: "invalid_input" });
    const eu = value(await addTask(await w.scope(PEOPLE.nina), { title: "Europe only", brandId: LUMEN_EU }, w.deps)).task.task;
    expect(await draftWorkDecision(await w.scope(PEOPLE.sam), { ref: eu.ref, question: "Which?", options: ["A", "B"] }, w.deps)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("choosing on a drafted decision", () => {
  it("records the decision with Vizzy's pick as its recommendation, works out agreed, and moves the draft", async () => {
    const d = await decisionDraft();
    const saved = value(await saveDecisionDraft(await w.scope(PEOPLE.sam), { ref: t.ref, chosen: "a", why: "Clay and Co are nearer", draft: { id: d.action.id, rev: 1 } }, w.deps));
    expect(saved.row).toMatchObject({
      id: d.action.target.id,
      kind: "decision",
      taskId: t.id,
      source: { who: { kind: "person", id: SAM }, tool: "draft_work_decision" },
      decision: {
        question: "Which supplier first?",
        recommended: { option: "b", by: { kind: "vizzy" }, reason: "They deliver weekly." },
        chosen: { option: "a", by: SAM },
        agreed: false,
        why: "Clay and Co are nearer",
        plan: null,
      },
    });
    expect(action(d.action.id)).toMatchObject({ state: "acted", result: { logId: d.action.target.id, chosen: "a", agreed: false } });
    expect(await saveDecisionDraft(await w.scope(PEOPLE.sam), { ref: t.ref, chosen: "b", draft: { id: d.action.id, rev: 1 } }, w.deps)).toMatchObject({ ok: false, error: "draft_decided" });
  });

  it("needs a choice, the draft's own task, and is never a plan approval", async () => {
    const d = await decisionDraft();
    const scope = await w.scope(PEOPLE.nina);
    expect(await saveDecisionDraft(scope, { ref: t.ref, draft: { id: d.action.id, rev: 1 } }, w.deps)).toMatchObject({ ok: false, error: "draft_choice" });
    expect(await saveDecisionDraft(scope, { ref: t.ref, chosen: "a", plan: { url: "https://plans.lumen.example/p" }, draft: { id: d.action.id, rev: 1 } }, w.deps)).toMatchObject({ ok: false, error: "plan_recommended" });
    const other = value(await addTask(scope, { title: "Another task", brandId: LUMEN_US }, w.deps)).task.task;
    expect(await saveDecisionDraft(scope, { ref: other.ref, chosen: "a", draft: { id: d.action.id, rev: 1 } }, w.deps)).toMatchObject({ ok: false, error: "draft_missing" });
    expect(action(d.action.id).state).toBe("proposed");
    expect(w.us.dump(WORK_LOG).filter((r) => r.kind === "decision")).toEqual([]);
  });

  it("on a task kept in another region, writes the row there first and then moves the draft, once", async () => {
    const eu = value(await addTask(await w.scope(PEOPLE.nina), { title: "Pick a courier for Europe", brandId: LUMEN_EU }, w.deps)).task.task;
    // Nina drafts it from Lumen Notes' chat (the United States); the task is kept in Europe.
    const d = await decisionDraft({}, PEOPLE.nina, eu.ref);
    const scope = await w.scope(PEOPLE.nina);
    expect(value(await readDecisionDraft(scope, d.action.id, w.deps)).draft.taskId).toBe(eu.id);
    const saved = value(await saveDecisionDraft(scope, { ref: eu.ref, chosen: "b", draft: { id: d.action.id, rev: 1 } }, w.deps));
    expect(saved.row).toMatchObject({ id: d.action.target.id, region: "eu", decision: { agreed: true } });
    expect(w.eu.raw(WORK_LOG, d.action.target.id)).toMatchObject({ kind: "decision", taskId: eu.id });
    expect(w.us.raw(WORK_LOG, d.action.target.id)).toBeUndefined();
    expect(action(d.action.id)).toMatchObject({ state: "acted", result: { chosen: "b", agreed: true } });
    const rows = (await w.eu.dump(WORK_LOG)).filter((r) => r.kind === "decision") as unknown as Array<WorkLogRowOf<"decision">>;
    expect(rows).toHaveLength(1);
  });
});

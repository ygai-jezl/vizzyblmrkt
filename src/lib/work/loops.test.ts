import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { LOOP_DAYS } from "@/lib/tenant/loops";
import type { TenantContext } from "@/lib/tenant/types";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import { agentDraftWorkDecision, agentDraftWorkLog, agentSuggestWorkTask } from "./agentApi";
import { WORK_DECISION_DRAFT_ACTION, WORK_LOG_DRAFT_ACTION } from "./draft";
import { saveDecisionDraft, saveLogDraft } from "./drafts";
import type { AddTaskBody } from "./inputs";
import type { WorkResult } from "./result";
import { addTask } from "./service";
import { addSuggestion, dismissSuggestion } from "./suggestions";
import { WORK_SUGGEST_ACTION } from "./suggestion";
import { LUMEN_EU, LUMEN_US, NINA } from "./testing/fixtures";
import { makeWorld, PEOPLE, type World } from "./testing/world";

// Work under the learning loops (LOOPS_ENABLED, learning loops step 5): what Vizzy suggests and
// drafts for Work is stamped under vizzy_chat in the scope of what it becomes, counted made once
// where it is saved, and a person's answer counts once where it closes, in the session brand's own
// region, never under another kind. Made-up Lumen (Lumen Notes in the United States, Lumen Europe).
let w: World;
const NINA_AGENT: TenantContext = { tenantId: LUMEN_US, region: "us", source: "agent", userId: NINA, role: "admin" };
const week = () => loopWeekOf(new Date());

beforeEach(() => {
  vi.stubEnv("LOOPS_ENABLED", "true");
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}

const stored = (id: AgentActionId) => w.us.raw("agent_actions", id) as unknown as AgentAction;
const actions = (kind: string) => (w.us.dump("agent_actions") as unknown as AgentAction[]).filter((a) => a.action === kind);
type ToolBody = { outcome: string; card: { id: AgentActionId } };
const suggest = async (title: string) => (await agentSuggestWorkTask(NINA_AGENT, { tool: "suggest_work_task", title }, w.deps)).body as ToolBody;
/** One kind's counters for one scope, as the week's shards add up. */
const cell = (scope: string) => ((sumWeek(w.us, LUMEN_US, week()).c as Record<string, Record<string, { v0?: { none?: Record<string, number> } }>> | undefined)?.[scope]?.vizzy_chat?.v0?.none ?? {});
const types = () => (sumWeek(w.us, LUMEN_US, week()).t ?? {}) as Record<string, { made?: number }>;

describe("Vizzy's Work suggestions under the learning loops", () => {
  it("are stamped under vizzy_chat, made once each, and Add to Work, Edit then add and Dismiss each count once", async () => {
    const [asWritten, edited, dismissed] = [await suggest("Compare three pricing pages"), await suggest("Write the onboarding email"), await suggest("Buy a billboard")].map((b) => {
      expect(b.outcome).toBe("suggested");
      return { id: b.card.id };
    }) as [{ id: AgentActionId }, { id: AgentActionId }, { id: AgentActionId }];
    // The same suggestion again is the one waiting: nothing new is made.
    expect(await suggest("Compare three pricing pages")).toMatchObject({ outcome: "waiting" });
    expect(actions(WORK_SUGGEST_ACTION)).toHaveLength(3);
    expect(stored(asWritten.id).made).toMatchObject({ kind: "vizzy_chat", scope: "work_task", v: 0, arm: "none", by: "vizzy", made: "m1.work_task.0.n" });

    const scope = await w.scope(PEOPLE.nina);
    value(await addSuggestion(scope, { actionId: asWritten.id, rev: 1 }, w.deps));
    // A second add is refused and counts nothing more.
    expect(await addSuggestion(scope, { actionId: asWritten.id, rev: 1 }, w.deps)).toMatchObject({ ok: false });
    const body: AddTaskBody = { title: "Write the welcome email", brandId: LUMEN_US, via: "work_page" };
    expect(value(await addSuggestion(scope, { actionId: edited.id, rev: 1, task: body }, w.deps)).edited).toContain("title");
    value(await dismissSuggestion(scope, { actionId: dismissed.id, rev: 1, why: "not_for_us" }, w.deps));
    expect(await dismissSuggestion(scope, { actionId: dismissed.id, rev: 1, why: "wrong" }, w.deps)).toMatchObject({ ok: false });

    expect(cell("work_task")).toEqual({ made: 3, kept: 1, edited: 1, declined: 1, "declined.not_for_us": 1 });
    expect(types().work_task).toEqual({ made: 3 });
    // Counted in the session brand's own region only.
    expect(w.eu.dump(LOOP_DAYS)).toEqual([]);
  });
});

describe("Vizzy's Log drafts under the learning loops", () => {
  it("are stamped under vizzy_chat, made once each, and a save counts once: edited when the note changed, kept for a decision", async () => {
    const nina = await w.scope(PEOPLE.nina);
    const eu = value(await addTask(nina, { title: "Register Lumen Europe for VAT", brandId: LUMEN_EU }, w.deps)).task.task;
    const note = (await agentDraftWorkLog(NINA_AGENT, { tool: "draft_work_log", workstream: "Pricing page", state: "Doing", note: "Copy done" }, w.deps)).body as ToolBody;
    expect(note.outcome).toBe("drafted");
    expect((await agentDraftWorkLog(NINA_AGENT, { tool: "draft_work_log", workstream: "Pricing page", state: "Doing", note: "Copy done" }, w.deps)).body).toMatchObject({ outcome: "waiting" });
    const decision = (await agentDraftWorkDecision(NINA_AGENT, { tool: "draft_work_decision", task: eu.ref, question: "Which adviser first?", options: ["Fernhill Tax", "Lumen Advisers"], recommended: "Fernhill Tax", reason: "They answered first." }, w.deps)).body as ToolBody;
    expect(decision.outcome).toBe("drafted");
    expect(actions(WORK_LOG_DRAFT_ACTION)[0]!.made).toMatchObject({ kind: "vizzy_chat", scope: "work_log", by: "vizzy" });
    expect(actions(WORK_DECISION_DRAFT_ACTION)[0]!.made).toMatchObject({ kind: "vizzy_chat", scope: "work_decision", by: "vizzy" });

    value(await saveLogDraft(nina, { workstream: "Pricing page", state: "done", note: "Copy and screenshots done", draft: { id: note.card.id, rev: 1 } }, w.deps));
    expect(await saveLogDraft(nina, { workstream: "Pricing page", state: "done", draft: { id: note.card.id, rev: 1 } }, w.deps)).toMatchObject({ ok: false, error: "draft_decided" });
    // The decision's task is kept in Europe: the row is written there, the draft moves and counts in the session brand's region.
    value(await saveDecisionDraft(nina, { ref: eu.ref, chosen: "b", draft: { id: decision.card.id, rev: 1 } }, w.deps));

    expect(cell("work_log")).toEqual({ made: 1, edited: 1 });
    expect(cell("work_decision")).toEqual({ made: 1, kept: 1 });
    expect(types().work_log).toEqual({ made: 2 });
    expect(w.eu.dump(LOOP_DAYS)).toEqual([]);
  });
});

describe("Work with LOOPS_ENABLED off", () => {
  it("keeps no stamp on a suggestion or a draft and counts nothing, as before (decision 22)", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    const a = await suggest("Compare three pricing pages");
    expect(a.outcome).toBe("suggested");
    value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.card.id, rev: 1 }, w.deps));
    const note = (await agentDraftWorkLog(NINA_AGENT, { tool: "draft_work_log", workstream: "Pricing page", state: "Doing" }, w.deps)).body as ToolBody;
    value(await saveLogDraft(await w.scope(PEOPLE.nina), { workstream: "Pricing page", state: "doing", draft: { id: note.card.id, rev: 1 } }, w.deps));
    for (const x of w.us.dump("agent_actions")) expect(x).not.toHaveProperty("made");
    expect(w.us.dump(LOOP_DAYS)).toEqual([]);
    expect(w.control.dump(LOOP_DAYS)).toEqual([]);
  });
});

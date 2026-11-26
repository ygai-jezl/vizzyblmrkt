import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_LOG, WORK_TASKS } from "@/lib/tenant";
import { readsFirst } from "@/lib/tenant/testing/readsFirst";
import type { TenantContext } from "@/lib/tenant/types";
import type { AgentAction, AgentActionId, SignalRef } from "@/lib/types/agentAction";
import type { AddTaskBody } from "./inputs";
import type { WorkResult } from "./result";
import { addSuggestion, dismissSuggestion, proposeWorkSuggestion, roundAfter, suggestionForForm, suggestionKey } from "./suggestions";
import { WORK_SUGGEST_ACTION, type SuggestedTask } from "./suggestion";
import { LUMEN_EU, LUMEN_US, NINA, SAM } from "./testing/fixtures";
import { FERNHILL, makeWorld, PEOPLE, type World } from "./testing/world";
import type { WorkLogRow, WorkTask } from "./types";

// Vizzy's task suggestions in Review: made, added as written, edited then added, or dismissed with a
// reason. Made-up Lumen (Lumen Notes in the United States, Lumen Europe) and Fernhill Plants.
let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}

const EVIDENCE: SignalRef[] = [{ kind: "brand_note", ref: "bn_pricing" }];
const lumenTask = (over: Partial<SuggestedTask> = {}): SuggestedTask => ({
  title: "Check the team plan test accounts after tonight's runs",
  description: "After tonight's runs, check both test accounts got answers.",
  stage: "build",
  brandId: LUMEN_US,
  typedLinks: [],
  measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
  proposed: { kind: "runs_better", reason: "It checks a nightly run." },
  from: "from today's log: Competitor pricing research",
  why: "You logged Competitor pricing research as waiting on tonight's runs.",
  ...over,
});

async function propose(task: unknown = lumenTask(), who: TenantContext = PEOPLE.nina) {
  return proposeWorkSuggestion(await w.scope(who), { task, evidence: EVIDENCE }, w.deps);
}
async function proposed(task: unknown = lumenTask(), who: TenantContext = PEOPLE.nina): Promise<AgentAction> {
  const r = value(await propose(task, who));
  expect(r.outcome).toBe("created");
  return r.action!;
}
const action = (id: string, db = w.us) => db.raw("agent_actions", id) as unknown as AgentAction & Record<string, unknown>;
const trail = (id: string, db = w.us) =>
  db
    .dump("ontology_events")
    .filter((r) => r.agentActionId === id)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

describe("making a suggestion", () => {
  it("keeps what Vizzy suggested as an open agent action in the session brand, aimed at the task it would make", async () => {
    const a = await proposed();
    const stored = action(a.id);
    expect(stored).toMatchObject({
      tenantId: LUMEN_US,
      action: WORK_SUGGEST_ACTION,
      agent: "vizzy",
      state: "proposed",
      target: { type: "work_task", id: expect.stringMatching(/^wt_[a-z2-7]{20}$/) },
      proposal: { task: lumenTask() },
      fieldIds: [],
      signals: EVIDENCE,
      review: { kind: "work_suggestion", href: `/admin/work/new?suggestion=${a.id}` },
      requestedBy: { type: "member", id: NINA },
      clearDetailsOnClose: false,
      expiresAt: "2026-12-20T15:00:00.000Z",
    });
    // Work data never sits under fields, which the erase blanks as a person's values.
    expect(stored.proposal).not.toHaveProperty("fields");
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed"]);
    // The same suggestion again is the open one, with nothing written.
    expect(value(await propose())).toMatchObject({ outcome: "open", action: { id: a.id } });
    expect(w.us.dump("agent_actions")).toHaveLength(1);
  });

  it("refuses Must have, which stays with people", async () => {
    const r = await propose({ ...lumenTask(), mustHave: true });
    expect(r).toMatchObject({ ok: false, status: 400, error: "suggestion_must_have" });
    expect(w.us.dump("agent_actions")).toEqual([]);
  });

  it("is checked as an add is: a member's own brand only, and only brands kept in the session brand's region", async () => {
    expect(await propose(lumenTask({ brandId: null }), PEOPLE.sam)).toMatchObject({ ok: false, error: "whole_business_owners" });
    expect(await propose(lumenTask({ brandId: LUMEN_EU }), PEOPLE.sam)).toMatchObject({ ok: false, error: "brand_not_yours" });
    // An owner may suggest for the whole business, kept here; not for a brand kept in Europe.
    expect(value(await propose(lumenTask({ brandId: null })))).toMatchObject({ outcome: "created" });
    expect(await propose(lumenTask({ brandId: LUMEN_EU }))).toMatchObject({ ok: false, error: "suggestion_other_region" });
    // A pull request needs a selected repo.
    expect(await propose(lumenTask({ typedLinks: [{ kind: "pull_request", provider: "github", repo: "Someone/else", number: 4 }] }))).toMatchObject({ ok: false, error: "repo_not_selected" });
  });
});

describe("Add to Work", () => {
  it("adds the task as Vizzy suggested it, its origin naming the suggestion, and acts the suggestion with its result, together", async () => {
    const a = await proposed();
    const r = value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: a.rev }, w.deps));
    expect(r.edited).toEqual([]);
    const t = r.task.task;
    expect(t.id).toBe(a.target.id);
    expect(t).toMatchObject({ ref: 1, title: lumenTask().title, status: "todo", stage: "build", brandId: LUMEN_US, mustHave: false, region: "us" });
    expect(t.origin).toEqual({ kind: "suggestion", agent: "vizzy", agentActionId: a.id, evidence: EVIDENCE, by: NINA });
    // Vizzy's proposed kind is kept beside the measure, not the rule's.
    expect(t.measure).toMatchObject({ kind: "runs_better", what: "errors", look: { days: 7 }, proposed: { kind: "runs_better", reason: "It checks a nightly run.", by: "vizzy" } });
    const stored = action(a.id);
    expect(stored).toMatchObject({ state: "acted", decidedBy: { type: "member", id: NINA }, actedBy: { type: "member", id: NINA }, result: { task: { id: t.id, ref: 1, title: t.title }, edited: [] } });
    // What Vizzy proposed survives the decision.
    expect(stored.proposal).toEqual({ task: lumenTask() });
    expect(stored.detailsClearedAt).toBeNull();
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed", "agent.approved", "agent.acted"]);
    const rows = w.us.dump(WORK_LOG) as unknown as WorkLogRow[];
    expect(rows).toEqual([expect.objectContaining({ kind: "change", field: "added", taskId: t.id, source: { who: { kind: "person", id: NINA }, tool: "review_add", session: null } })]);
  });

  it("is decided once: a second add or a dismiss after it is refused, and nothing is written twice", async () => {
    const a = await proposed();
    const scope = await w.scope(PEOPLE.nina);
    value(await addSuggestion(scope, { actionId: a.id, rev: 1 }, w.deps));
    expect(await addSuggestion(scope, { actionId: a.id, rev: 3 }, w.deps)).toMatchObject({ ok: false, status: 409, error: "suggestion_decided" });
    expect(await dismissSuggestion(scope, { actionId: a.id, rev: 3 }, w.deps)).toMatchObject({ ok: false, error: "suggestion_decided" });
    expect(w.us.dump(WORK_TASKS)).toHaveLength(1);
  });

  it("refuses a suggestion that changed since the person saw it", async () => {
    const a = await proposed();
    expect(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 2 }, w.deps)).toMatchObject({ ok: false, error: "suggestion_changed" });
    expect(w.us.dump(WORK_TASKS)).toEqual([]);
    expect(action(a.id).state).toBe("proposed");
  });

  it("reads first in its one transaction", async () => {
    const a = await proposed();
    const deps = { ...w.deps, regionDb: (r: Parameters<NonNullable<World["deps"]["regionDb"]>>[0]) => (r === "us" ? readsFirst(w.us) : w.dbOf(r)) };
    value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, deps));
    expect(action(a.id).state).toBe("acted");
  });

  it("writes neither the task nor the decision when the commit fails", async () => {
    const a = await proposed();
    w.us.onBeforeCommit = () => {
      throw new Error("the region didn't answer");
    };
    await expect(addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, w.deps)).rejects.toThrow("the region didn't answer");
    expect(w.us.dump(WORK_TASKS)).toEqual([]);
    expect(action(a.id).state).toBe("proposed");
    expect(trail(a.id).map((e) => e.kind)).toEqual(["agent.proposed"]);
  });
});

describe("Edit then add", () => {
  it("keeps what Vizzy suggested beside the task as added, and names the fields the person changed", async () => {
    const a = await proposed();
    const body: AddTaskBody = {
      title: "Check both test accounts",
      description: lumenTask().description,
      stage: "support",
      brandId: LUMEN_US,
      typedLinks: [],
      mustHave: true,
      measure: { kind: "done" },
      via: "work_page",
    };
    const r = value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, task: body }, w.deps));
    // Must have is the person's to tick, and isn't an edit; a new kind of win is.
    expect(r.edited).toEqual(["title", "stage", "measure", "measure.kind"]);
    expect(r.task.task).toMatchObject({ title: "Check both test accounts", mustHave: true, stage: "support", measure: { kind: "done", proposed: { kind: "runs_better", by: "vizzy" } } });
    expect(r.task.task.origin).toMatchObject({ kind: "suggestion", agentActionId: a.id });
    const stored = action(a.id);
    expect(stored.proposal).toEqual({ task: lumenTask() });
    expect(stored.result).toMatchObject({ task: { title: "Check both test accounts", mustHave: true, measure: { kind: "done" } }, edited: ["title", "stage", "measure", "measure.kind"] });
    const rows = w.us.dump(WORK_LOG) as unknown as WorkLogRow[];
    expect(rows[0]!.source.tool).toBe("review_edit");
  });

  it("opens the add page filled, for those who see it, while it is open", async () => {
    const a = await proposed();
    expect(value(await suggestionForForm(await w.scope(PEOPLE.nina), a.id, w.deps))).toEqual({ actionId: a.id, rev: 1, suggestion: lumenTask() });
    const whole = await proposed(lumenTask({ title: "Agree how the team names its plans", brandId: null }));
    // Sam is a member of Lumen Notes in a two brand organisation: no whole business suggestions.
    expect(await suggestionForForm(await w.scope(PEOPLE.sam), whole.id, w.deps)).toMatchObject({ ok: false, status: 404, error: "suggestion_missing" });
    expect(value(await suggestionForForm(await w.scope(PEOPLE.sam), a.id, w.deps)).actionId).toBe(a.id);
    w.at("2026-12-21T09:00:00.000Z");
    expect(await suggestionForForm(await w.scope(PEOPLE.nina), a.id, w.deps)).toMatchObject({ ok: false, error: "suggestion_decided" });
  });

  it("refuses a brand kept in another region, since the task and the suggestion commit together", async () => {
    const a = await proposed();
    const r = await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, task: { title: "Check", brandId: LUMEN_EU } }, w.deps);
    expect(r).toMatchObject({ ok: false, status: 409, error: "suggestion_other_region" });
    expect(w.eu.dump(WORK_TASKS)).toEqual([]);
    expect(w.us.dump(WORK_TASKS)).toEqual([]);
    expect(action(a.id).state).toBe("proposed");
  });
});

describe("Dismiss", () => {
  it("declines as dismissed with the reason tapped, kept on the record and on its agent.declined row, with what Vizzy proposed", async () => {
    const a = await proposed();
    const r = value(await dismissSuggestion(await w.scope(PEOPLE.sam), { actionId: a.id, rev: 1, why: "not_for_us" }, w.deps));
    expect(r).toEqual({ again: "never", line: `Dismissed “${lumenTask().title}”: Not for us. Vizzy won't suggest it again.` });
    const stored = action(a.id);
    expect(stored).toMatchObject({ state: "declined", declined: { reason: "dismissed", why: "not_for_us" }, decidedBy: { type: "member", id: SAM }, proposal: { task: lumenTask() } });
    expect(trail(a.id).at(-1)).toMatchObject({ kind: "agent.declined", properties: { reason: "dismissed", why: "not_for_us" } });
  });

  it("dismisses with no reason too", async () => {
    const a = await proposed();
    expect(value(await dismissSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, w.deps)).again).toBe("never");
    expect(action(a.id).declined).toEqual({ reason: "dismissed" });
    expect(trail(a.id).at(-1)!.properties).not.toHaveProperty("why");
  });
});

describe("the same suggestion again", () => {
  it("comes back after Not now once 30 days have passed, under the next round, and not before", async () => {
    const a = await proposed();
    value(await dismissSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, why: "not_now" }, w.deps));
    w.at("2026-12-10T15:00:00.000Z");
    expect(value(await propose())).toMatchObject({ outcome: "later", action: { id: a.id }, again: "2026-12-20T15:00:00.000Z" });
    w.at("2026-12-20T15:00:00.000Z");
    const again = value(await propose());
    expect(again.outcome).toBe("created");
    expect(again.action!.id).not.toBe(a.id);
    expect(again.action!.dedupeKey).toBe(suggestionKey(lumenTask(), 1));
  });

  it("stays away after any other reason, or none, and after it was added", async () => {
    for (const why of ["not_for_us", "already_on_it", "wrong", undefined] as const) {
      w = makeWorld("2026-11-20T15:00:00.000Z");
      const a = await proposed();
      value(await dismissSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1, ...(why ? { why } : {}) }, w.deps));
      w.at("2027-03-01T15:00:00.000Z");
      expect(value(await propose()).outcome).toBe("decided");
    }
    w = makeWorld("2026-11-20T15:00:00.000Z");
    const a = await proposed();
    value(await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, w.deps));
    expect(value(await propose(lumenTask({ title: "check the team plan test accounts, after tonight's runs!" }))).outcome).toBe("decided");
  });

  it("comes back at once after nobody decided it: expired, or past its expiry before the sweep", () => {
    const now = new Date("2026-12-25T00:00:00.000Z");
    const base = { expiresAt: "2026-12-20T00:00:00.000Z", decidedAt: null, declined: null };
    expect(roundAfter({ ...base, state: "proposed" }, now)).toEqual({ is: "next" });
    expect(roundAfter({ ...base, state: "proposed", expiresAt: "2026-12-30T00:00:00.000Z" }, now)).toEqual({ is: "open" });
    expect(roundAfter({ ...base, state: "declined", declined: { reason: "expired" }, decidedAt: "2026-12-20T00:00:00.000Z" }, now)).toEqual({ is: "next" });
    expect(roundAfter({ ...base, state: "declined", declined: { reason: "superseded" }, decidedAt: "2026-12-20T00:00:00.000Z" }, now)).toEqual({ is: "next" });
    expect(roundAfter({ ...base, state: "undone" }, now)).toEqual({ is: "decided" });
  });
});

describe("a one brand organisation", () => {
  it("lets its whole team add whole business suggestions, kept in the brand's region", async () => {
    const a = await proposed(lumenTask({ brandId: null, title: "Van insurance quotes" }), PEOPLE.rosa);
    const r = value(await addSuggestion(await w.scope(PEOPLE.rosa), { actionId: a.id as AgentActionId, rev: 1 }, w.deps));
    expect(r.task.task).toMatchObject({ brandId: null, region: "eu", addedFrom: FERNHILL });
    expect((w.eu.raw(WORK_TASKS, r.task.task.id) as unknown as WorkTask).origin.kind).toBe("suggestion");
  });
});

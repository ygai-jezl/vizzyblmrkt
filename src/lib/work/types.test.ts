import { describe, expect, it } from "vitest";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { aStoredTask, NINA, T0, T1 } from "./testing/fixtures";
import {
  agreedOf,
  CheckRowSchema,
  CheckSchema,
  DecisionSchema,
  isPlanApprovalQuestion,
  MeasureSchema,
  OriginSchema,
  PLAN_APPROVAL_OPTIONS,
  PLAN_APPROVAL_QUESTION,
  PlanUrlSchema,
  startingDirection,
  TypedLinkSchema,
  WorkLinkSchema,
  WorkLogRowSchema,
  WorkTaskSchema,
  workTaskOpen,
  type WorkDecision,
} from "./types";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;
const set = { setBy: NINA, setAt: T0 };

describe("typed links", () => {
  it("take a pull request from a repo path, GitLab subgroups included", () => {
    expect(ok(TypedLinkSchema, { kind: "pull_request", provider: "github", repo: "lumen-notes/app", number: 412 })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "pull_request", provider: "gitlab", repo: "lumen/apps/web", number: 7 })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "pull_request", provider: "github", repo: "app", number: 1 })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "pull_request", provider: "bitbucket", repo: "a/b", number: 1 })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "pull_request", provider: "github", repo: "a/b", number: 0 })).toBe(false);
  });

  it("name a switch or say why there is none, never both or neither", () => {
    expect(ok(TypedLinkSchema, { kind: "switch", name: "CREATE_SUGGEST_ANGLE_ENABLED" })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "switch", none: "A copy change, nothing to switch." })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "switch" })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "switch", name: "A_ENABLED", none: "both" })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "switch", name: "lower_case" })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "switch", name: `A${"B".repeat(80)}` })).toBe(false);
  });

  it("refuse a loop line that isn't a LOOPS kind", () => {
    expect(ok(TypedLinkSchema, { kind: "loop_line", loopKind: "content_angle" })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "loop_line", loopKind: "work_measure_kind" })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "loop_line", none: "Docs only, no choice made for a brand." })).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "loop_line", loopKind: "not_a_kind" })).toBe(false);
    expect(ok(TypedLinkSchema, { kind: "loop_line", loopKind: "toString" })).toBe(false);
  });

  it("take a plan only as an https page with no user name or password, up to 2,000 characters, with a title", () => {
    const plan = (url: string, title = "Work v2 plan") => ok(TypedLinkSchema, { kind: "plan", url, title });
    expect(plan("https://docs.example.com/plans/work")).toBe(true);
    expect(ok(TypedLinkSchema, { kind: "plan", url: "https://docs.example.com/p", title: "Plan", version: "v2" })).toBe(true);
    expect(plan("http://docs.example.com/plans/work")).toBe(false);
    expect(plan("https://nina:secret@docs.example.com/plans/work")).toBe(false);
    expect(plan("https://nina@docs.example.com/plans/work")).toBe(false);
    expect(plan("javascript:alert(1)")).toBe(false);
    expect(plan(`https://docs.example.com/${"a".repeat(2000)}`)).toBe(false);
    expect(plan("https://docs.example.com/p", "")).toBe(false);
    expect(ok(PlanUrlSchema, "https://docs.example.com/p")).toBe(true);
  });

  it("free links take http or https, never another scheme", () => {
    expect(ok(WorkLinkSchema, { url: "https://chat.example.com/c/1", label: "AI chat" })).toBe(true);
    expect(ok(WorkLinkSchema, { url: "http://intranet.example.com/x" })).toBe(true);
    expect(ok(WorkLinkSchema, { url: "ftp://files.example.com/x" })).toBe(false);
    expect(ok(WorkLinkSchema, { url: "https://u:p@example.com" })).toBe(false);
  });
});

describe("How we'll know it worked", () => {
  const used = (counts: unknown, look: unknown = { days: 14 }) => ({ kind: "used", counts, look, ...set });

  it("is Done is the win with no look and no then", () => {
    expect(ok(MeasureSchema, { kind: "done", ...set })).toBe(true);
    const parsed = MeasureSchema.parse({ kind: "done", ...set, look: { days: 7 }, then: { kind: "runs_better", what: "crashes", look: { days: 7 } } });
    expect(parsed).toEqual({ kind: "done", ...set });
  });

  it("never takes Done is the win as a then, and a then by days looks later than the first", () => {
    const first = { kind: "used", counts: { none: "" }, look: { days: 14 }, ...set };
    expect(ok(MeasureSchema, { ...first, then: { kind: "moves", meaning: "conversions", direction: "up", word: "Sign ups", look: { days: 60 } } })).toBe(true);
    expect(ok(MeasureSchema, { ...first, then: { kind: "done" } })).toBe(false);
    expect(ok(MeasureSchema, { ...first, then: { kind: "runs_better", what: "speed", look: { days: 14 } } })).toBe(false);
    expect(ok(MeasureSchema, { ...first, then: { kind: "runs_better", what: "speed", look: { days: 7 } } })).toBe(false);
    expect(ok(MeasureSchema, { ...first, then: { kind: "runs_better", what: "speed", look: { outputs: 20 } } })).toBe(true);
  });

  it("counts exactly one thing on a Used measure, none with an optional reason", () => {
    expect(ok(MeasureSchema, used({ purpose: "content_angle" }))).toBe(true);
    expect(ok(MeasureSchema, used({ type: "work_task" }))).toBe(true);
    expect(ok(MeasureSchema, used({ loopKind: "content_angle" }))).toBe(true);
    expect(ok(MeasureSchema, used({ productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }))).toBe(true);
    expect(ok(MeasureSchema, used({ none: "" }))).toBe(true);
    expect(ok(MeasureSchema, used({ none: "People only look at it." }))).toBe(true);
    expect(ok(MeasureSchema, used({}))).toBe(false);
    expect(ok(MeasureSchema, used({ purpose: "content_angle", type: "work_task" }))).toBe(false);
    expect(ok(MeasureSchema, used({ purpose: "not_a_purpose" }))).toBe(false);
    expect(ok(MeasureSchema, used({ productEvent: { connectionId: "pc_lumen", event: "Has Spaces" } }))).toBe(false);
    expect(ok(MeasureSchema, used({ none: "" }, { outputs: 15 }))).toBe(false);
    expect(ok(MeasureSchema, used({ none: "" }, { days: 366 }))).toBe(false);
  });

  it("moves a meaning, never one provider's number or a date, with the brand's word only on conversions", () => {
    const moves = (meaning: string, more: Record<string, unknown> = {}) => ok(MeasureSchema, { kind: "moves", meaning, direction: "up", look: { days: 30 }, ...set, ...more });
    expect(moves("openRate")).toBe(true);
    expect(moves("conversions", { word: "Orders" })).toBe(true);
    expect(moves("openRate", { word: "Orders" })).toBe(false);
    expect(moves("ga4Sessions")).toBe(false);
    expect(moves("cfVisits")).toBe(false);
    expect(moves("linkedinEngagement")).toBe(false);
    expect(moves("publishedAt")).toBe(false);
    expect(moves("notAMeaning")).toBe(false);
  });

  it("starts a direction from the meaning's better: up when it has none, down for a rank", () => {
    expect(startingDirection("conversions")).toBe("up");
    expect(startingDirection("openRate")).toBe("up");
    expect(startingDirection("declineShare")).toBe("down");
    expect(startingDirection("sends")).toBe("up");
    const rank = (Object.keys(MEANINGS) as MeaningKey[]).find((k) => (MEANINGS[k] as { unit: string }).unit === "rank");
    expect(rank).toBeDefined();
    expect(startingDirection(rank!)).toBe("down");
  });

  it("keeps the proposed kind beside the chosen one", () => {
    const m = MeasureSchema.parse({ kind: "runs_better", what: "crashes", look: { days: 7 }, ...set, proposed: { kind: "done", reason: "It reads like legal work.", by: "rule" } });
    expect(m).toMatchObject({ kind: "runs_better", proposed: { kind: "done", by: "rule" } });
    expect(ok(MeasureSchema, { kind: "done", ...set, proposed: { kind: "done", reason: "x", by: "someone" } })).toBe(false);
  });
});

describe("origins", () => {
  it("are a person, an import with its row and file, a Vizzy suggestion with its evidence, or a coding agent", () => {
    expect(ok(OriginSchema, { kind: "person", by: NINA })).toBe(true);
    expect(ok(OriginSchema, { kind: "import", by: NINA, importId: "wi_0123456789abcdef", row: 4, file: "Backlog.csv" })).toBe(true);
    const aa = deterministicAgentActionId("ten_lumen", "work_task.suggest|x");
    expect(ok(OriginSchema, { kind: "suggestion", agent: "vizzy", agentActionId: aa, evidence: [{ kind: "data_signal", ref: "dsg_1" }], by: NINA })).toBe(true);
    expect(ok(OriginSchema, { kind: "suggestion", agent: "vizzy", agentActionId: aa, evidence: Array(11).fill({ kind: "data_signal", ref: "dsg_1" }), by: NINA })).toBe(false);
    expect(ok(OriginSchema, { kind: "coding_agent", tool: "claude_code", session: "s1", keyId: "wk_1" })).toBe(true);
    expect(ok(OriginSchema, { kind: "person", by: "nina@example.com" })).toBe(false);
  });
});

describe("checks", () => {
  const check = (over: Record<string, unknown>) => ({ kind: "date", at: T1, taskId: null, note: "", setBy: NINA, setAt: T0, which: null, ...over });
  it("are on a date, or when another task is done", () => {
    expect(ok(CheckSchema, check({}))).toBe(true);
    expect(ok(CheckSchema, check({ kind: "after_task", at: null, taskId: "wt_aaaaaaaaaaaaaaaaaaab" }))).toBe(true);
    expect(ok(CheckSchema, check({ kind: "after_task", at: T1, taskId: "wt_aaaaaaaaaaaaaaaaaaab" }))).toBe(false);
    expect(ok(CheckSchema, check({ at: null }))).toBe(false);
  });

  it("say which measure only when a measure set them, and keep a count only then", () => {
    expect(ok(CheckSchema, check({ setBy: "measure", which: "first" }))).toBe(true);
    expect(ok(CheckSchema, check({ setBy: "measure", which: "first", counted: { n: 212, from: T0, to: T1, at: T1 } }))).toBe(true);
    expect(ok(CheckSchema, check({ setBy: "measure", which: null }))).toBe(false);
    expect(ok(CheckSchema, check({ which: "first" }))).toBe(false);
    expect(ok(CheckSchema, check({ counted: { n: 1, from: T0, to: T1, at: T1 } }))).toBe(false);
    expect(ok(CheckSchema, check({ setBy: "measure", which: "then", kind: "after_task", at: null, taskId: "wt_aaaaaaaaaaaaaaaaaaab" }))).toBe(false);
  });

  it("take a read only on a measure's check, and never on Done is the win", () => {
    const row = (over: Record<string, unknown>) => ({ action: "checked", kind: "date", at: T1, next: null, measureKind: null, which: null, counted: null, read: null, ...over });
    expect(ok(CheckRowSchema, row({}))).toBe(true);
    expect(ok(CheckRowSchema, row({ action: "read", read: "better", measureKind: "used", which: "first" }))).toBe(true);
    expect(ok(CheckRowSchema, row({ action: "read", read: "better" }))).toBe(false);
    expect(ok(CheckRowSchema, row({ action: "read", read: "same", measureKind: "done", which: "first" }))).toBe(false);
    expect(ok(CheckRowSchema, row({ action: "checked", read: "same", measureKind: "used", which: "first" }))).toBe(false);
  });
});

describe("tasks", () => {
  it("stay open while Done waits for its measure's read, and close otherwise", () => {
    expect(workTaskOpen({ status: "todo", check: null })).toBe(true);
    expect(workTaskOpen({ status: "done", check: null })).toBe(false);
    expect(workTaskOpen({ status: "dropped", check: { setBy: "measure" } })).toBe(false);
    expect(workTaskOpen({ status: "done", check: { setBy: "measure" } })).toBe(true);
    expect(workTaskOpen({ status: "done", check: { setBy: NINA } })).toBe(false);
  });

  it("hold together: closedAt with Done or Dropped, hasCheck with a check, an idea with its brand", () => {
    expect(ok(WorkTaskSchema, aStoredTask())).toBe(true);
    expect(ok(WorkTaskSchema, aStoredTask({ status: "done", open: false, closedAt: T1 }))).toBe(true);
    expect(ok(WorkTaskSchema, aStoredTask({ status: "done", open: false }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ closedAt: T1 }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ status: "done", open: true, closedAt: T1 }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ hasCheck: true }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ ideaId: "cmp_x" }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ ideaId: "cmp_x", ideaBrandId: "ten_lumen" }))).toBe(true);
    expect(ok(WorkTaskSchema, aStoredTask({ title: "" }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ title: "two\nlines" }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ title: "x".repeat(201) }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ description: "x".repeat(4001) }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ links: Array(21).fill({ url: "https://example.com" }) }))).toBe(false);
    expect(ok(WorkTaskSchema, aStoredTask({ typedLinks: Array(11).fill({ kind: "switch", none: "No switch." }) }))).toBe(false);
  });

  it("never block or wait for themselves, and keep a measure's check only with a measure that has one", () => {
    const t = aStoredTask();
    expect(ok(WorkTaskSchema, { ...t, blockedBy: [t.id] })).toBe(false);
    const measureCheck = { kind: "date", at: T1, taskId: null, note: "", setBy: "measure", setAt: T0, which: "first" };
    expect(ok(WorkTaskSchema, { ...t, check: measureCheck, hasCheck: true })).toBe(false);
    expect(ok(WorkTaskSchema, { ...t, check: measureCheck, hasCheck: true, measure: { kind: "done", ...set } })).toBe(false);
    expect(ok(WorkTaskSchema, { ...t, check: measureCheck, hasCheck: true, measure: { kind: "used", counts: { none: "" }, look: { days: 14 }, ...set } })).toBe(true);
  });
});

describe("decisions", () => {
  const decision = (over: Partial<WorkDecision> = {}): WorkDecision => ({
    question: "Which onboarding email goes first?",
    options: [
      { id: "a", label: "Welcome" },
      { id: "b", label: "Template tour" },
    ],
    recommended: { option: "b", by: { kind: "vizzy" }, reason: "People who open a template stay longer." },
    chosen: { option: "a", by: NINA },
    agreed: false,
    why: "Welcome first, as the team agreed.",
    replaces: null,
    plan: null,
    ...over,
  });

  it("take 2 to 4 options, a to d in order, and a choice among them", () => {
    expect(ok(DecisionSchema, decision())).toBe(true);
    expect(ok(DecisionSchema, decision({ options: [{ id: "a", label: "Only one" }] }))).toBe(false);
    expect(ok(DecisionSchema, decision({ options: [{ id: "a", label: "A" }, { id: "c", label: "C" }] }))).toBe(false);
    expect(ok(DecisionSchema, decision({ chosen: { option: "c", by: NINA } }))).toBe(false);
    expect(ok(DecisionSchema, decision({ recommended: { option: "d", by: { kind: "vizzy" }, reason: "x" } }))).toBe(false);
  });

  it("work agreed out from the pick and the choice", () => {
    expect(agreedOf(decision())).toBe(false);
    expect(agreedOf(decision({ chosen: { option: "b", by: NINA } }))).toBe(true);
    expect(agreedOf(decision({ recommended: null }))).toBeNull();
    expect(agreedOf(decision({ chosen: null }))).toBeNull();
    expect(ok(DecisionSchema, decision({ agreed: true }))).toBe(false);
    expect(ok(DecisionSchema, decision({ chosen: { option: "b", by: NINA }, agreed: true }))).toBe(true);
    expect(ok(DecisionSchema, decision({ recommended: null, agreed: null }))).toBe(true);
  });

  it("approve a plan only as Approve, Change it or Not now, tied to its url and version, with no recommendation", () => {
    const approval = (over: Partial<WorkDecision> = {}) =>
      decision({ question: PLAN_APPROVAL_QUESTION, options: [...PLAN_APPROVAL_OPTIONS], recommended: null, chosen: { option: "a", by: NINA }, agreed: null, why: null, plan: { url: "https://docs.example.com/p", version: "v1" }, ...over });
    expect(ok(DecisionSchema, approval())).toBe(true);
    expect(ok(DecisionSchema, approval({ recommended: { option: "a", by: { kind: "vizzy" }, reason: "Looks good." }, agreed: true }))).toBe(false);
    expect(ok(DecisionSchema, approval({ options: [{ id: "a", label: "Approve" }, { id: "b", label: "Reject" }] }))).toBe(false);
    expect(ok(DecisionSchema, approval({ question: "Approve it?" }))).toBe(false);
    expect(ok(DecisionSchema, approval({ plan: null }))).toBe(false);
    expect(ok(DecisionSchema, approval({ plan: { url: "http://docs.example.com/p" } }))).toBe(false);
    expect(isPlanApprovalQuestion("  approve   THE plan? ")).toBe(true);
    expect(isPlanApprovalQuestion("Approve the plan for launch")).toBe(false);
    expect(isPlanApprovalQuestion("Approve the plan?!.")).toBe(true);
  });

  it("reads a question of any length in time that grows with it, never more: a long run of marks can't stall the server", () => {
    const started = performance.now();
    expect(isPlanApprovalQuestion(`${"!".repeat(63_000)}x`)).toBe(false);
    expect(isPlanApprovalQuestion(`x${"!".repeat(63_000)}`)).toBe(false);
    expect(isPlanApprovalQuestion(`Approve the plan${"?".repeat(63_000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("log rows", () => {
  const base = { id: "wl_0123456789abcdef01234567", organisationId: "org_ten_lumen", brandId: "ten_lumen", region: "us", day: "2026-11-20", at: T0, source: { who: { kind: "person", id: NINA }, tool: "log_box", session: null } };
  it("are an entry, a change with before and after, a check or a decision, each on a real day", () => {
    expect(ok(WorkLogRowSchema, { ...base, kind: "entry", taskId: null, workstream: "Onboarding emails", state: "doing", note: "", links: [] })).toBe(true);
    expect(ok(WorkLogRowSchema, { ...base, kind: "entry", taskId: null, workstream: "x".repeat(81), state: "doing", note: "", links: [] })).toBe(false);
    expect(ok(WorkLogRowSchema, { ...base, kind: "entry", taskId: null, workstream: "Ok", state: "doing", note: "x".repeat(281), links: [] })).toBe(false);
    expect(ok(WorkLogRowSchema, { ...base, kind: "change", taskId: "wt_aaaaaaaaaaaaaaaaaaab", field: "status", before: "todo", after: "done" })).toBe(true);
    expect(ok(WorkLogRowSchema, { ...base, kind: "change", taskId: "wt_aaaaaaaaaaaaaaaaaaab", field: "colour", before: 1, after: 2 })).toBe(false);
    expect(ok(WorkLogRowSchema, { ...base, day: "2026-02-30", kind: "entry", taskId: null, workstream: "Ok", state: "doing", note: "", links: [] })).toBe(false);
  });
});

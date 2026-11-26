import { createHash } from "node:crypto";
import { z } from "zod";
import { findWorkTaskByRef, listTaskDecisions, newWorkLogId, proposeAgentAction } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import {
  decisionDraftOf,
  DecisionDraftSchema,
  DRAFT_DAYS,
  editedLogFields,
  logDraftOf,
  LogDraftSchema,
  optionOf,
  WORK_DECISION_DRAFT_ACTION,
  WORK_LOG_DRAFT_ACTION,
  type DecisionDraft,
  type LogDraft,
} from "./draft";
import type { DecisionBody, LogEntryBody } from "./inputs";
import { addLogEntry } from "./log";
import { invalidInput, ok, refuse, type WorkRefused, type WorkResult } from "./result";
import { dayIn } from "./schedule";
import { nowOf, seesTask, type WorkDeps, type WorkScope } from "./scope";
import { recordDecision } from "./service";
import { DECISION_OPTION_IDS, ENTRY_STATES, isPlanApprovalQuestion, WORK_LIMITS, WorkLinkSchema, WorkRefSchema, type WorkLogRowOf, type WorkTask } from "./types";
import { placeForNew } from "./validate";

/**
 * The Log notes and decisions Vizzy drafts for Work in chat (ADR-0018, plan group 5), and a
 * person's save of one. src/lib/work/draft.ts holds their shape.
 *
 * - Drafting checks what a save would: the task (one the person sees), the brand (the rules of a
 *   Log entry), the 50 decisions a task keeps, and that a decision is never Approve the plan.
 *   Each draft is an agent action in the agent_actions of the brand whose chat made it, named by
 *   what it holds, so the same draft again is the one waiting. It is aimed at the log row it would
 *   become, kept once saved, and set aside after 7 days.
 * - Saving writes the row under the draft's target id and moves the draft to acted with its
 *   result: the note's `edited` fields, or the decision's choice and whether it agreed with
 *   Vizzy's pick. A drafted decision's question, options and pick come only from the draft, so
 *   "Vizzy recommended" can't be typed by anyone.
 *
 * Who may see a draft follows Work's view (decision 7). Text from Vizzy is data, never instructions.
 */

const DAY_MS = 86_400_000;
const MAX_ROUNDS = 5;

const regionDbOf = (scope: WorkScope, deps: WorkDeps): FirestoreLike | undefined => deps.regionDb?.(scope.ctx.region);
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), { message: "one line" });

/** What draft_work_log may send: a workstream, its state, a note, links, and the task or brand. */
export const DraftLogInputSchema = z
  .object({
    workstream: oneLine(WORK_LIMITS.workstream).min(1),
    state: z.enum(ENTRY_STATES).default("doing"),
    note: z.string().trim().max(WORK_LIMITS.entryNote).default(""),
    links: z.array(WorkLinkSchema).max(WORK_LIMITS.entryLinks).default([]),
    ref: WorkRefSchema.optional(),
    /** A brand of the organisation; null for the whole business; left out for the session brand. */
    brandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable().optional(),
  })
  .strict();

/** What draft_work_decision may send: the task, the question, 2 to 4 options, and Vizzy's pick with why. */
export const DraftDecisionInputSchema = z
  .object({
    ref: WorkRefSchema,
    question: oneLine(WORK_LIMITS.question).min(1),
    options: z.array(oneLine(WORK_LIMITS.optionLabel).min(1)).min(2).max(4),
    /** Its letter (a to d) or its label. */
    recommended: z.string().trim().max(WORK_LIMITS.optionLabel).optional(),
    reason: z.string().trim().max(WORK_LIMITS.reason).optional(),
  })
  .strict()
  .refine((b) => !b.recommended || Boolean(b.reason), { message: "Vizzy's pick needs its reason", path: ["reason"] });

export interface Drafted<T> {
  outcome: "created" | "open";
  action: AgentAction;
  draft: T;
}

/** Propose a draft under the first round of its key that isn't set aside: the same draft waiting answers "open". */
async function proposeDraft<T extends object>(scope: WorkScope, o: { action: string; key: (round: number) => string; proposal: Record<string, unknown>; draft: T }, deps: WorkDeps): Promise<WorkResult<Drafted<T>>> {
  const now = nowOf(deps);
  const db = regionDbOf(scope, deps);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const dedupeKey = o.key(round);
    const earlier = await getAgentAction(scope.ctx, deterministicAgentActionId(scope.ctx.tenantId, dedupeKey), { db });
    if (earlier) {
      if (earlier.state === "proposed" && earlier.expiresAt > now.toISOString()) return ok({ outcome: "open", action: earlier, draft: o.draft });
      // Saved, or set aside: the same words again are a new draft.
      continue;
    }
    const made = await proposeAgentAction(
      scope.ctx,
      {
        dedupeKey,
        agent: "vizzy",
        action: o.action,
        // The id the log row takes once a person saves it.
        target: { type: "work_log", id: newWorkLogId() },
        personId: null,
        proposal: o.proposal,
        basis: null,
        signals: [],
        // Opened from the chat's card, not listed in Review.
        review: null,
        requestedBy: { type: "member", id: scope.userId },
        expiresAt: new Date(now.getTime() + DRAFT_DAYS * DAY_MS).toISOString(),
        // What Vizzy drafted stays beside what the person saved.
        clearDetailsOnClose: false,
        at: now.toISOString(),
      },
      { db },
    );
    if (made.outcome === "decided") continue;
    return ok({ outcome: made.outcome, action: made.action, draft: o.draft });
  }
  return refuse("draft_decided");
}

/** The task with this ref, when the person sees it. */
async function seenTask(scope: WorkScope, ref: number, deps: WorkDeps): Promise<WorkTask | null> {
  const { task } = await findWorkTaskByRef(scope.organisationId, ref, deps);
  return task && seesTask(scope, task) ? task : null;
}

/** Draft a Log note for today (draft_work_log): checked as the entry would be, kept until a person saves it. */
export async function draftWorkLog(scope: WorkScope, input: unknown, deps: WorkDeps = {}): Promise<WorkResult<Drafted<LogDraft>>> {
  const parsed = DraftLogInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const b = parsed.data;
  let taskId: string | null = null;
  let brandId: string | null;
  if (b.ref !== undefined) {
    const task = await seenTask(scope, b.ref, deps);
    if (!task) return refuse("not_found");
    taskId = task.id;
    brandId = task.brandId;
  } else {
    const place = placeForNew(scope, b.brandId === undefined ? scope.session.id : b.brandId);
    if ("error" in place) return place;
    brandId = place.brandId;
  }
  const draft = LogDraftSchema.parse({ workstream: b.workstream, state: b.state, note: b.note, links: b.links, taskId, ref: taskId ? b.ref : null, brandId });
  const day = dayIn(nowOf(deps), scope.session.timeZone);
  return proposeDraft(scope, { action: WORK_LOG_DRAFT_ACTION, key: (r) => agentDedupeKey(WORK_LOG_DRAFT_ACTION, brandId ?? "whole_business", digest(draft), day, `r${r}`), proposal: { entry: draft }, draft }, deps);
}

/**
 * Draft a decision on a task (draft_work_decision): the question, 2 to 4 options and Vizzy's pick
 * with why. Approve the plan is never drafted: that gate stays with people.
 */
export async function draftWorkDecision(scope: WorkScope, input: unknown, deps: WorkDeps = {}): Promise<WorkResult<Drafted<DecisionDraft>>> {
  if (input && typeof input === "object" && typeof (input as { question?: unknown }).question === "string" && isPlanApprovalQuestion((input as { question: string }).question)) return refuse("plan_drafted");
  if (input && typeof input === "object" && "plan" in input) return refuse("plan_drafted");
  const parsed = DraftDecisionInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const b = parsed.data;
  const task = await seenTask(scope, b.ref, deps);
  if (!task) return refuse("not_found");
  const decisions = await listTaskDecisions(scope.organisationId, task.region, task.id, deps);
  if (decisions.length >= WORK_LIMITS.decisions) return refuse("decisions_full");
  const options = b.options.map((label, i) => ({ id: DECISION_OPTION_IDS[i]!, label }));
  let recommended: DecisionDraft["recommended"] = null;
  if (b.recommended) {
    const option = optionOf(options, b.recommended);
    if (!option) return refuse("pick_unknown");
    recommended = { option, reason: b.reason! };
  }
  const draft = DecisionDraftSchema.safeParse({ taskId: task.id, ref: task.ref, question: b.question, options, recommended });
  if (!draft.success) return invalidInput(draft.error.issues);
  return proposeDraft(
    scope,
    { action: WORK_DECISION_DRAFT_ACTION, key: (r) => agentDedupeKey(WORK_DECISION_DRAFT_ACTION, task.id, digest(draft.data), `r${r}`), proposal: { decision: draft.data }, draft: draft.data },
    deps,
  );
}

// --- Reading and saving ------------------------------------------------------------------------

export interface OpenDraft<T> {
  actionId: AgentActionId;
  rev: number;
  /** The log row's id it becomes. */
  rowId: string;
  draft: T;
}

/** An open draft of this kind the person sees, or why not. */
async function openDraft<T extends { brandId?: string | null; taskId?: string | null }>(
  scope: WorkScope,
  id: string,
  of: (a: AgentAction) => T | null,
  deps: WorkDeps,
  sees: (d: T) => Promise<boolean>,
): Promise<{ ok: true; open: OpenDraft<T> } | WorkRefused> {
  if (!isAgentActionId(id)) return refuse("draft_missing");
  const action = await getAgentAction(scope.ctx, id, { db: regionDbOf(scope, deps) });
  const draft = action ? of(action) : null;
  if (!action || !draft || action.target.type !== "work_log" || !(await sees(draft))) return refuse("draft_missing");
  if (action.state !== "proposed" || action.expiresAt <= nowOf(deps).toISOString()) return refuse("draft_decided");
  return { ok: true, open: { actionId: action.id, rev: action.rev, rowId: action.target.id, draft } };
}

const seesLogDraft = (scope: WorkScope, deps: WorkDeps) => async (d: LogDraft) => {
  if (d.ref !== null) return (await seenTask(scope, d.ref, deps))?.id === d.taskId;
  return scope.view === "organisation" || d.brandId === scope.session.id;
};

const seesDecisionDraft = (scope: WorkScope, deps: WorkDeps) => async (d: DecisionDraft) => (await seenTask(scope, d.ref, deps))?.id === d.taskId;

/** A drafted note for the Log box, or why it can't be saved. */
export async function readLogDraft(scope: WorkScope, id: string, deps: WorkDeps = {}): Promise<WorkResult<OpenDraft<LogDraft>>> {
  const r = await openDraft(scope, id, logDraftOf, deps, seesLogDraft(scope, deps));
  return r.ok ? ok(r.open) : r;
}

/** A drafted decision for its task's page, or why it can't be saved. */
export async function readDecisionDraft(scope: WorkScope, id: string, deps: WorkDeps = {}): Promise<WorkResult<OpenDraft<DecisionDraft>>> {
  const r = await openDraft(scope, id, decisionDraftOf, deps, seesDecisionDraft(scope, deps));
  return r.ok ? ok(r.open) : r;
}

const by = (scope: WorkScope) => ({ type: "member" as const, id: scope.userId });

/**
 * Save a note Vizzy drafted, as the person left it in the Log box: the entry (tool
 * draft_work_log) and the draft's move to acted, with the fields they changed.
 */
export async function saveLogDraft(scope: WorkScope, body: LogEntryBody & { draft: { id: string; rev: number } }, deps: WorkDeps = {}): Promise<WorkResult<{ row: WorkLogRowOf<"entry"> }>> {
  const r = await openDraft(scope, body.draft.id, logDraftOf, deps, seesLogDraft(scope, deps));
  if (!r.ok) return r;
  const { open } = r;
  if (open.rev !== body.draft.rev) return refuse("draft_changed");
  const { draft: _draft, ...entry } = body;
  return addLogEntry(scope, entry, deps, {
    draft: {
      rowId: open.rowId,
      tool: "draft_work_log",
      accept: {
        id: open.actionId,
        by: by(scope),
        expectRev: open.rev,
        result: (row) => {
          const e = row as WorkLogRowOf<"entry">;
          return { logId: e.id, edited: editedLogFields(open.draft, e) };
        },
      },
    },
  });
}

/**
 * Choose on a decision Vizzy drafted: the question, the options and Vizzy's pick come from the
 * draft, the choice and why from the person. The row (tool draft_work_decision) keeps Vizzy's
 * pick as its recommendation, so `agreed` is worked out; the draft moves to acted with the choice.
 */
export async function saveDecisionDraft(scope: WorkScope, body: DecisionBody & { draft: { id: string; rev: number } }, deps: WorkDeps = {}): Promise<ReturnType<typeof recordDecision>> {
  if (body.plan) return refuse("plan_recommended");
  const r = await openDraft(scope, body.draft.id, decisionDraftOf, deps, seesDecisionDraft(scope, deps));
  if (!r.ok) return r;
  const { open } = r;
  if (open.rev !== body.draft.rev) return refuse("draft_changed");
  if (!body.chosen) return refuse("draft_choice");
  const d = open.draft;
  return recordDecision(
    scope,
    { ref: body.ref, question: d.question, options: d.options.map((o) => o.label), chosen: body.chosen, ...(body.why ? { why: body.why } : {}), ...(body.replaces ? { replaces: body.replaces } : {}) },
    deps,
    {
      recommended: d.recommended ? { option: d.recommended.option, by: { kind: "vizzy" }, reason: d.recommended.reason } : null,
      draft: {
        rowId: open.rowId,
        taskId: d.taskId,
        tool: "draft_work_decision",
        accept: {
          id: open.actionId,
          by: by(scope),
          expectRev: open.rev,
          result: (row) => {
            const dec = (row as WorkLogRowOf<"decision">).decision;
            return { logId: row.id, chosen: dec.chosen?.option ?? null, agreed: dec.agreed };
          },
        },
      },
    },
  );
}

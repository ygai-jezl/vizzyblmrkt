import { createHash } from "node:crypto";
import { newWorkTaskId, proposeAgentAction, transitionAgentAction } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { forgetReviewCount } from "@/lib/review/summary";
import { agentDedupeKey, SignalRefSchema, type AgentAction, type AgentActionId, type DeclineWhy, type SignalRef } from "@/lib/types/agentAction";
import type { Made } from "@/lib/types/loopStamp";
import type { AddTaskBody } from "./inputs";
import { ok, refuse, type WorkRefused, type WorkResult } from "./result";
import { brandForTask, mapLimit, nowOf, type WorkDeps, type WorkScope } from "./scope";
import { addTaskWith, type ChangeDone } from "./service";
import {
  addBodyOf,
  againAfter,
  dismissedLine,
  editedFields,
  editThenAddHref,
  NOT_NOW_DAYS,
  seesSuggestion,
  SUGGESTION_DAYS,
  SuggestedTaskSchema,
  suggestionOf,
  WORK_SUGGEST_ACTION,
  type SuggestedTask,
} from "./suggestion";
import { WORK_LIMITS, WORK_TASK_ID, type WorkOrigin, type WorkTask } from "./types";
import { checkMeasure, checkTypedLinks, placeForNew } from "./validate";

/**
 * Vizzy's task suggestions for Work (ADR-0020, plan decisions 6 and 10.1 and 10.2): making one,
 * and a person's Add to Work, Edit then add or Dismiss in Review. Each suggestion is an agent
 * action in the agent_actions of the brand whose chat made it (src/lib/tenant/agentActions.ts is
 * its only writer); src/lib/work/suggestion.ts holds its shape.
 *
 * - Making one (Vizzy's suggest_work_task, group 5) checks it as an add would be checked, in the
 *   session brand's region, and names it by its brand, a hash of its title and a round. A person's
 *   Not now lets the same suggestion back after 30 days, under the next round; any other reason, or
 *   none, keeps it away; one set aside by nobody (expired, stale or superseded) may come back at once.
 *   The same round made in the chat of any brand the person sees counts too, read in that brand's
 *   own region, so a whole business suggestion dismissed in one brand's chat stays away from the
 *   others'.
 * - Add to Work and Edit then add write the task (its origin names the suggestion, with the
 *   evidence) and the suggestion's result in ONE transaction, so the region must be the session
 *   brand's; the task takes the suggestion's target id. Ticking Must have isn't an edit.
 * - Dismiss declines with "dismissed" and the reason the person tapped, if any.
 *
 * Who may see a suggestion follows Work's view (decision 7). Every decision forgets the brand's
 * cached Review count. Text from Vizzy is data shown as written, never instructions.
 */

/** How many times the same suggestion may come back under a new round. */
const MAX_ROUNDS = 12;
const DAY_MS = 86_400_000;

const regionDbOf = (scope: WorkScope, deps: WorkDeps): FirestoreLike | undefined => deps.regionDb?.(scope.ctx.region);

/** A title as the dedupe key reads it: lower case, words only. */
export function titleKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return createHash("sha256").update(words).digest("hex").slice(0, 32);
}

/** The dedupe key of round `round` of a suggestion for a brand (or the whole business) with this title. */
export function suggestionKey(s: Pick<SuggestedTask, "brandId" | "title">, round: number): string {
  return agentDedupeKey(WORK_SUGGEST_ACTION, s.brandId ?? "whole_business", titleKey(s.title), `r${round}`);
}

/**
 * What an earlier round of the same suggestion means for a new one:
 * - "open": still waiting in Review (proposed, not past its expiry);
 * - "next": set aside, so a new round may be made: expired, stale or superseded, past its expiry
 *   while the sweep hasn't declined it yet, or Not now at least 30 days ago;
 * - "later": Not now less than 30 days ago, with the day it may come back;
 * - "decided": added (acted or undone), or dismissed with any other reason or none.
 */
export function roundAfter(a: Pick<AgentAction, "state" | "expiresAt" | "declined" | "decidedAt">, now: Date): { is: "open" | "next" | "decided" } | { is: "later"; again: string } {
  if (a.state === "proposed" || a.state === "approved") return a.expiresAt > now.toISOString() ? { is: "open" } : { is: "next" };
  if (a.state === "acted" || a.state === "undone") return { is: "decided" };
  if (a.declined?.reason !== "dismissed") return { is: "next" };
  if (a.declined.why !== "not_now") return { is: "decided" };
  const again = new Date(Date.parse(a.decidedAt ?? now.toISOString()) + NOT_NOW_DAYS * DAY_MS).toISOString();
  return again <= now.toISOString() ? { is: "next" } : { is: "later", again };
}

export interface ProposeInput {
  /** What Vizzy suggests; never Must have. */
  task: unknown;
  /** What it was based on, as signal refs: up to 10 are kept on the task's origin. */
  evidence?: readonly SignalRef[];
  /**
   * What made it: Vizzy's route reads it under vizzy_chat, scope work_task (learning loops step 5).
   * Kept only with LOOPS_ENABLED on (keptMade, in proposeAgentAction), so a person's Add to Work,
   * Edit then add or Dismiss counts once against it where the suggestion closes.
   */
  made?: Made;
}

export type ProposeDone =
  | { outcome: "created" | "open"; action: AgentAction }
  /** The same suggestion was added, or dismissed for a reason that keeps it away. */
  | { outcome: "decided"; action: AgentAction | null }
  /** Dismissed with Not now: it may come back on `again`. */
  | { outcome: "later"; action: AgentAction; again: string };

/**
 * Make a Vizzy suggestion for Work, checked as an add would be: the brand (the session brand's own
 * in the brand view, the whole business only for those who see it), the session brand's region,
 * the typed links and the measure. Origin, the dedupe key, the target id, the Review link and the
 * expiry are set here; details are kept when decided.
 */
export async function proposeWorkSuggestion(scope: WorkScope, input: ProposeInput, deps: WorkDeps = {}): Promise<WorkResult<ProposeDone>> {
  const now = nowOf(deps);
  if (input.task && typeof input.task === "object" && "mustHave" in input.task) return refuse("suggestion_must_have");
  const parsed = SuggestedTaskSchema.safeParse(input.task);
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_input", message: "Vizzy's suggestion isn't one Work can keep.", issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join("."), message: i.message })) };
  const task = parsed.data;
  const place = placeForNew(scope, task.brandId);
  if ("error" in place) return place;
  if (place.region !== scope.session.region) return refuse("suggestion_other_region");
  const brand = brandForTask(scope, { brandId: place.brandId });
  const links = await checkTypedLinks(scope, task.typedLinks, { brand, current: [] }, deps);
  if (!links.ok) return links;
  if (task.measure) {
    const m = await checkMeasure(
      scope,
      task.measure,
      { title: task.title, description: task.description, stage: task.stage, brandId: place.brandId, ideaId: null, typedLinks: links.links, brand, current: null },
      deps,
      now,
    );
    if (!m.ok) return m;
  }
  const evidence: SignalRef[] = [];
  for (const e of (input.evidence ?? []).slice(0, WORK_LIMITS.evidence)) {
    const r = SignalRefSchema.safeParse(e);
    if (r.success) evidence.push(r.data as SignalRef);
  }

  const db = regionDbOf(scope, deps);
  const stored = { ...task, brandId: place.brandId, typedLinks: links.links };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const key = suggestionKey(stored, round);
    const id = deterministicAgentActionId(scope.ctx.tenantId, key);
    const earlier = await sameRound(scope, key, deps);
    if (earlier.length) {
      // Waiting anywhere is waiting; then a dismissal that keeps it away; then Not now's day.
      const reads = earlier.map((a) => ({ a, r: roundAfter(a, now) }));
      const open = reads.find((x) => x.r.is === "open");
      if (open) return ok({ outcome: "open", action: open.a });
      const decided = reads.find((x) => x.r.is === "decided");
      if (decided) return ok({ outcome: "decided", action: decided.a });
      const later = reads
        .flatMap((x) => (x.r.is === "later" ? [{ a: x.a, again: x.r.again }] : []))
        .sort((x, y) => y.again.localeCompare(x.again))[0];
      if (later) return ok({ outcome: "later", action: later.a, again: later.again });
      continue;
    }
    const made = await proposeAgentAction(
      scope.ctx,
      {
        dedupeKey: key,
        agent: "vizzy",
        action: WORK_SUGGEST_ACTION,
        // The id the task takes once a person adds it.
        target: { type: "work_task", id: newWorkTaskId() },
        personId: null,
        proposal: { task: stored },
        basis: null,
        signals: evidence,
        review: { kind: "work_suggestion", href: editThenAddHref(id) },
        requestedBy: { type: "member", id: scope.userId },
        expiresAt: new Date(now.getTime() + SUGGESTION_DAYS * DAY_MS).toISOString(),
        // The pair (what Vizzy proposed, the task as added or why it was dismissed) is the label a
        // later edits learner reads, so it outlives the decision.
        clearDetailsOnClose: false,
        ...(input.made ? { made: input.made } : {}),
        at: now.toISOString(),
      },
      { db },
    );
    if (made.outcome === "created") forgetReviewCount(scope.ctx.tenantId);
    if (made.outcome === "decided") return ok({ outcome: "decided", action: made.action });
    return ok({ outcome: made.outcome, action: made.action });
  }
  return ok({ outcome: "decided", action: null });
}

/**
 * The same round of a suggestion in the agent_actions of every brand the person sees, the session
 * brand first: each brand's id is deterministic, so one read by id each, in the brand's region.
 * Another brand that can't be read is left out; the session brand's own read failing throws, as
 * it always did.
 */
async function sameRound(scope: WorkScope, key: string, deps: WorkDeps): Promise<AgentAction[]> {
  const found = await mapLimit(scope.brands, 5, async (b) => {
    if (b.id === scope.ctx.tenantId) return getAgentAction(scope.ctx, deterministicAgentActionId(b.id, key), { db: regionDbOf(scope, deps) });
    try {
      return await getAgentAction({ tenantId: b.id, region: b.region, source: "system" }, deterministicAgentActionId(b.id, key), { db: deps.regionDb?.(b.region) });
    } catch {
      return null;
    }
  });
  return found.filter((a): a is AgentAction => a !== null);
}

// --- A person's decision -----------------------------------------------------------------------

interface Open {
  action: AgentAction;
  suggestion: SuggestedTask;
}

/** An open Work suggestion this person sees, or why not. */
async function openSuggestion(scope: WorkScope, id: AgentActionId, deps: WorkDeps): Promise<{ ok: true; open: Open } | WorkRefused> {
  const action = await getAgentAction(scope.ctx, id, { db: regionDbOf(scope, deps) });
  const suggestion = action ? suggestionOf(action) : null;
  if (!action || !suggestion || !seesSuggestion(scope, suggestion) || !WORK_TASK_ID.test(action.target.id) || action.target.type !== "work_task") return refuse("suggestion_missing");
  if (action.state !== "proposed" || action.expiresAt <= nowOf(deps).toISOString()) return refuse("suggestion_decided");
  return { ok: true, open: { action, suggestion } };
}

/** What Edit then add fills the add page with, from an open suggestion. */
export interface SuggestionForForm {
  actionId: AgentActionId;
  rev: number;
  suggestion: SuggestedTask;
}

export async function suggestionForForm(scope: WorkScope, id: AgentActionId, deps: WorkDeps = {}): Promise<WorkResult<SuggestionForForm>> {
  const r = await openSuggestion(scope, id, deps);
  if (!r.ok) return r;
  return ok({ actionId: r.open.action.id, rev: r.open.action.rev, suggestion: r.open.suggestion });
}

/** The task as added, for the suggestion's result: what an edits learner compares with the proposal. */
function resultTaskOf(t: WorkTask): Record<string, unknown> {
  return {
    id: t.id,
    ref: t.ref,
    title: t.title,
    description: t.description,
    status: t.status,
    stage: t.stage,
    brandId: t.brandId,
    mustHave: t.mustHave,
    typedLinks: t.typedLinks,
    measure: t.measure,
  };
}

export interface AddedFromSuggestion extends ChangeDone {
  /** The fields the person changed from what Vizzy suggested; empty for Add to Work. */
  edited: string[];
}

/**
 * Add to Work (no task: as Vizzy suggested it) or Edit then add (the task as the person sent it
 * from the add page). The origin names the suggestion and keeps its evidence; the measure keeps
 * the kind Vizzy proposed beside the one picked. The task and the suggestion's result are written
 * in one transaction.
 */
export async function addSuggestion(scope: WorkScope, input: { actionId: AgentActionId; rev: number; task?: AddTaskBody }, deps: WorkDeps = {}): Promise<WorkResult<AddedFromSuggestion>> {
  const r = await openSuggestion(scope, input.actionId, deps);
  if (!r.ok) return r;
  const { action, suggestion } = r.open;
  if (action.rev !== input.rev) return refuse("suggestion_changed");
  const body = input.task ?? addBodyOf(suggestion);
  const edited = input.task ? editedFields(suggestion, body) : [];
  const origin: WorkOrigin = { kind: "suggestion", agent: "vizzy", agentActionId: action.id, evidence: action.signals.slice(0, WORK_LIMITS.evidence), by: scope.userId };
  const added = await addTaskWith(scope, body, origin, deps, {
    id: action.target.id,
    tool: input.task ? "review_edit" : "review_add",
    suggestion: {
      ...(suggestion.proposed ? { proposed: { ...suggestion.proposed, by: "vizzy" as const } } : {}),
      accept: { id: action.id, by: { type: "member", id: scope.userId }, expectRev: input.rev, result: (task) => ({ task: resultTaskOf(task), edited }) },
    },
  });
  if (!added.ok) return added;
  forgetReviewCount(scope.ctx.tenantId);
  return ok({ ...added.value, edited }, 201);
}

/** Dismiss a suggestion, with the reason the person tapped (or none), keeping what Vizzy proposed. */
export async function dismissSuggestion(
  scope: WorkScope,
  input: { actionId: AgentActionId; rev: number; why?: DeclineWhy },
  deps: WorkDeps = {},
): Promise<WorkResult<{ again: "30_days" | "never"; line: string }>> {
  const r = await openSuggestion(scope, input.actionId, deps);
  if (!r.ok) return r;
  const { action, suggestion } = r.open;
  if (action.rev !== input.rev) return refuse("suggestion_changed");
  const moved = await transitionAgentAction(
    scope.ctx,
    action.id,
    { to: "declined", reason: "dismissed", ...(input.why ? { why: input.why } : {}), by: { type: "member", id: scope.userId }, at: nowOf(deps).toISOString(), expectRev: input.rev, clearDetails: false },
    { db: regionDbOf(scope, deps) },
  );
  if (!moved.ok) return refuse(moved.error === "changed" ? "suggestion_changed" : moved.error === "not_found" ? "suggestion_missing" : "suggestion_decided");
  forgetReviewCount(scope.ctx.tenantId);
  return ok({ again: againAfter(input.why), line: dismissedLine(suggestion.title, input.why) });
}

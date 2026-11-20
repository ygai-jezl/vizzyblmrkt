import { forTenant, TENANT_FIELD } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type { DocRefLike, FirestoreLike, TenantContext, TransactionLike } from "./types";
import {
  blankLimit,
  checkUserFieldId,
  pageHistory,
  prepareEventsTx,
  prepareTrailEvent,
  regionalStoreFor,
  retryOnceOnExists,
  stageAgentEventTx,
  type BlankOptions,
  type BlankResult,
} from "./ontologyEvents";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { AGENT_TARGET_TYPES, isCanonicalInstant, jsonBytes, type AgentTarget, type EventActor } from "@/lib/ontology/events";
import type { ContactPersonId } from "@/lib/ontology/person";
import type { ReviewKind } from "@/lib/review/summary";
import type { EventWrite, StoredEvent } from "@/lib/types/ontologyEvent";
import {
  AGENT_ACTION_LIMITS,
  AgentActionSchema,
  canTransition,
  FIELD_VALUES_KEY,
  TERMINAL_FOR_DETAILS,
  type AgentAction,
  type AgentActionId,
  type AgentActionState,
  type AgentName,
  type DeclineReason,
  type SignalRef,
} from "@/lib/types/agentAction";

/**
 * Agent actions (agent_actions, the brand's regional database): one record per suggestion, its
 * only writer. Every state change appends exactly one agent.* row to the event history in the
 * same transaction (proposed straight to acted appends two: approved, then acted 1 ms later, so
 * newest first reads right). Mode is "suggest" only.
 *
 * A dedupe key names one suggestion: proposing it again writes nothing and answers "open" (still
 * proposed or approved) or "decided" (acted, undone or declined). A caller that wants to raise
 * something again after a decision uses a new key (see agentDedupeKey).
 *
 * The transaction helpers (readAgentActionTx, planAgentTransition, stageAgentTransition) are for
 * other modules in src/lib/tenant only, like B2a's field writes, so a field change and the
 * action's decision commit together. They are not exported from @/lib/tenant.
 */

export const AGENT_ACTIONS = "agent_actions";

export interface AgentProposal {
  /** Names the suggestion (agentDedupeKey): the record's id is a hash of it and the brand. */
  dedupeKey: string;
  agent: AgentName;
  /** e.g. "person_fields.suggest". */
  action: string;
  target: AgentTarget;
  /** Equals target.id for a person target. */
  personId: ContactPersonId | null;
  /** Only when the suggestion is about one product user's own data; null for a person target. */
  productUserId?: string | null;
  proposal: Record<string, unknown> | null;
  basis: Record<string, unknown> | null;
  fieldIds?: string[];
  signals: SignalRef[];
  draft?: { kind: string; ref: string } | null;
  review: { kind: ReviewKind; href: string } | null;
  requestedBy: EventActor;
  /** Required: at most 90 days after `at`. */
  expiresAt: string;
  /** Clear proposal and basis in the same commit as an acted or declined decision. */
  clearDetailsOnClose?: boolean;
  /** When it was proposed (canonical). */
  at: string;
}

export interface AgentTransition {
  to: "approved" | "acted" | "undone" | "declined";
  by: EventActor;
  at: string;
  /** Refuse with "changed" unless the record is still at this rev. */
  expectRev?: number;
  result?: Record<string, unknown> | null;
  undo?: { before: Record<string, unknown> } | null;
  /** Required for declined. */
  reason?: DeclineReason;
  /** Clear proposal and basis with an acted or declined decision, whatever the record says. */
  clearDetails?: boolean;
}

export type TransitionError = "not_found" | "wrong_state" | "changed";

export interface AgentTransitionOk {
  ok: true;
  current: AgentAction;
  /** The fields to update on the record. */
  patch: Partial<AgentAction>;
  next: AgentAction;
  /** One agent.* row per step. */
  events: EventWrite[];
}
export type AgentTransitionPlan = AgentTransitionOk | { ok: false; error: TransitionError; state?: AgentActionState };

const DAY_MS = 86_400_000;

function actionRef(store: FirestoreLike, id: string): DocRefLike {
  return store.collection(AGENT_ACTIONS).doc(id);
}

function invalid(message: string): never {
  throw new TenantValidationError(`bad_agent_action:${message}`);
}

/** The first problem zod found, by field and rule, never the value. */
function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.map(String).join(".")}:${issue.message}` : "invalid";
}

/** The agent.* row for one step. */
function trailEvent(a: AgentAction, step: AgentActionState, rev: number, at: string, by: EventActor, reason?: DeclineReason): EventWrite {
  return {
    key: `agent|${a.id}|${rev}`,
    kind: `agent.${step}`,
    at,
    subject: { type: "agent_action", id: a.id },
    personId: a.personId,
    productUserId: a.productUserId,
    agentActionId: a.id,
    source: { system: "agent" },
    actor: by,
    properties: {
      agentActionId: a.id,
      agent: a.agent,
      action: a.action,
      target: a.target,
      state: step,
      ...(reason ? { reason } : {}),
      ...(a.draft ? { draft: a.draft } : {}),
    },
  };
}

// --- Proposing ---------------------------------------------------------------------------------

/**
 * Record an agent's suggestion and its agent.proposed row, once per dedupe key. A key already
 * used answers with the record as it is: "open" while proposed or approved, "decided" once acted,
 * undone or declined, and writes nothing.
 */
export async function proposeAgentAction(
  ctx: TenantContext,
  p: AgentProposal,
  opts: { db?: FirestoreLike } = {},
): Promise<{ action: AgentAction; outcome: "created" | "open" | "decided" }> {
  if (!(AGENT_TARGET_TYPES as readonly string[]).includes(p.target?.type)) invalid("target:unknown target type");
  if (!isCanonicalInstant(p.at)) invalid("at:not canonical");
  if (!isCanonicalInstant(p.expiresAt)) invalid("expiresAt:not canonical");
  const span = Date.parse(p.expiresAt) - Date.parse(p.at);
  if (span <= 0 || span > AGENT_ACTION_LIMITS.maxExpiryDays * DAY_MS) invalid("expiresAt:after at and at most 90 days on");
  const id = deterministicAgentActionId(ctx.tenantId, p.dedupeKey);
  const candidate = {
    id,
    tenantId: ctx.tenantId,
    dedupeKey: p.dedupeKey,
    agent: p.agent,
    action: p.action,
    mode: "suggest",
    target: { type: p.target.type, id: p.target.id },
    targetKey: `${p.target.type}:${p.target.id}`,
    personId: p.personId,
    productUserId: p.productUserId ?? null,
    state: "proposed",
    rev: 1,
    proposal: p.proposal,
    basis: p.basis,
    fieldIds: p.fieldIds ?? [],
    signals: p.signals,
    draft: p.draft ?? null,
    review: p.review,
    requestedBy: p.requestedBy,
    decidedBy: null,
    decidedAt: null,
    actedBy: null,
    actedAt: null,
    result: null,
    undo: null,
    undoneBy: null,
    undoneAt: null,
    declined: null,
    expiresAt: p.expiresAt,
    clearDetailsOnClose: p.clearDetailsOnClose ?? false,
    detailsClearedAt: null,
    blankedFieldIds: [],
    createdAt: p.at,
    updatedAt: p.at,
  };
  const parsed = AgentActionSchema.safeParse(candidate);
  if (!parsed.success) invalid(firstIssue(parsed.error));
  const record = parsed.data as AgentAction;
  const store = regionalStoreFor(ctx, opts.db);
  const ref = actionRef(store, id);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn) => {
      const existing = await readAgentActionTx(txn, store, ctx, id);
      if (existing) return { action: existing, outcome: existing.state === "proposed" || existing.state === "approved" ? "open" : "decided" };
      const event = trailEvent(record, "proposed", 1, p.at, { type: "agent", id: p.agent });
      // Read phase: the trail row too, so a stray row at its key surfaces here, not at commit.
      const { fresh } = await prepareEventsTx(txn, store, ctx, [event]);
      const { id: _id, ...data } = record;
      txn.create(ref, { ...data, [TENANT_FIELD]: ctx.tenantId });
      for (const e of fresh) stageAgentEventTx(txn, store, ctx, e, p.at);
      return { action: record, outcome: "created" as const };
    }),
  );
}

// --- Transitions -------------------------------------------------------------------------------

/** Read one action in the caller's read phase, checked and parsed. Null when there is none. */
export async function readAgentActionTx(txn: TransactionLike, store: FirestoreLike, ctx: TenantContext, id: AgentActionId): Promise<AgentAction | null> {
  const snap = await txn.get(actionRef(store, id));
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${AGENT_ACTIONS}/${id} belongs to another tenant`);
  const parsed = AgentActionSchema.safeParse({ ...data, id: snap.id });
  if (!parsed.success) throw new TenantValidationError(`bad_stored_agent_action:${firstIssue(parsed.error)}`);
  return parsed.data as AgentAction;
}

/**
 * Plan a move, purely: not_found, changed (expectRev differs) or wrong_state, else the patch and
 * one agent.* row per step. Proposed to acted is two steps, approved at `at` and acted 1 ms later.
 * An acted or declined end clears proposal and basis when asked (clearDetails) or when the record
 * says so (clearDetailsOnClose), so typed details never outlive the decision. Throws for a decline
 * with no reason, a bad time, or a result or undo over 64 KB.
 */
export function planAgentTransition(current: AgentAction | null, t: AgentTransition): AgentTransitionPlan {
  if (!current) return { ok: false, error: "not_found" };
  if (t.expectRev != null && t.expectRev !== current.rev) return { ok: false, error: "changed", state: current.state };
  if (!canTransition(current.state, t.to)) return { ok: false, error: "wrong_state", state: current.state };
  if (t.to === "declined" && !t.reason) invalid("reason:a decline needs a reason");
  if (!isCanonicalInstant(t.at)) invalid("at:not canonical");
  if (t.result != null && jsonBytes(t.result) > AGENT_ACTION_LIMITS.resultBytes) invalid("result:over 64 KB");
  if (t.undo != null && jsonBytes(t.undo) > AGENT_ACTION_LIMITS.undoBytes) invalid("undo:over 64 KB");

  const steps: Array<{ state: AgentActionState; at: string }> =
    current.state === "proposed" && t.to === "acted"
      ? [
          { state: "approved", at: t.at },
          { state: "acted", at: new Date(Date.parse(t.at) + 1).toISOString() },
        ]
      : [{ state: t.to, at: t.at }];
  const last = steps[steps.length - 1]!;
  const patch: Partial<AgentAction> = { state: t.to, rev: current.rev + steps.length, updatedAt: last.at };
  for (const step of steps) {
    if (step.state === "approved" || step.state === "declined") {
      patch.decidedBy = t.by;
      patch.decidedAt = step.at;
    }
    if (step.state === "declined") patch.declined = { reason: t.reason! };
    if (step.state === "acted") {
      patch.actedBy = t.by;
      patch.actedAt = step.at;
      patch.result = t.result ?? null;
      patch.undo = t.undo ?? null;
    }
    if (step.state === "undone") {
      patch.undoneBy = t.by;
      patch.undoneAt = step.at;
    }
  }
  if ((TERMINAL_FOR_DETAILS as readonly string[]).includes(t.to) && (t.clearDetails || current.clearDetailsOnClose)) {
    patch.proposal = null;
    patch.basis = null;
    patch.detailsClearedAt = last.at;
  }
  const events = steps.map((step, i) => trailEvent(current, step.state, current.rev + i + 1, step.at, t.by, step.state === "declined" ? t.reason : undefined));
  return { ok: true, current, patch, next: { ...current, ...patch }, events };
}

/** The write phase of a planned move: the record's update and its rows. Writes only. */
export function stageAgentTransition(txn: TransactionLike, store: FirestoreLike, ctx: TenantContext, plan: AgentTransitionOk): StoredEvent[] {
  if (plan.current.tenantId !== ctx.tenantId) throw new TenantIsolationError("an agent action planned for another brand");
  const { id: _i, tenantId: _t, createdAt: _c, ...patch } = plan.patch;
  txn.update(actionRef(store, plan.current.id), patch);
  return plan.events.map((e) => stageAgentEventTx(txn, store, ctx, prepareTrailEvent(ctx, e), e.at));
}

/** Move one action and append its row(s), in one transaction. */
export async function transitionAgentAction(
  ctx: TenantContext,
  id: AgentActionId,
  t: AgentTransition,
  opts: { db?: FirestoreLike } = {},
): Promise<{ ok: true; action: AgentAction; events: StoredEvent[] } | { ok: false; error: TransitionError; state?: AgentActionState }> {
  const store = regionalStoreFor(ctx, opts.db);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn) => {
      const plan = planAgentTransition(await readAgentActionTx(txn, store, ctx, id), t);
      if (!plan.ok) return plan;
      const events = stageAgentTransition(txn, store, ctx, plan);
      return { ok: true as const, action: plan.next, events };
    }),
  );
}

// --- Minimising and expiring -------------------------------------------------------------------

/**
 * Clear an action's proposal and basis now, keeping its state and rev, with no row: data
 * minimisation, not a decision (a manual or repair clear; the normal clear happens with the
 * decision through clearDetailsOnClose). False when there is no such action.
 */
export async function clearAgentActionDetails(ctx: TenantContext, id: AgentActionId, opts: { at: string; db?: FirestoreLike }): Promise<boolean> {
  if (!isCanonicalInstant(opts.at)) invalid("at:not canonical");
  const store = regionalStoreFor(ctx, opts.db);
  return store.runTransaction(async (txn) => {
    const current = await readAgentActionTx(txn, store, ctx, id);
    if (!current) return false;
    txn.update(actionRef(store, id), { proposal: null, basis: null, detailsClearedAt: opts.at });
    return true;
  });
}

export const EXPIRE_PAGE = { default: 100, max: 300 } as const;

/**
 * Decline every proposed action past its expiry, whatever its agent, with reason "expired", by
 * the system. A row that moved meanwhile counts as changed. Not wired here: each proposing
 * consumer calls it from the lifecycle tick behind its own switch (two calls are harmless).
 */
export async function expireAgentActions(
  ctx: TenantContext,
  opts: { now: string; limit?: number; db?: FirestoreLike },
): Promise<{ declined: number; changed: number; more: boolean }> {
  if (!isCanonicalInstant(opts.now)) invalid("now:not canonical");
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? EXPIRE_PAGE.default)), EXPIRE_PAGE.max);
  const due = await forTenant(ctx, opts.db).agentActions.find({
    where: [
      ["state", "==", "proposed"],
      ["expiresAt", "<=", opts.now],
    ],
    orderBy: [["expiresAt", "asc"]],
    limit,
  });
  const out = { declined: 0, changed: 0, more: due.length === limit };
  for (const a of due) {
    const r = await transitionAgentAction(
      ctx,
      a.id,
      { to: "declined", reason: "expired", by: { type: "system", id: "agent_action_expiry" }, at: opts.now, expectRev: a.rev },
      { db: opts.db },
    );
    if (r.ok) out.declined += 1;
    else out.changed += 1;
  }
  return out;
}

// --- Blanking an erased field ------------------------------------------------------------------

/** The paths under which an action holds a field's value, by field id. */
function fieldPaths(fieldId: string): Array<[parent: "proposal" | "basis" | "result" | "undo", child: string, path: string]> {
  return [
    ["proposal", FIELD_VALUES_KEY, `proposal.${FIELD_VALUES_KEY}.${fieldId}`],
    ["basis", FIELD_VALUES_KEY, `basis.${FIELD_VALUES_KEY}.${fieldId}`],
    ["result", FIELD_VALUES_KEY, `result.${FIELD_VALUES_KEY}.${fieldId}`],
    ["undo", "before", `undo.before.${fieldId}`],
  ];
}

function holds(data: Record<string, unknown>, parent: string, child: string, fieldId: string): boolean {
  const p = data[parent];
  if (!p || typeof p !== "object") return false;
  const c = (p as Record<string, unknown>)[child];
  return !!c && typeof c === "object" && Object.prototype.hasOwnProperty.call(c, fieldId);
}

/**
 * Blank an erased field in the actions that hold it, a page at a time: only the paths that exist
 * among proposal.fields.<id>, basis.fields.<id>, result.fields.<id> and undo.before.<id> become
 * null, and the id moves from fieldIds to blankedFieldIds, so the query and the count then see
 * only actions still to blank and a resumed run picks up where it stopped. Refuses a system field
 * id. A dry run counts and writes nothing.
 */
export async function blankFieldInAgentActions(ctx: TenantContext, fieldId: string, opts: BlankOptions): Promise<BlankResult> {
  checkUserFieldId(fieldId);
  if (!isCanonicalInstant(opts.nowIso)) invalid("nowIso:not canonical");
  const limit = blankLimit(opts.limit);
  const store = regionalStoreFor(ctx, opts.db);
  const page = await pageHistory(store, ctx, "agentActions", {
    where: [["fieldIds", "array-contains", fieldId]],
    fields: ["fieldIds"],
    after: opts.startAfter ?? null,
    limit,
  });
  const out: BlankResult = { scanned: page.rows.length, blanked: 0, already: 0, gone: 0, last: page.last, more: page.more };
  if (opts.dryRun) return { ...out, blanked: page.rows.length };
  if (page.rows.length === 0) return out;
  const counts = await store.runTransaction(async (txn) => {
    const c = { blanked: 0, already: 0, gone: 0 };
    const refs = page.rows.map((r) => actionRef(store, r.id));
    const snaps = await Promise.all(refs.map((ref) => txn.get(ref)));
    const writes: Array<[DocRefLike, Record<string, unknown>]> = [];
    snaps.forEach((snap, i) => {
      if (!snap.exists) {
        c.gone += 1;
        return;
      }
      const data = snap.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${AGENT_ACTIONS}/${refs[i]!.id} belongs to another tenant`);
      const fieldIds = Array.isArray(data.fieldIds) ? (data.fieldIds as string[]) : [];
      if (!fieldIds.includes(fieldId)) {
        c.already += 1;
        return;
      }
      const patch: Record<string, unknown> = {};
      for (const [parent, child, path] of fieldPaths(fieldId)) if (holds(data, parent, child, fieldId)) patch[path] = null;
      const blanked = Array.isArray(data.blankedFieldIds) ? (data.blankedFieldIds as string[]) : [];
      patch.fieldIds = fieldIds.filter((f) => f !== fieldId);
      patch.blankedFieldIds = blanked.includes(fieldId) ? blanked : [...blanked, fieldId];
      writes.push([refs[i]!, patch]);
    });
    for (const [ref, patch] of writes) {
      txn.update(ref, patch);
      c.blanked += 1;
    }
    return c;
  });
  return { ...out, ...counts };
}

/** How many of this brand's actions still hold the field (array-contains on fieldIds). */
export async function countFieldAgentActions(ctx: TenantContext, fieldId: string, opts: { db?: FirestoreLike } = {}): Promise<number> {
  checkUserFieldId(fieldId);
  return forTenant(ctx, opts.db).agentActions.count([["fieldIds", "array-contains", fieldId]]);
}

import { randomBytes } from "node:crypto";
import { TENANT_FIELD } from "./repository";
import { TenantIsolationError } from "./errors";
import { regionalStoreFor, retryOnceOnExists } from "./ontologyEvents";
import { planAgentTransition, readAgentActionTx, stageAgentTransition, type AgentTransitionOk } from "./agentActions";
import type { DocRefLike, DocSnapLike, FirestoreLike, TenantContext, TransactionLike } from "./types";
import type { EventActor } from "@/lib/ontology/events";
import {
  NEXT_ACTION_LIMITS,
  NextActionRecordSchema,
  nextActionDocId,
  type ActionCard,
  type CardStepRecord,
  type ChoiceOption,
  type FallbackReason,
  type NextActionRecord,
  type Outcome,
  type OutcomeState,
  type Step,
  type StepKey,
} from "@/lib/types/nextAction";

/**
 * Home's Your next action, kept per brand in its region (NEXT_ACTION_CARDS, ADR-0020): the card
 * Vizzy wrote, the hash of what it was written from, each step's agent action, and the newest
 * outcomes, which the next card reads. The only writer of next_action_cards. Each change to a
 * step's agent action commits in the same regional transaction as the record, through the agent
 * action helpers, so a step's state and its decision never disagree. Nothing here logs a word.
 *
 * - claimNextActionWrite: a write holds the record for a short lease, within the brand's day cap.
 * - commitNextActionWrite: the new card (or the fallback) goes in, and the old card's open steps are
 *   declined as superseded and kept as ignored.
 * - recordNextActionOutcome: a step done, answered or dismissed (with the founder's reason).
 * - forgetNextActionCard: the card and every word in its outcomes go, and its open steps are
 *   declined; the day's count and which steps were dismissed (ids and times only) stay.
 *
 * Outcomes are trimmed whenever the record is read as well as written, so one older than 90 days is
 * never read again, even before the record is next written.
 */

export const NEXT_ACTION_CARDS = "next_action_cards";
const DAY_MS = 86_400_000;
const L = NEXT_ACTION_LIMITS;

function recordRef(store: FirestoreLike, ctx: TenantContext): DocRefLike {
  return store.collection(NEXT_ACTION_CARDS).doc(nextActionDocId(ctx.tenantId));
}

/**
 * The stored record, checked and parsed, with its outcomes trimmed as of `nowMs`; null when there is
 * none or it can't be read.
 */
function parseSnap(ctx: TenantContext, snap: DocSnapLike, nowMs: number): NextActionRecord | null {
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${NEXT_ACTION_CARDS}/${snap.id} belongs to another tenant`);
  const parsed = NextActionRecordSchema.safeParse({ ...data, id: snap.id });
  if (!parsed.success) {
    console.warn(`[next-action] ${NEXT_ACTION_CARDS}/${snap.id} can't be read; it is written again`);
    return null;
  }
  return { ...parsed.data, outcomes: trimOutcomes(parsed.data.outcomes, nowMs) };
}

/** The record as stored, without its id, stamped with the brand. */
function stored(ctx: TenantContext, r: Omit<NextActionRecord, "id" | "tenantId">): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...r, [TENANT_FIELD]: ctx.tenantId })) as Record<string, unknown>;
}

/**
 * The brand's record: the card on Home now and the newest outcomes, trimmed as of `nowMs` (default
 * now). Null when there is none.
 */
export async function readNextActionCard(ctx: TenantContext, opts: { db?: FirestoreLike; nowMs?: number } = {}): Promise<NextActionRecord | null> {
  const store = regionalStoreFor(ctx, opts.db);
  return parseSnap(ctx, await recordRef(store, ctx).get(), opts.nowMs ?? Date.now());
}

const newestFirst = (a: Outcome, b: Outcome) => b.at.localeCompare(a.at);

/**
 * The outcomes kept, newest first: the newest 30, and besides them the newest dismissal of each step
 * from the last 30 days, so a step stays off the card for its quiet days however many outcomes came
 * after; none older than 90 days. Pure: every read and write of the record runs it, so an older
 * outcome (and the reason in it) is never read again and leaves on the next write.
 */
export function trimOutcomes(outcomes: readonly Outcome[], nowMs: number): Outcome[] {
  const since = nowMs - L.OUTCOME_DAYS * DAY_MS;
  const quietSince = nowMs - L.QUIET_DAYS * DAY_MS;
  const recent = outcomes.filter((o) => Date.parse(o.at) >= since).sort(newestFirst);
  const newest = recent.slice(0, L.OUTCOMES);
  const quiet = new Set(newest.filter((o) => o.state === "dismissed").map((o) => o.actionKey));
  const older = recent.slice(L.OUTCOMES).filter((o) => {
    if (o.state !== "dismissed" || Date.parse(o.at) < quietSince || quiet.has(o.actionKey)) return false;
    quiet.add(o.actionKey);
    return true;
  });
  return [...newest, ...older].sort(newestFirst);
}

/**
 * The dismissals still in their quiet days, with no words: what a forgotten card leaves, so a step
 * the founder dismissed stays off the next card. Newest per step.
 */
export function quietOnly(outcomes: readonly Outcome[], nowMs: number): Outcome[] {
  const quietSince = nowMs - L.QUIET_DAYS * DAY_MS;
  const seen = new Set<string>();
  return [...outcomes].sort(newestFirst).flatMap((o) => {
    if (o.state !== "dismissed" || Date.parse(o.at) < quietSince || seen.has(o.actionKey)) return [];
    seen.add(o.actionKey);
    return [{ ...o, title: "", reason: null, answer: null }];
  });
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A blank record: no card yet. */
function blank(nowIso: string): Omit<NextActionRecord, "id" | "tenantId"> {
  return {
    status: "fallback",
    inputHash: "",
    cardId: null,
    card: null,
    steps: [],
    failure: null,
    reason: "state",
    composedAt: nowIso,
    model: "",
    promptVersion: 0,
    composeDay: nowIso.slice(0, 10),
    composeCount: 0,
    leaseUntil: null,
    leaseId: null,
    outcomes: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export type ClaimResult =
  { ok: true; leaseId: string; record: NextActionRecord | null } | { ok: false; reason: "busy" | "limited"; record: NextActionRecord | null };

/**
 * Hold the record for one write: refused while another write holds it ("busy"), or once the brand
 * has had its cards for the UTC day ("limited"). Makes a blank record when there is none.
 */
export async function claimNextActionWrite(
  ctx: TenantContext,
  opts: {
    nowMs: number;
    leaseMs: number;
    maxPerDay?: number;
    db?: FirestoreLike;
  },
): Promise<ClaimResult> {
  const store = regionalStoreFor(ctx, opts.db);
  const ref = recordRef(store, ctx);
  const nowIso = new Date(opts.nowMs).toISOString();
  const max = opts.maxPerDay ?? L.COMPOSES_PER_DAY;
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<ClaimResult> => {
      const snap = await txn.get(ref);
      const record = parseSnap(ctx, snap, opts.nowMs);
      if (record?.leaseUntil && Date.parse(record.leaseUntil) > opts.nowMs) return { ok: false, reason: "busy", record };
      const today = utcDay(opts.nowMs);
      const used = record && record.composeDay === today ? record.composeCount : 0;
      if (used >= max) return { ok: false, reason: "limited", record };
      const leaseId = randomBytes(8).toString("hex");
      const leaseUntil = new Date(opts.nowMs + opts.leaseMs).toISOString();
      if (!snap.exists) txn.create(ref, stored(ctx, { ...blank(nowIso), leaseUntil, leaseId }));
      else if (!record) txn.set(ref, stored(ctx, { ...blank(nowIso), leaseUntil, leaseId }));
      else txn.update(ref, { leaseUntil, leaseId });
      return { ok: true, leaseId, record };
    }),
  );
}

/**
 * Let go of a hold without writing a card (a write that failed on the way, or Show another that
 * could not write one). `spentAt`: the model was asked, so the call counts toward the brand's cards
 * for that UTC day, as a written card does.
 */
export async function releaseNextActionWrite(ctx: TenantContext, leaseId: string, opts: { db?: FirestoreLike; spentAt?: number } = {}): Promise<void> {
  const store = regionalStoreFor(ctx, opts.db);
  const ref = recordRef(store, ctx);
  await store.runTransaction(async (txn) => {
    const record = parseSnap(ctx, await txn.get(ref), opts.spentAt ?? Date.now());
    if (record?.leaseId !== leaseId) return;
    const patch: Record<string, unknown> = { leaseUntil: null, leaseId: null };
    if (opts.spentAt !== undefined) {
      const day = utcDay(opts.spentAt);
      patch.composeDay = day;
      patch.composeCount = (record.composeDay === day ? record.composeCount : 0) + 1;
    }
    txn.update(ref, patch);
  });
}

/** A step's title on a card, for its outcome. */
const titleOf = (card: ActionCard | null, key: StepKey) => card?.steps.find((s) => s.key === key)?.title ?? "";

/** Who records a goal the brand reached: nobody pressed anything, its count got there. */
const GOAL_ACTOR: EventActor = { type: "system", id: "next_action" };

/**
 * Read the open steps' agent actions and plan each one's move: a goal the brand reached (`reached`)
 * is acted as done, any other open step is declined (superseded). A step whose action moved
 * meanwhile, or is gone, is left as it is.
 */
async function planSupersede(
  txn: TransactionLike,
  store: FirestoreLike,
  ctx: TenantContext,
  steps: readonly CardStepRecord[],
  by: EventActor,
  at: string,
  reached: ReadonlySet<StepKey> = new Set(),
): Promise<{ plans: AgentTransitionOk[]; ignored: CardStepRecord[]; done: CardStepRecord[] }> {
  const open = steps.filter((s) => s.state === "open");
  // A stored action this build can't read is left for the expiry tick; another brand's still throws.
  const current = await Promise.all(
    open.map((s) =>
      readAgentActionTx(txn, store, ctx, s.agentActionId).catch((err: unknown) => {
        if (err instanceof TenantIsolationError) throw err;
        return null;
      }),
    ),
  );
  const plans: AgentTransitionOk[] = [];
  current.forEach((a, i) => {
    if (!a) return;
    const plan = reached.has(open[i]!.key)
      ? planAgentTransition(a, { to: "acted", by: GOAL_ACTOR, at, expectRev: a.rev, result: { outcome: "done", goal: "reached" } })
      : planAgentTransition(a, { to: "declined", reason: "superseded", by, at, expectRev: a.rev });
    if (plan.ok) plans.push(plan);
  });
  return { plans, ignored: open.filter((s) => !reached.has(s.key)), done: open.filter((s) => reached.has(s.key)) };
}

export interface NextActionWrite {
  leaseId: string;
  /** Canonical (toISOString). */
  at: string;
  /** Who replaced the card: the admin who asked for another, or the system when the state changed. */
  by: EventActor;
  status: "card" | "fallback";
  inputHash: string;
  cardId: string | null;
  card: ActionCard | null;
  /** The new card's steps, each with the agent action proposed for it (state open). */
  steps: CardStepRecord[];
  failure: FallbackReason | null;
  reason: "state" | "another";
  model: string;
  promptVersion: number;
  /** Goals on the old card the brand reached: recorded as done, not ignored. */
  reached?: readonly StepKey[];
}

export type CommitResult = { ok: true; record: NextActionRecord; superseded: number } | { ok: false; reason: "lost" };

/**
 * Put the new card (or the fallback) in, if this write still holds the record. In the same
 * transaction the old card's open steps are declined as superseded, and kept as ignored outcomes.
 * "lost" when another write took the record over meanwhile: nothing is written.
 */
export async function commitNextActionWrite(ctx: TenantContext, w: NextActionWrite, opts: { db?: FirestoreLike } = {}): Promise<CommitResult> {
  const store = regionalStoreFor(ctx, opts.db);
  const ref = recordRef(store, ctx);
  const nowMs = Date.parse(w.at);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<CommitResult> => {
      const snap = await txn.get(ref);
      const record = parseSnap(ctx, snap, nowMs);
      if (!record || record.leaseId !== w.leaseId) return { ok: false, reason: "lost" };
      const { plans, ignored, done } = await planSupersede(txn, store, ctx, record.steps, w.by, w.at, new Set(w.reached ?? []));
      const row = (s: CardStepRecord, state: "ignored" | "done"): Outcome => ({
        at: w.at,
        cardId: record.cardId!,
        step: s.key,
        actionKey: s.actionKey,
        title: titleOf(record.card, s.key),
        state,
        reason: null,
        answer: null,
      });
      const gone: Outcome[] = record.cardId ? [...done.map((s) => row(s, "done")), ...ignored.map((s) => row(s, "ignored"))] : [];
      const today = utcDay(nowMs);
      const next: Omit<NextActionRecord, "id" | "tenantId"> = {
        status: w.status,
        inputHash: w.inputHash,
        cardId: w.cardId,
        card: w.card,
        steps: w.steps,
        failure: w.failure,
        reason: w.reason,
        composedAt: w.at,
        model: w.model,
        promptVersion: w.promptVersion,
        composeDay: today,
        composeCount: (record.composeDay === today ? record.composeCount : 0) + 1,
        leaseUntil: null,
        leaseId: null,
        outcomes: trimOutcomes([...gone, ...record.outcomes], nowMs),
        createdAt: record.createdAt,
        updatedAt: w.at,
      };
      txn.set(ref, stored(ctx, next));
      for (const plan of plans) stageAgentTransition(txn, store, ctx, plan);
      return {
        ok: true,
        record: { ...next, id: snap.id, tenantId: ctx.tenantId },
        superseded: plans.length,
      };
    }),
  );
}

export interface OutcomeInput {
  cardId: string;
  step: StepKey;
  outcome: Exclude<OutcomeState, "ignored">;
  /** For dismissed: the founder's words, already one plain line. */
  reason: string | null;
  /** For answered: the answer's place in the step's choices. */
  choice: number | null;
  by: EventActor;
  /** Canonical (toISOString). */
  at: string;
}

export type OutcomeError = "not_found" | "card_changed" | "already_decided" | "not_this_step";
export type OutcomeResult =
  | {
      ok: true;
      record: NextActionRecord;
      step: Step;
      answer: ChoiceOption | null;
    }
  | { ok: false; error: OutcomeError };

/**
 * One step done (the founder pressed its button), answered (a chip) or dismissed (with their
 * reason), on the card on Home now: the step's agent action moves to acted or declined, the step's
 * state and its outcome are written, in one transaction. The answer's words come from the card as
 * stored, never from the request.
 */
export async function recordNextActionOutcome(ctx: TenantContext, input: OutcomeInput, opts: { db?: FirestoreLike } = {}): Promise<OutcomeResult> {
  const store = regionalStoreFor(ctx, opts.db);
  const ref = recordRef(store, ctx);
  const nowMs = Date.parse(input.at);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<OutcomeResult> => {
      const snap = await txn.get(ref);
      const record = parseSnap(ctx, snap, nowMs);
      if (!record?.card || !record.cardId) return { ok: false, error: "not_found" };
      if (record.cardId !== input.cardId) return { ok: false, error: "card_changed" };
      const step = record.card.steps.find((s) => s.key === input.step);
      const kept = record.steps.find((s) => s.key === input.step);
      if (!step || !kept) return { ok: false, error: "not_found" };
      if (kept.state !== "open") return { ok: false, error: "already_decided" };
      let answer: ChoiceOption | null = null;
      if (input.outcome === "done" && !step.action) return { ok: false, error: "not_this_step" };
      if (input.outcome === "answered") {
        answer = step.choices && input.choice !== null ? (step.choices.options[input.choice] ?? null) : null;
        if (!answer) return { ok: false, error: "not_this_step" };
      }
      const action = await readAgentActionTx(txn, store, ctx, kept.agentActionId);
      const plan = planAgentTransition(
        action,
        input.outcome === "dismissed"
          ? {
              to: "declined",
              reason: "dismissed",
              by: input.by,
              at: input.at,
              expectRev: action?.rev,
            }
          : {
              to: "acted",
              by: input.by,
              at: input.at,
              expectRev: action?.rev,
              result: input.outcome === "answered" ? { outcome: "answered", choice: input.choice } : { outcome: "done" },
            },
      );
      if (!plan.ok)
        return {
          ok: false,
          error: plan.error === "not_found" ? "not_found" : "already_decided",
        };
      const outcome: Outcome = {
        at: input.at,
        cardId: record.cardId,
        step: step.key,
        actionKey: kept.actionKey,
        title: step.title,
        state: input.outcome,
        reason: input.outcome === "dismissed" ? (input.reason?.slice(0, L.REASON) ?? null) || null : null,
        answer: answer ? answer.label : null,
      };
      const steps = record.steps.map((s) => (s.key === step.key ? { ...s, state: input.outcome } : s));
      const outcomes = trimOutcomes([outcome, ...record.outcomes], nowMs);
      txn.update(ref, JSON.parse(JSON.stringify({ steps, outcomes, updatedAt: input.at })) as Record<string, unknown>);
      stageAgentTransition(txn, store, ctx, plan);
      return {
        ok: true,
        record: { ...record, steps, outcomes, updatedAt: input.at },
        step,
        answer,
      };
    }),
  );
}

/**
 * Forget the brand's card (an admin removed a fact or deleted a conversation in About your
 * business, so nothing written from them stays): the card, its steps and every title, reason and
 * answer in the outcomes go, and its open steps are declined as superseded in the same transaction.
 * Two things stay, with no words: the day's count, so the 20 a day still holds, and which steps were
 * dismissed in the last 30 days (ids and times), so "won't suggest it again for 30 days" still
 * holds. A write in progress loses its hold, so a card written from the removed words never goes
 * in. False when there was no record.
 */
export async function forgetNextActionCard(ctx: TenantContext, opts: { at: string; by: EventActor; db?: FirestoreLike }): Promise<boolean> {
  const store = regionalStoreFor(ctx, opts.db);
  const ref = recordRef(store, ctx);
  const nowMs = Date.parse(opts.at);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return false;
      const record = parseSnap(ctx, snap, nowMs);
      const { plans } = record ? await planSupersede(txn, store, ctx, record.steps, opts.by, opts.at) : { plans: [] };
      const base = blank(opts.at);
      txn.set(
        ref,
        stored(ctx, {
          ...base,
          composeDay: record?.composeDay ?? base.composeDay,
          composeCount: record?.composeCount ?? 0,
          outcomes: record ? quietOnly(record.outcomes, nowMs) : [],
          createdAt: record?.createdAt ?? base.createdAt,
        }),
      );
      for (const plan of plans) stageAgentTransition(txn, store, ctx, plan);
      return true;
    }),
  );
}

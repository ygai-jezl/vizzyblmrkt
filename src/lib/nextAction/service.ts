import { randomBytes } from "node:crypto";
import type { AiUsage } from "@/lib/agents/gemini";
import { TEXT_MODEL } from "@/lib/agents/modelConfig";
import { isBrandMapEnabled, isBrandMapUiEnabled } from "@/lib/brandMap/flags";
import { isBrandKitLogosEnabled, isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { isEmailStyleEnabled, isEmailStyleUiEnabled } from "@/lib/email/flags";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Enabled, isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { computeGrowth, type GrowthSignals } from "@/lib/nav/growth";
import { loadGrowthSignals, type SetupOptions } from "@/lib/nav/growthSignals";
import { suggestBusinessFact, type SuggestFactError } from "@/lib/onboarding/factSuggestions";
import { tidyFactText } from "@/lib/onboarding/learn";
import { listBusinessFacts } from "@/lib/onboarding/store";
import { aiUsage } from "@/lib/plans/meter";
import {
  claimNextActionWrite,
  commitNextActionWrite,
  getTenantById,
  proposeAgentAction,
  readNextActionCard,
  recordNextActionOutcome,
  releaseNextActionWrite,
  transitionAgentAction,
  type OutcomeError,
} from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EventActor } from "@/lib/ontology/events";
import { agentDedupeKey, type AgentActionId } from "@/lib/types/agentAction";
import { ONBOARDING_LIMITS } from "@/lib/types/onboarding";
import type { Tenant } from "@/lib/types/tenant";
import {
  NEXT_ACTION_LIMITS,
  stepActionKey,
  type ActionId,
  type CardStepRecord,
  type FallbackReason,
  type NextActionRecord,
  type Step,
  type StepKey,
} from "@/lib/types/nextAction";
import { allowedActions, type ActionEnv } from "./actions";
import { writeCard, type ComposeDeps } from "./compose";
import { PROMPT_VERSION, doneSince, inputHash, quietKeys, type NextActionInputs } from "./inputs";
import { cardView, goalReached, type CardView } from "./view";

/**
 * Your next action, end to end (NEXT_ACTION_CARD_ENABLED, ADR-0020): what a card is written from,
 * when a new one is due, writing it off Home's request path, and what the founder does with it.
 *
 * - Home reads the kept card and the hash of its inputs (homeNextAction) and never waits on the
 *   model. When the hash differs, the card on the page asks POST /api/admin/next-action to write a
 *   new one; Show another asks the same with "another".
 * - A write holds the record for a short lease, within 20 cards per brand per UTC day, and is one
 *   metered call (aiUsage(ctx, "next_action")). Every step becomes an agent action
 *   (`next_action.suggest`, target the brand, ids only); the old card's open steps are declined as
 *   superseded in the same transaction that puts the new card in.
 * - A step done, answered or dismissed moves its agent action; an answer that maps to a fact goes
 *   through About your business's suggestion flow, for the founder to keep.
 *
 * Only admins: the card is written from the facts and the words admins kept (About your business
 * says "Only your admins and Vizzy see it"), so members see Home's steps list as before.
 */

export const NEXT_ACTION_ACTION = "next_action.suggest";
/** How long one write may hold the record: the model's whole time and a little more. */
export const LEASE_MS = 45_000;
const DAY_MS = 86_400_000;

export interface NextActionDeps {
  db?: FirestoreLike;
  /** Milliseconds now (tests). */
  now?: () => number;
  generate?: ComposeDeps["generate"];
  /** The meter (tests); by default aiUsage(ctx, "next_action"). */
  usage?: AiUsage;
}

/** The growth path's reads exactly as Home makes them, so Home and the route hash the same state. */
export function homeSignalOptions(): { lifecycle: boolean; invites: boolean; setup?: SetupOptions } {
  const setup = isSetupGuideEnabled() ? { emailStyle: isEmailStyleUiEnabled(), brandMap: isBrandMapUiEnabled() } : undefined;
  return { lifecycle: isLifecycleEnabled(), invites: isInvitesUiEnabled() && isInvitesEnabled(), ...(setup ? { setup } : {}) };
}

/** What the allowlist reads, for this brand and person now: each page's own switch, as the page checks it. */
export function actionEnv(ctx: Pick<TenantContext, "role">, signals: ActionEnv["signals"]): ActionEnv {
  return {
    role: ctx.role,
    signals,
    areas: {
      emailStyle: isEmailStyleUiEnabled() && isEmailStyleEnabled(),
      brandMap: isBrandMapUiEnabled() && isBrandMapEnabled(),
      invites: isInvitesUiEnabled() && isInvitesEnabled(),
      about: isNavV2Enabled(),
      logos: isBrandKitLogosEnabled(),
      voice: isBrandVoiceEnabled(),
      review: isNavV2Phase2Enabled() || isLifecycleEnabled(),
    },
  };
}

/**
 * The card's steps as the inputs count them: a goal the brand reached counts as decided, so a card
 * whose other steps are all decided is written again once the count gets there.
 */
export function stepsAsDecided(record: NextActionRecord | null, signals: Pick<GrowthSignals, "signups" | "postsScheduled" | "newslettersSent">): CardStepRecord[] {
  if (!record) return [];
  const reached = reachedGoals(record, signals);
  return record.steps.map((s) => (reached.has(s.key) ? { ...s, state: "done" as const } : s));
}

/** The open goal steps on the card whose count got to its target. */
export function reachedGoals(record: NextActionRecord | null, signals: Pick<GrowthSignals, "signups" | "postsScheduled" | "newslettersSent">): Set<StepKey> {
  const open = new Set((record?.steps ?? []).filter((s) => s.state === "open").map((s) => s.key));
  return new Set((record?.card?.steps ?? []).filter((s) => open.has(s.key) && s.progress && goalReached(s.progress, signals)).map((s) => s.key));
}

export interface NextActionState {
  tenant: Tenant | null;
  signals: GrowthSignals;
  env: ActionEnv;
  allowed: ActionId[];
  inputs: NextActionInputs;
  hash: string;
  record: NextActionRecord | null;
}

/** Everything a card is written from, and the kept record. Home passes what it already read. */
export async function loadNextActionState(
  ctx: TenantContext,
  pre: { tenant?: Tenant | null; signals?: GrowthSignals } = {},
  deps: NextActionDeps = {},
): Promise<NextActionState> {
  const nowMs = (deps.now ?? Date.now)();
  const [tenant, signals, facts, record] = await Promise.all([
    pre.tenant !== undefined ? pre.tenant : getTenantById(ctx.tenantId, deps.db).catch(() => null),
    pre.signals ?? loadGrowthSignals(ctx, homeSignalOptions(), deps.db),
    listBusinessFacts(ctx, { db: deps.db }),
    readNextActionCard(ctx, { db: deps.db, nowMs }),
  ]);
  const env = actionEnv(ctx, signals);
  const allowed = allowedActions(env);
  const inputs: NextActionInputs = {
    brandName: tenant?.tenantName ?? "",
    answers: tenant?.businessProfile?.answers,
    facts: facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text })),
    growth: computeGrowth(signals, { ideas: isIdeaWordsEnabled() }),
    signals,
    outcomes: record?.outcomes ?? [],
    allowed,
    current: record ? { cardId: record.cardId, steps: stepsAsDecided(record, signals) } : null,
    model: TEXT_MODEL,
  };
  return { tenant, signals, env, allowed, inputs, hash: inputHash(inputs), record };
}

/**
 * Whether the brand gets Vizzy's card: it told Vizzy about itself (the welcome finished, answers
 * from Settings, or a fact kept). A skipped welcome or no profile keeps Home's steps list, as the
 * mockups show.
 */
export function cardFits(tenant: Pick<Tenant, "businessProfile"> | null): boolean {
  return tenant?.businessProfile?.status === "done";
}

/**
 * A card this old is written again, whatever its inputs, before the tick sets its steps' agent
 * actions aside (STEP_DAYS): a step pressed after that would have no open decision to record.
 */
export const CARD_MAX_DAYS = NEXT_ACTION_LIMITS.STEP_DAYS - 2;

/**
 * How long a fallback stands for the same inputs before Home asks again. A model that did not answer
 * (a timeout, 429 or 5xx) is tried again soon; an answer that failed the checks a little later, as
 * the next answer may pass. Both stay within the brand's cards for the day.
 */
export const FALLBACK_RETRY_MS: Record<FallbackReason, number> = {
  model: 30 * 60_000,
  schema: 6 * 3_600_000,
  allowlist: 6 * 3_600_000,
  writing: 6 * 3_600_000,
  empty: 6 * 3_600_000,
};

/** Whether the kept card (or fallback) was written from these inputs, and recently enough. */
export function isFresh(state: Pick<NextActionState, "record" | "hash">, nowMs: number): boolean {
  const r = state.record;
  if (!r || r.inputHash !== state.hash) return false;
  const age = nowMs - Date.parse(r.composedAt);
  if (r.status === "fallback" && r.failure) return age < FALLBACK_RETRY_MS[r.failure];
  return age < CARD_MAX_DAYS * DAY_MS;
}

/** What Home draws, and whether it should ask for a new card. Reads only: never the model. */
export async function homeNextAction(
  ctx: TenantContext,
  pre: { tenant: Tenant | null; signals: GrowthSignals },
  deps: NextActionDeps = {},
): Promise<{ view: CardView | null; stale: boolean }> {
  const state = await loadNextActionState(ctx, pre, deps);
  const now = (deps.now ?? Date.now)();
  return { view: cardView(state.record, state.env, state.signals, now), stale: !isFresh(state, now) };
}

const newCardId = () => `nc_${randomBytes(8).toString("hex")}`;

/** Propose one step as an agent action: ids only, never the card's words. */
async function proposeStep(ctx: TenantContext, cardId: string, step: Step, requestedBy: EventActor, at: string, deps: NextActionDeps): Promise<CardStepRecord> {
  const actionKey = stepActionKey(step);
  const saved = await proposeAgentAction(
    ctx,
    {
      dedupeKey: agentDedupeKey(NEXT_ACTION_ACTION, cardId, step.key),
      agent: "vizzy",
      action: NEXT_ACTION_ACTION,
      target: { type: "brand", id: ctx.tenantId },
      personId: null,
      proposal: { cardId, step: step.key, actionKey },
      basis: null,
      signals: [],
      review: null,
      requestedBy,
      expiresAt: new Date(Date.parse(at) + NEXT_ACTION_LIMITS.STEP_DAYS * DAY_MS).toISOString(),
      at,
    },
    { db: deps.db },
  );
  return { key: step.key, actionKey, agentActionId: saved.action.id, state: "open" };
}

export type ComposeResult = {
  /** True when a new card (or a fallback) was written now. */
  composed: boolean;
  record: NextActionRecord | null;
  /** Why nothing was written: another write holds it, or the brand's cards for today are used. */
  held?: "busy" | "limited";
  /** Show another could not write a card: the card on Home stays as it was. */
  failed?: FallbackReason;
  state: NextActionState;
};

/** Decline steps proposed for a card that never went in: nobody saw them. Never throws. */
async function declineUnshown(ctx: TenantContext, steps: readonly CardStepRecord[], by: EventActor, at: string, deps: NextActionDeps): Promise<void> {
  await Promise.all(steps.map((s) => transitionAgentAction(ctx, s.agentActionId, { to: "declined", reason: "superseded", by, at }, { db: deps.db }).catch(() => null)));
}

/**
 * Write a new card when the inputs changed ("state") or the founder asked for another ("another").
 * On "state", a model or check failure is kept as the fallback for these inputs for a while
 * (FALLBACK_RETRY_MS), so the same inputs don't ask the model again at once. On "another", a failure
 * writes nothing: the card on Home stays, and the call still counts toward the day. Never throws for
 * a failed card; a store error declines any steps already proposed, lets go of the hold and throws.
 */
export async function composeNextAction(ctx: TenantContext, opts: { reason: "state" | "another" }, deps: NextActionDeps = {}): Promise<ComposeResult> {
  const now = deps.now ?? Date.now;
  const state = await loadNextActionState(ctx, {}, deps);
  if (!cardFits(state.tenant)) return { composed: false, record: state.record, state };
  if (opts.reason === "state" && isFresh(state, now())) return { composed: false, record: state.record, state };
  const claim = await claimNextActionWrite(ctx, { nowMs: now(), leaseMs: LEASE_MS, db: deps.db });
  if (!claim.ok) return { composed: false, record: claim.record, held: claim.reason, state };
  const leaseId = claim.leaseId;
  const another = opts.reason === "another";
  const by: EventActor = another ? { type: "member", id: ctx.userId ?? null } : { type: "system", id: "next_action" };
  let asked = false;
  let proposed: CardStepRecord[] = [];
  try {
    const record = claim.record;
    if (opts.reason === "state" && isFresh({ record, hash: state.hash }, now())) {
      await releaseNextActionWrite(ctx, leaseId, { db: deps.db });
      return { composed: false, record, state };
    }
    const outcomes = record?.outcomes ?? [];
    const reached = reachedGoals(record, state.signals);
    const inputs: NextActionInputs = { ...state.inputs, outcomes, current: record ? { cardId: record.cardId, steps: stepsAsDecided(record, state.signals) } : null };
    const replaced = another && record?.card ? record.card.steps : [];
    asked = true;
    const result = await writeCard(
      inputs,
      {
        allowed: new Set(state.allowed),
        quiet: quietKeys(outcomes, now()),
        doneSinceLast: doneSince(outcomes, record?.cardId ?? null) || reached.size > 0,
        ...(replaced.length ? { replaced: new Set(replaced.map(stepActionKey)) } : {}),
      },
      deps.usage ?? aiUsage(ctx, "next_action", { tenant: state.tenant, db: deps.db }),
      { another, replacedTitles: replaced.map((s) => s.title) },
      { generate: deps.generate },
    );
    if (!result.ok && another) {
      // The founder keeps the card they have; the call counts toward the brand's cards today.
      await releaseNextActionWrite(ctx, leaseId, { db: deps.db, spentAt: now() });
      return { composed: false, record, failed: result.reason, state };
    }
    const at = new Date(now()).toISOString();
    const cardId = result.ok ? newCardId() : null;
    if (result.ok) {
      const settled = await Promise.allSettled(result.card.steps.map((s) => proposeStep(ctx, cardId!, s, by, at, deps)));
      proposed = settled.flatMap((p) => (p.status === "fulfilled" ? [p.value] : []));
      const refused = settled.find((p): p is PromiseRejectedResult => p.status === "rejected");
      if (refused) throw refused.reason;
    }
    const commit = await commitNextActionWrite(
      ctx,
      {
        leaseId,
        at,
        by,
        status: result.ok ? "card" : "fallback",
        // Written from these inputs, with no step decided yet.
        inputHash: inputHash({ ...inputs, current: null }),
        cardId,
        card: result.ok ? result.card : null,
        steps: proposed,
        failure: result.ok ? null : result.reason,
        reason: opts.reason,
        model: TEXT_MODEL,
        promptVersion: PROMPT_VERSION,
        reached: [...reached],
      },
      { db: deps.db },
    );
    if (!commit.ok) {
      // Another write took the record over: this card's steps were never shown.
      await declineUnshown(ctx, proposed, by, at, deps);
      return { composed: false, record: await readNextActionCard(ctx, { db: deps.db, nowMs: now() }), held: "busy", state };
    }
    return { composed: true, record: commit.record, state };
  } catch (err) {
    // Steps proposed for a card that never went in are declined, not left for the expiry tick.
    await declineUnshown(ctx, proposed, by, new Date(now()).toISOString(), deps);
    await releaseNextActionWrite(ctx, leaseId, { db: deps.db, ...(asked ? { spentAt: now() } : {}) }).catch(() => undefined);
    throw err;
  }
}

/** The card to draw after a write, for the route's answer. */
export function viewAfter(r: Pick<ComposeResult, "record" | "state">, nowMs: number): CardView | null {
  return cardView(r.record, r.state.env, r.state.signals, nowMs);
}

export interface OutcomeRequest {
  cardId: string;
  step: StepKey;
  outcome: "done" | "dismissed" | "answered";
  reason?: string | null;
  choice?: number | null;
}

/** What became of an answer that maps to a fact: waiting in About your business, or why not. */
export type SuggestionOutcome = "waiting" | SuggestFactError | "not_saved" | null;

export type OutcomeServiceResult = { ok: true; suggestion: SuggestionOutcome } | { ok: false; error: OutcomeError | "no_user" };

/** A dismissal's reason as kept: one plain line, at most 140 characters, or null. */
export function reasonLine(raw: string | null | undefined): string | null {
  const t = (raw ?? "")
    .replace(/[<>]/g, " ")
    .replace(/[\s\u0085]+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  return t ? t.slice(0, NEXT_ACTION_LIMITS.REASON).trim() : null;
}

/**
 * Record what the founder did with one step. An answer whose question maps to a kind of fact is
 * suggested through About your business (PR A's flow): it waits there for the founder to keep, and
 * is never written straight to the profile.
 */
export async function recordStepOutcome(ctx: TenantContext, req: OutcomeRequest, deps: NextActionDeps = {}): Promise<OutcomeServiceResult> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return { ok: false, error: "no_user" };
  const nowMs = (deps.now ?? Date.now)();
  const r = await recordNextActionOutcome(
    ctx,
    {
      cardId: req.cardId,
      step: req.step,
      outcome: req.outcome,
      reason: req.outcome === "dismissed" ? reasonLine(req.reason) : null,
      choice: req.outcome === "answered" ? (req.choice ?? null) : null,
      by: { type: "member", id: userId },
      at: new Date(nowMs).toISOString(),
    },
    { db: deps.db },
  );
  if (!r.ok) return r;
  const kind = r.step.choices?.fact;
  if (req.outcome !== "answered" || !kind || !r.answer?.fact) return { ok: true, suggestion: null };
  // The founder's own words are their pick, with the question it answers.
  const quote = `${r.step.choices!.question} ${r.answer.label}`.slice(0, ONBOARDING_LIMITS.MAX_QUOTE);
  const text = tidyFactText(r.answer.fact);
  if (quote.length < ONBOARDING_LIMITS.MIN_QUOTE || text.length < ONBOARDING_LIMITS.MIN_FACT_TEXT) return { ok: true, suggestion: "not_saved" };
  const s = await suggestBusinessFact(ctx, { kind, text, quote, asked: r.step.choices!.question }, { db: deps.db, nowMs }).catch(() => null);
  if (!s) return { ok: true, suggestion: "not_saved" };
  return { ok: true, suggestion: s.ok ? "waiting" : s.error };
}

/** The agent action ids of a record's steps (tests and Vizzy's read). */
export function stepActionIds(record: NextActionRecord | null): AgentActionId[] {
  return record?.steps.map((s) => s.agentActionId) ?? [];
}

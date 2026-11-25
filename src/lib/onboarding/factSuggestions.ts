import { createHash } from "node:crypto";
import { z } from "zod";
import { keepSuggestedBusinessFact, proposeAgentAction, transitionAgentAction } from "@/lib/tenant";
import { bumpBusinessProfileRev, setBusinessProfile } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { deterministicAgentActionId } from "@/lib/crm/identifiers";
import { agentActionReviewItem, getAgentAction, listOpenAgentActions } from "@/lib/ontology/agentActions";
import type { ReviewItem } from "@/lib/review/summary";
import { agentDedupeKey, isAgentActionId, type AgentAction, type AgentActionId } from "@/lib/types/agentAction";
import { ONBOARDING_LIMITS, type BusinessFact, type ConversationTurn, type OnboardingConversation } from "@/lib/types/onboarding";
import { FACT_KINDS, type FactKind } from "./choices";
import { quoteKey } from "./learn";
import { countConversations, listBusinessFacts } from "./store";
import { SUGGESTION_WORDS } from "./words";

/**
 * What Vizzy hears about the business in a later chat (ONBOARDING_ENABLED): one agent action per
 * suggestion, action `business_fact.suggest`, target the brand itself. It waits for an admin, who
 * keeps or removes it in Settings, About your business (or opens it from Review). Nothing is used
 * until then: Vizzy reads only kept facts.
 *
 * - Only admins suggest (the agent route checks the token's role), at most 10 waiting per brand,
 *   and never the words of a fact already kept.
 * - The same fact again (same kind and text, compared ignoring case, spacing and punctuation)
 *   answers with the one waiting, or, once a person kept or removed it, says so and saves
 *   nothing. One set aside by nobody (out of time) can be made again.
 * - Keep writes the fact, the chat's three lines as a "Chat with Vizzy" conversation, and the
 *   decision, in one transaction; then the profile's rev goes up so Vizzy reads it again.
 *   Remove declines it. Either way the words leave the action (clearDetailsOnClose): kept, they
 *   live on in the fact, which an admin can remove.
 */

export const BUSINESS_FACT_ACTION = "business_fact.suggest";
/** How long a suggestion waits before the tick sets it aside. */
export const SUGGESTION_DAYS = 30;
/** Suggestions waiting per brand. */
export const MAX_WAITING = 10;
/** Where an admin keeps or removes one. */
export const ABOUT_HREF = "/admin/account/settings#about";

/** How many times the same suggestion may be set aside by nobody and made again. */
const MAX_ROUNDS = 20;
/** The most open suggestions read: every one expires, and at most 10 are made to wait. */
const OPEN_READ = 50;
const DAY_MS = 86_400_000;
const L = ONBOARDING_LIMITS;

/** What Vizzy suggests, as stored on the action. */
const ProposalSchema = z.object({
  kind: z.enum(FACT_KINDS),
  text: z.string().min(1).max(L.MAX_FACT_TEXT),
  quote: z.string().min(1).max(L.MAX_QUOTE),
  asked: z.string().max(L.MAX_QUOTE).default(""),
});

export interface FactSuggestionInput {
  kind: FactKind;
  /** Vizzy's few words, already in house style (3 to 80 characters). */
  text: string;
  /** The person's own words (8 to 300 characters), kept as they are. */
  quote: string;
  /** Vizzy's question that drew it, if any. */
  asked?: string;
}

/** A suggestion waiting for an admin. */
export interface WaitingFact {
  id: AgentActionId;
  rev: number;
  kind: FactKind;
  text: string;
  quote: string;
  asked: string;
  /** When Vizzy heard it. */
  at: string;
}

/** A waiting suggestion's words, or null when they are gone or unreadable. */
export function waitingFactOf(a: AgentAction): WaitingFact | null {
  const p = ProposalSchema.safeParse(a.proposal);
  if (!p.success) return null;
  return { id: a.id, rev: a.rev, kind: p.data.kind, text: p.data.text, quote: p.data.quote, asked: p.data.asked, at: a.createdAt };
}

const isThisBrands = (ctx: TenantContext, a: AgentAction) => a.action === BUSINESS_FACT_ACTION && a.target.type === "brand" && a.target.id === ctx.tenantId;

/** The brand's suggestions waiting for an admin, newest first (the existing action, state, createdAt index). */
export async function openFactSuggestions(ctx: TenantContext, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<WaitingFact[]> {
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const open = await listOpenAgentActions(ctx, { action: BUSINESS_FACT_ACTION, limit: OPEN_READ, now, db: deps.db });
  return open.filter((a) => isThisBrands(ctx, a)).flatMap((a) => waitingFactOf(a) ?? []);
}

/** A waiting suggestion as a Review item (admins, src/lib/review/summary.ts). */
export function businessFactReviewItem(a: AgentAction): ReviewItem | null {
  const fact = waitingFactOf(a);
  if (!fact) return null;
  return agentActionReviewItem(a, { title: SUGGESTION_WORDS.reviewTitle, detail: fact.text, action: SUGGESTION_WORDS.reviewAction });
}

/** A 40 hex hash of the fact's kind and words, as compared. Never the words themselves. */
export function factHash(kind: FactKind, text: string): string {
  return createHash("sha1").update(`${kind}\n${quoteKey(text)}`).digest("hex");
}

function dedupeKeyOf(hash: string, round: number): string {
  return round ? agentDedupeKey(BUSINESS_FACT_ACTION, hash, `r${round}`) : agentDedupeKey(BUSINESS_FACT_ACTION, hash);
}

/** A person kept it (acted, or undone since) or removed it; expiry is nobody's decision. */
function decidedByAPerson(a: AgentAction): boolean {
  return a.state === "acted" || a.state === "undone" || (a.state === "declined" && a.declined?.reason === "dismissed");
}

export type SuggestFactError = "already_known" | "already_decided" | "too_many_waiting" | "too_many_facts";
export type SuggestFactResult = { ok: true; outcome: "created" | "open"; fact: WaitingFact } | { ok: false; error: SuggestFactError };

/**
 * Save what Vizzy heard as a suggestion an admin keeps. The brand and the person who asked come
 * from `ctx` only. Refuses a fact whose words (or quote) are already kept, a brand with 10
 * waiting, and a brand whose kept and waiting facts reach 40.
 */
export async function suggestBusinessFact(
  ctx: TenantContext,
  input: FactSuggestionInput,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<SuggestFactResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const kept = await listBusinessFacts(ctx, { db: deps.db });
  const textKey = quoteKey(input.text);
  const quote = quoteKey(input.quote);
  if (kept.some((f) => quoteKey(f.text) === textKey || quoteKey(f.quote) === quote)) return { ok: false, error: "already_known" };

  // The same fact again: the one waiting, or "already decided" once a person decided it. Each
  // earlier one set aside by nobody moves it on to the next round's key.
  const hash = factHash(input.kind, input.text);
  let dedupeKey: string | null = null;
  for (let round = 0; round < MAX_ROUNDS && !dedupeKey; round += 1) {
    const key = dedupeKeyOf(hash, round);
    const same = await getAgentAction(ctx, deterministicAgentActionId(ctx.tenantId, key), { db: deps.db });
    if (!same) dedupeKey = key;
    else if (same.state === "proposed" || same.state === "approved") {
      const fact = waitingFactOf(same);
      if (fact && same.expiresAt > at) return { ok: true, outcome: "open", fact };
      // Out of time and not yet swept: it is set aside by the tick, so try the next round.
    } else if (decidedByAPerson(same)) return { ok: false, error: "already_decided" };
  }
  if (!dedupeKey) return { ok: false, error: "already_decided" };

  const waiting = await openFactSuggestions(ctx, { db: deps.db, nowMs });
  if (waiting.length >= MAX_WAITING) return { ok: false, error: "too_many_waiting" };
  if (kept.length + waiting.length >= L.MAX_FACTS) return { ok: false, error: "too_many_facts" };

  const saved = await proposeAgentAction(
    ctx,
    {
      dedupeKey,
      agent: "vizzy",
      action: BUSINESS_FACT_ACTION,
      target: { type: "brand", id: ctx.tenantId },
      personId: null,
      proposal: { kind: input.kind, text: input.text, quote: input.quote, asked: input.asked ?? "" },
      basis: null,
      signals: [],
      review: { kind: "business_fact", href: ABOUT_HREF },
      // The admin who told Vizzy, by user id.
      requestedBy: { type: "member", id: ctx.userId ?? null },
      expiresAt: new Date(nowMs + SUGGESTION_DAYS * DAY_MS).toISOString(),
      // Kept, the words live on in the fact; removed or out of time, they go.
      clearDetailsOnClose: true,
      at,
    },
    { db: deps.db },
  );
  if (saved.outcome === "decided") return { ok: false, error: "already_decided" };
  const fact = waitingFactOf(saved.action);
  if (!fact) return { ok: false, error: "already_decided" };
  return { ok: true, outcome: saved.outcome, fact };
}

/** A kept fact's id: the same for the same suggestion, so it can't be kept twice. */
export function keptFactId(tenantId: string, actionId: string): string {
  return `bf_${createHash("sha256").update(`${tenantId}:${actionId}:fact`).digest("hex").slice(0, 16)}`;
}

/** The kept chat's id, likewise. */
export function keptChatId(tenantId: string, actionId: string): string {
  return `oc_${createHash("sha256").update(`${tenantId}:${actionId}:chat`).digest("hex").slice(0, 32)}`;
}

/** The chat as kept: Vizzy's question (when there was one), the person's words, then Vizzy's line. */
export function keptChatTurns(fact: Pick<WaitingFact, "asked" | "quote">): ConversationTurn[] {
  return [
    ...(fact.asked ? [{ who: "vizzy" as const, text: fact.asked, atSec: 0 }] : []),
    { who: "member" as const, text: fact.quote, atSec: 0 },
    { who: "vizzy" as const, text: SUGGESTION_WORDS.keptLine, atSec: 0 },
  ];
}

export type DecideFactError = "not_found" | "already_decided" | "too_many_facts" | "no_user";
export type DecideFactResult =
  | { ok: true; decision: "keep"; fact: BusinessFact; conversation: OnboardingConversation | null }
  | { ok: true; decision: "remove" }
  | { ok: false; error: DecideFactError };

/**
 * Keep or remove one waiting suggestion, by the admin in `ctx` (the route checks the role). Keep
 * copies the words from the action as stored, writes the fact and the chat (when the brand keeps
 * fewer than 20 conversations) with the decision in one transaction, then bumps the profile's rev;
 * a brand with no profile yet gets one, so Vizzy reads it. Remove declines it and its words go.
 */
export async function decideBusinessFact(
  ctx: TenantContext,
  actionId: string,
  decision: "keep" | "remove",
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<DecideFactResult> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return { ok: false, error: "no_user" };
  if (!isAgentActionId(actionId)) return { ok: false, error: "not_found" };
  const action = await getAgentAction(ctx, actionId, { db: deps.db });
  if (!action || !isThisBrands(ctx, action)) return { ok: false, error: "not_found" };
  if (action.state !== "proposed") return { ok: false, error: "already_decided" };
  const by = { type: "member" as const, id: userId };
  const nowMs = deps.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();

  if (decision === "remove") {
    const r = await transitionAgentAction(ctx, action.id, { to: "declined", reason: "dismissed", by, at, expectRev: action.rev, clearDetails: true }, { db: deps.db });
    if (r.ok) return { ok: true, decision: "remove" };
    return { ok: false, error: r.error === "not_found" ? "not_found" : "already_decided" };
  }

  const fact = waitingFactOf(action);
  if (!fact) return { ok: false, error: "not_found" };
  if (action.expiresAt <= at) {
    await transitionAgentAction(ctx, action.id, { to: "declined", reason: "expired", by: { type: "system", id: "agent_action_expiry" }, at, expectRev: action.rev }, { db: deps.db }).catch(
      () => null,
    );
    return { ok: false, error: "already_decided" };
  }
  const [kept, conversations] = await Promise.all([listBusinessFacts(ctx, { db: deps.db }), countConversations(ctx, { db: deps.db })]);
  if (kept.length >= L.MAX_FACTS) return { ok: false, error: "too_many_facts" };

  const turns = keptChatTurns(fact);
  const speaker = action.requestedBy.type === "member" && action.requestedBy.id ? action.requestedBy.id : userId;
  const conversation: Omit<OnboardingConversation, "tenantId"> | null =
    conversations < L.MAX_CONVERSATIONS
      ? {
          id: keptChatId(ctx.tenantId, action.id),
          source: "chat",
          by: speaker,
          status: "ended",
          startedAt: fact.at,
          expiresAt: fact.at,
          endedAt: fact.at,
          lengthSec: 0,
          model: "chat",
          turns,
          chars: turns.reduce((n, t) => n + t.text.length, 0),
          notes: [],
          learned: null,
          learnTries: 0,
          confirmedAt: at,
          meteredSeconds: 0,
          createdAt: at,
        }
      : null;
  const r = await keepSuggestedBusinessFact(
    ctx,
    {
      actionId: action.id,
      action: BUSINESS_FACT_ACTION,
      expectRev: action.rev,
      by,
      at,
      fact: {
        id: keptFactId(ctx.tenantId, action.id),
        kind: fact.kind,
        text: fact.text,
        quote: fact.quote,
        source: "chat",
        conversationId: conversation?.id ?? null,
        heardAt: fact.at,
        confirmedAt: at,
        createdAt: at,
      },
      conversation,
    },
    { db: deps.db },
  );
  if (!r.ok) return { ok: false, error: r.error === "not_found" ? "not_found" : "already_decided" };

  // Vizzy reads the profile again. A brand with no profile yet (it never answered) gets one, so
  // the kept fact reaches every chat.
  const rev = await bumpBusinessProfileRev(ctx.tenantId, deps.db).catch(() => null);
  if (rev === null) {
    const made = await setBusinessProfile(ctx.tenantId, { status: "done" }, deps.db).catch(() => null);
    if (made && !made.before) await bumpBusinessProfileRev(ctx.tenantId, deps.db).catch(() => null);
  }
  return { ok: true, decision: "keep", fact: r.fact, conversation: r.conversation };
}

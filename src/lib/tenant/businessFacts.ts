import { TENANT_FIELD } from "./repository";
import { TenantIsolationError } from "./errors";
import { regionalStoreFor, retryOnceOnExists } from "./ontologyEvents";
import { planAgentTransition, readAgentActionTx, stageAgentTransition, type TransitionError } from "./agentActions";
import type { FirestoreLike, TenantContext } from "./types";
import type { EventActor } from "@/lib/ontology/events";
import type { AgentAction, AgentActionId } from "@/lib/types/agentAction";
import type { BusinessFact, OnboardingConversation } from "@/lib/types/onboarding";

/**
 * Keeping what Vizzy heard about the business in a chat (ONBOARDING_ENABLED): the waiting agent
 * action becomes acted, and the fact and the chat's three lines are written, in ONE transaction on
 * the brand's regional database, so a fact is never kept twice and never kept without its
 * decision. The words come from the action as stored, never from the request. For
 * src/lib/onboarding/factSuggestions.ts, through @/lib/tenant.
 */

const BUSINESS_FACTS = "business_facts";
const ONBOARDING_CONVERSATIONS = "onboarding_conversations";

export interface KeepBusinessFactInput {
  actionId: AgentActionId;
  /** Only an action of this kind is kept (`business_fact.suggest`). */
  action: string;
  /** Refuse with "changed" unless the action is still at this rev. */
  expectRev: number;
  by: EventActor;
  /** Canonical (toISOString). */
  at: string;
  /** The fact to write, with its id. */
  fact: Omit<BusinessFact, "tenantId">;
  /** The chat's lines to keep beside it, with its id, or null to keep the fact alone. */
  conversation: Omit<OnboardingConversation, "tenantId"> | null;
}

export type KeepBusinessFactResult =
  | { ok: true; action: AgentAction; fact: BusinessFact; conversation: OnboardingConversation | null }
  | { ok: false; error: TransitionError };

/** A stored doc's data without its id, stamped with the brand. */
function stamped<T extends { id: string }>(ctx: TenantContext, row: T): Record<string, unknown> {
  const { id: _id, ...rest } = row as Record<string, unknown>;
  return JSON.parse(JSON.stringify({ ...rest, [TENANT_FIELD]: ctx.tenantId })) as Record<string, unknown>;
}

/**
 * Keep one suggested fact: the action moves to acted (with its agent.* rows), the fact is
 * created, and the conversation too when given and not already there. Not found when the action
 * is missing or of another kind; changed or wrong_state when it moved since it was read. A fact
 * or conversation already at its id in another brand throws TenantIsolationError.
 */
export async function keepSuggestedBusinessFact(
  ctx: TenantContext,
  input: KeepBusinessFactInput,
  opts: { db?: FirestoreLike } = {},
): Promise<KeepBusinessFactResult> {
  const store = regionalStoreFor(ctx, opts.db);
  const factRef = store.collection(BUSINESS_FACTS).doc(input.fact.id);
  const conversationRef = input.conversation ? store.collection(ONBOARDING_CONVERSATIONS).doc(input.conversation.id) : null;
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<KeepBusinessFactResult> => {
      // Every read first.
      const current = await readAgentActionTx(txn, store, ctx, input.actionId);
      const factSnap = await txn.get(factRef);
      const conversationSnap = conversationRef ? await txn.get(conversationRef) : null;
      if (!current || current.action !== input.action) return { ok: false, error: "not_found" };
      for (const snap of [factSnap, conversationSnap]) {
        if (snap?.exists && snap.data()?.[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError("a kept fact's id belongs to another brand");
      }
      const plan = planAgentTransition(current, {
        to: "acted",
        by: input.by,
        at: input.at,
        expectRev: input.expectRev,
        result: { factId: input.fact.id, conversationId: input.conversation && !conversationSnap?.exists ? input.conversation.id : null },
      });
      if (!plan.ok) return { ok: false, error: plan.error };
      // A proposed action has never been kept, so its fact can't be there yet; the id is the action's.
      if (factSnap.exists) return { ok: false, error: "wrong_state" };
      txn.create(factRef, stamped(ctx, input.fact));
      const writeConversation = !!(conversationRef && input.conversation && !conversationSnap?.exists);
      if (writeConversation) txn.create(conversationRef!, stamped(ctx, input.conversation!));
      stageAgentTransition(txn, store, ctx, plan);
      return {
        ok: true,
        action: plan.next,
        fact: { ...input.fact, tenantId: ctx.tenantId },
        conversation: writeConversation ? { ...input.conversation!, tenantId: ctx.tenantId } : null,
      };
    }),
  );
}

import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { nextUpDocId } from "@/lib/types/autopilot";
import type { BasedOn, BlogBrief } from "@/lib/types/contentPlan";
import { isStrategyResultsEnabled } from "./flags";

/**
 * What a piece of work says it came from (STRATEGY_RESULTS_ENABLED): the approved strategy, and the
 * approved content plan when it fills one of its slots. The situation is kept only when it is one of
 * the strategy's focus situations. Undefined when neither made it, so nothing is written. Pure: the
 * caller passes null for what is off or not approved.
 */
export function basedOnFor(input: {
  strategy: { at: string; focusSituationIds: readonly string[] } | null;
  plan: { at: string } | null;
  situationId?: string | null;
  slotId?: string | null;
}): BasedOn | undefined {
  const strategyAt = input.strategy?.at || null;
  const slotId = input.plan && input.slotId ? input.slotId : null;
  const planAt = slotId ? input.plan!.at || null : null;
  if (!strategyAt && !planAt) return undefined;
  const situationId = strategyAt && input.situationId && input.strategy!.focusSituationIds.includes(input.situationId) ? input.situationId : null;
  return { strategyAt, planAt, situationId, slotId: planAt ? slotId : null };
}

/**
 * A brief written from one of Next up's picks ("Write it"), with what the pick came from
 * (STRATEGY_RESULTS_ENABLED): read on the server from the brand's own stored Next up, by the brief's
 * question, never from what the browser sends. The brief as it was while off, without a question,
 * or when Next up holds no such pick.
 */
export async function briefWithPick<B extends Pick<BlogBrief, "primaryRef"> & { basedOn?: BasedOn }>(ctx: TenantContext, brief: B, deps: { db?: FirestoreLike } = {}): Promise<B> {
  if (!isStrategyResultsEnabled() || !brief.primaryRef) return brief;
  const doc = await forTenant(ctx, deps.db).nextUp.getById(nextUpDocId(ctx.tenantId)).catch(() => null);
  const basedOn = doc?.picks.find((p) => p.questionId === brief.primaryRef)?.basedOn;
  return basedOn ? { ...brief, basedOn } : brief;
}

/** A brief a page saves, with the stored brief's basedOn, never the one the page sent. Pure. */
export function keptBasedOn<B extends { basedOn?: BasedOn }>(sent: B, stored: { basedOn?: BasedOn } | null | undefined): B {
  const { basedOn: _sent, ...rest } = sent;
  void _sent;
  return (stored?.basedOn !== undefined ? { ...rest, basedOn: stored.basedOn } : rest) as B;
}

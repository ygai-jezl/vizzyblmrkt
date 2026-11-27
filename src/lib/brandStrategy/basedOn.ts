import type { BasedOn } from "@/lib/types/contentPlan";

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

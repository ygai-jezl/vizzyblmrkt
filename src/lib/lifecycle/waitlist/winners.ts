import type { ContentPool, LifecycleJourney } from "@/lib/types/lifecycle";

/**
 * Which A/B winners a waitlist journey on the lifecycle engine sends. Pure, so the runner, the
 * launch's email analytics and the pick (./abTest.ts) read a pick the same way.
 */

const sameArms = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The journey's A/B winners that hold for these pools. A pick recorded with its arms
 * (abWinnerHistory) holds while the pool still has exactly those arms: the editor's
 * "A/B test this email" off and on again makes new arms, so the new test runs. A winner
 * without a recorded pick holds as before.
 */
export function liveWinners(
  journey: Pick<LifecycleJourney, "abWinners" | "abWinnerHistory">,
  pools: readonly ContentPool[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [poolId, itemId] of Object.entries(journey.abWinners ?? {})) {
    const pool = pools.find((p) => p.id === poolId);
    const picked = (journey.abWinnerHistory ?? []).findLast((h) => h.poolId === poolId && h.itemId === itemId);
    if (pool && picked && !sameArms(picked.arms, pool.items.map((i) => i.id))) continue;
    out[poolId] = itemId;
  }
  return out;
}

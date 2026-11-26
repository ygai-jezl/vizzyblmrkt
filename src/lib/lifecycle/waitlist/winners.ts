import type { ContentPool, LifecycleJourney } from "@/lib/types/lifecycle";

/**
 * Which A/B winners a waitlist journey on the lifecycle engine sends. Pure, so the runner, the
 * launch's email analytics and the pick (./abTest.ts) read a pick the same way.
 */

/**
 * Whether a winner picked from the versions `pickedArms` decides a test of the versions `arms`:
 * the test still has two or more versions, holds the winner, and every one of them was in the
 * test the pick was made from. So the same test, or an earlier shape of it with fewer versions,
 * takes the pick, and a test with a version the pick never saw runs again.
 */
export function pickHolds(pickedArms: readonly string[], winner: string, arms: readonly string[]): boolean {
  return arms.length >= 2 && arms.includes(winner) && arms.every((id) => pickedArms.includes(id));
}

/**
 * The journey's A/B winners that hold for these pools (one version's, or the draft's). A pick
 * recorded with its arms (abWinnerHistory) holds where pickHolds says so: the editor's "A/B test
 * this email" off and on again makes a new arm, so the new test runs, while people still on a
 * version from before a version was added get the winner. A winner without a recorded pick holds
 * as before.
 */
export function liveWinners(
  journey: Pick<LifecycleJourney, "abWinners" | "abWinnerHistory">,
  pools: readonly ContentPool[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [poolId, itemId] of Object.entries(journey.abWinners ?? {})) {
    const pool = pools.find((p) => p.id === poolId);
    const picked = (journey.abWinnerHistory ?? []).findLast((h) => h.poolId === poolId && h.itemId === itemId);
    if (pool && picked && !pickHolds(picked.arms, itemId, pool.items.map((i) => i.id))) continue;
    out[poolId] = itemId;
  }
  return out;
}

import type { ContentPool, PoolItem, SentItem } from "@/lib/types/lifecycle";
import { matchesEligibility, type RecipientContext } from "./fields";

/**
 * Pick what an email node sends: the FIRST item in the pool this recipient
 * hasn't already been sent (by any node) and is currently eligible for. So a
 * user who finishes onboarding on day five still starts the education pool at
 * item one, and nothing is ever sent twice. Null = nothing left (the node is
 * skipped). `excluded` (`poolId:itemId`) are items the runner couldn't render for
 * this user in this run — the next eligible one is tried instead.
 */
export function pickPoolItem(
  pool: ContentPool,
  sent: Array<Pick<SentItem, "poolId" | "itemId" | "status">>,
  rc: RecipientContext,
  excluded?: ReadonlySet<string>,
): PoolItem | null {
  const had = new Set(sent.filter((s) => s.poolId === pool.id && s.status !== "skipped").map((s) => s.itemId));
  return (
    pool.items.find(
      (item) => !had.has(item.id) && !excluded?.has(`${pool.id}:${item.id}`) && matchesEligibility(item.eligibility, rc),
    ) ?? null
  );
}

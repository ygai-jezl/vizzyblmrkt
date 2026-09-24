import { allocateVariant, CONTROL } from "@/lib/journey/allocation";
import type { ContentPool, PoolItem, SentItem } from "@/lib/types/lifecycle";
import type { RecipientContext } from "../fields";
import { pickPoolItem } from "../pools";

/**
 * What a waitlist journey's email node sends to one person. An A/B pool gives
 * the person their arm — the original engine's allocation, keyed by (node,
 * signup), so they get the same arm on either engine — or everyone the promoted
 * winner, and sends once. Any other pool works as it does for product journeys
 * (the first item not yet had and eligible). Null = nothing left to send.
 */
export function pickWaitlistItem(a: {
  nodeId: string;
  pool: ContentPool;
  signupId: string;
  sent: Array<Pick<SentItem, "poolId" | "itemId" | "status">>;
  rc: RecipientContext;
  /** Promoted A/B winners, by pool id (the journey's `abWinners`). */
  winners?: Record<string, string>;
  excluded?: ReadonlySet<string>;
}): PoolItem | null {
  const { pool } = a;
  const winner = a.winners?.[pool.id];
  const testing = Boolean(pool.abTest) && pool.items.length > 1;
  if (!winner && !testing) return pickPoolItem(pool, a.sent, a.rc, a.excluded);

  const control = pool.items[0]!;
  let item: PoolItem = control;
  if (winner) {
    item = pool.items.find((i) => i.id === winner) ?? control;
  } else {
    const { variantId } = allocateVariant(a.nodeId, a.signupId, {
      enabled: true,
      status: "running",
      splitPercent: pool.abTest!.splitPercent,
      variants: pool.items.slice(1).map((i) => ({ variantId: i.id, subject: i.subject, body: i.body })),
    });
    item = variantId === CONTROL ? control : (pool.items.find((i) => i.id === variantId) ?? control);
  }
  // One arm per person: having had any of the pool's emails means done.
  if (a.sent.some((s) => s.poolId === pool.id) || a.excluded?.has(`${pool.id}:${item.id}`)) return null;
  return item;
}

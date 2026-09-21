import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { tombstoneOf } from "./profile";

/**
 * Admin erasure (GDPR Art. 17) of one product user: their profile becomes the
 * PII-free tombstone (which blocks late events for ~30 days) and their event
 * history is deleted. Idempotent. The product itself erases a user by sending
 * `user.deleted` — this is the operator's equivalent, e.g. for a request that
 * arrives by email. Returns false when the user isn't on this connection.
 */
export async function eraseProductUser(
  ctx: TenantContext,
  connectionId: string,
  productUserId: string,
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<boolean> {
  const repo = forTenant(ctx, db);
  const user = await repo.productUsers.getById(productUserId);
  if (!user || user.connectionId !== connectionId) return false;
  await repo.productUsers.claim(productUserId, (cur) =>
    cur.status === "deleted" ? null : tombstoneOf(cur, nowMs),
  );
  await repo.productEvents.deleteWhere([["productUserId", "==", productUserId]]);
  return true;
}

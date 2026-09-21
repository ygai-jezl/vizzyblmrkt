import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { tombstoneOf } from "./profile";

/**
 * Admin erasure (GDPR Art. 17) of one product user: their profile becomes the
 * PII-free tombstone (which blocks late events for ~30 days) and their history
 * (events, journey enrolments, email engagement) is deleted. Idempotent. The product itself erases a user by sending
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
  await eraseProductUserHistory(ctx, productUserId, db);
  return true;
}

/**
 * Everything keyed to a product user beyond their profile: their event log,
 * their journey enrolments (progress + send log) and their email engagement
 * rows. Opt-outs (email_suppressions) are deliberately KEPT — honouring an
 * unsubscribe outlives the account.
 */
export async function eraseProductUserHistory(
  ctx: TenantContext,
  productUserId: string,
  db?: FirestoreLike,
): Promise<void> {
  const repo = forTenant(ctx, db);
  await repo.productEvents.deleteWhere([["productUserId", "==", productUserId]]);
  await repo.lifecycleEnrolments.deleteWhere([["productUserId", "==", productUserId]]);
  await repo.emailEvents.deleteWhere([["signupId", "==", productUserId]]);
}

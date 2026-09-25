import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { tombstoneOf } from "./profile";

/**
 * Erasure (GDPR Art. 17) of one product user. Two routes in: the product's own
 * DELETE /api/v2/users/{userId}, and this operator's equivalent (e.g. for a
 * request that arrives by email). Both leave the PII-free tombstone and run the
 * same cascade. Returns false when the user isn't on this connection.
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
  const email = user.emailNormalized ?? null;
  await repo.productUsers.claim(productUserId, (cur) =>
    cur.status === "deleted" ? null : tombstoneOf(cur, nowMs),
  );
  await eraseProductUserHistory(ctx, productUserId, db);
  if (email) await scrubSuppressionEmails(ctx, email, db);
  return true;
}

/**
 * Everything keyed to a product user beyond their profile: their event log,
 * journey enrolments (progress + send log), email engagement rows, AI drafts
 * (which hold their facts and a preview of the email) and the link from any
 * waitlist invite to them. Safe to repeat — every DELETE re-runs it.
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
  await repo.lifecycleDrafts.deleteWhere([["productUserId", "==", productUserId]]);
  // The invite stays (the waitlist side: who was invited, and the counts) but no longer points at this user.
  const invites = await repo.invites.find({ where: [["productUserId", "==", productUserId]], limit: 500 });
  for (const invite of invites) await repo.invites.update(invite.id, { productUserId: null });
}

/**
 * Opt-outs outlive the account — an unsubscribe must keep holding — but the
 * address doesn't: it's blanked on every opt-out row for it. A row's id is a
 * hash of the tenant and the address, so a later send to the same address still
 * finds it and is still suppressed.
 */
export async function scrubSuppressionEmails(ctx: TenantContext, normalizedEmail: string, db?: FirestoreLike): Promise<void> {
  const repo = forTenant(ctx, db);
  const rows = await repo.emailSuppressions.find({ where: [["normalizedEmail", "==", normalizedEmail]], limit: 100 });
  for (const row of rows) await repo.emailSuppressions.update(row.id, { email: "", normalizedEmail: "" });
}

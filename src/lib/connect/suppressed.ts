import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { enqueueConnectionWebhook } from "@/lib/lifecycle/webhooksOut";

/**
 * `email.suppressed`: tell the product when YouGrow stops emailing one of its
 * users because the address hard-bounced or they marked an email as spam
 * (CONNECT_SUPPRESSION_WEBHOOK_ENABLED). Only journey sends to a product user carry
 * the connection and the user, so only those are reported — to exactly that
 * connection. The product may want a complaint in its own consent records.
 */
export async function notifyProductOfSuppression(
  ctx: TenantContext,
  input: { connectionId: string; productUserId: string; reason: "hard_bounce" | "spam" },
  db?: FirestoreLike,
  nowMs = Date.now(),
): Promise<"queued" | "duplicate" | "skipped"> {
  const user = await forTenant(ctx, db).productUsers.getById(input.productUserId);
  if (!user || user.status !== "active" || user.connectionId !== input.connectionId) return "skipped";
  return enqueueConnectionWebhook(
    ctx,
    {
      connectionId: input.connectionId,
      type: "email.suppressed",
      data: { userId: user.externalUserId, reason: input.reason === "spam" ? "complaint" : "hard_bounce" },
      dedupeKey: `suppressed:${input.productUserId}:${input.reason}`,
    },
    db,
    nowMs,
  );
}

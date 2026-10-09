import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EnrolmentSendRef, EventMetadata } from "@/lib/email/mandrillWebhook";

/**
 * Who and what a product journey's email was, for an event the provider sends back about it.
 * The message names only its enrolment (email/mandrillWebhook.ts `enrolmentSendMetadata`: the
 * provider drops metadata that is any longer), so the journey, the person and the connection
 * are read from that enrolment here.
 *
 * Null when the enrolment has gone: the person was erased, and the event is about nobody we
 * still hold. `nodeId` is "" when the message couldn't say which email it was: the person is
 * known (a bounce or a complaint still counts), the step isn't.
 */
export async function attributionOfEnrolmentSend(
  ctx: TenantContext,
  ref: EnrolmentSendRef,
  deps: { db?: FirestoreLike; cache?: Map<string, EventMetadata | null> } = {},
): Promise<EventMetadata | null> {
  if (ref.tenantId !== ctx.tenantId) return null;
  const key = `${ref.enrolmentId}|${ref.nodeId}|${ref.variantId}`;
  const known = deps.cache?.get(key);
  if (known !== undefined) return known;
  const enrolment = await forTenant(ctx, deps.db).lifecycleEnrolments.getById(ref.enrolmentId);
  const meta: EventMetadata | null = enrolment
    ? {
        tenantId: ctx.tenantId,
        campaignId: "",
        journeyId: enrolment.journeyId,
        nodeId: ref.nodeId,
        signupId: enrolment.productUserId,
        variantId: ref.variantId || "control",
        recipientKind: "product_user",
        connectionId: enrolment.connectionId,
        enrolmentId: enrolment.id,
      }
    : null;
  deps.cache?.set(key, meta);
  return meta;
}

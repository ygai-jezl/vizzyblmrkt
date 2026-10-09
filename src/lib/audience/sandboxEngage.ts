import { z } from "zod";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { productUserDocId } from "@/lib/connect/profile";
import { zodReason } from "@/lib/connect/protocol";
import { recordEmailEvent } from "@/lib/email/events";

/**
 * A Sandbox test user opens, or clicks, the last email they were sent — without
 * anyone opening a real inbox. It records exactly the row the email provider's
 * webhook would (src/app/api/webhooks/mandrill), so a person's page, the list and
 * a journey's analytics can be checked on made-up people. Sandboxes only: a real
 * product's engagement only ever comes from the provider.
 */

export const PretendInput = z.object({
  userId: z.string().trim().min(1).max(256),
  action: z.enum(["open", "click"]),
});

export type PretendResult = { status: number; body: unknown };

const fail = (status: number, error: string, detail?: string): PretendResult => ({ status, body: { error, ...(detail ? { detail } : {}) } });

export async function pretendEngagement(
  ctx: TenantContext,
  connectionId: string,
  input: unknown,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<PretendResult> {
  const parsed = PretendInput.safeParse(input);
  if (!parsed.success) return fail(400, "invalid_input", zodReason(parsed.error));
  const repo = forTenant(ctx, deps.db);
  const conn = await repo.productConnections.getById(connectionId);
  if (!conn) return fail(404, "not_found");
  if (conn.kind !== "sandbox") return fail(400, "not_a_sandbox");
  if (!conn.sandbox?.users.some((u) => u.userId === parsed.data.userId)) return fail(404, "user_not_found");

  const personId = productUserDocId(conn.id, parsed.data.userId);
  const enrolments = await repo.lifecycleEnrolments.find({ where: [["productUserId", "==", personId]], limit: 60 });
  // The last email that really went to them: a shadow copy went to the operator's inbox instead.
  const last = enrolments
    .flatMap((enrolment) => enrolment.sentItems.filter((s) => s.status === "sent" && s.mode !== "shadow").map((sent) => ({ enrolment, sent })))
    .sort((a, b) => b.sent.at.localeCompare(a.sent.at))[0];
  if (!last) return fail(409, "no_email_sent");

  const { enrolment, sent } = last;
  const outcome = await recordEmailEvent(
    ctx,
    {
      campaignId: "",
      recipientKind: "product_user",
      connectionId: conn.id,
      // A send that kept `tracked` named its enrolment to the provider, so its rows do too.
      ...(sent.tracked ? { enrolmentId: enrolment.id } : {}),
      journeyId: enrolment.journeyId,
      nodeId: sent.nodeId,
      signupId: personId,
      variantId: sent.itemId,
      type: parsed.data.action,
      ts: new Date(deps.nowMs ?? Date.now()).toISOString(),
      ...(parsed.data.action === "click" ? { url: `https://${conn.linkDomains[0] ?? "example.com"}/` } : {}),
    },
    deps.db,
  );
  return { status: 200, body: { ok: true, outcome, personId } };
}

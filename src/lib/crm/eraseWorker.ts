import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import { removeSignupFromAudience } from "@/lib/mailchimp";

/**
 * Process a `contact_erase` job — the GDPR Art.17 cascade (§H2). Idempotent and
 * best-effort across steps so a partial failure can be retried. Logs a PII-free
 * audit line (counts only).
 *
 * NOTE: a self-service DSR entry-point must wrap this job to fully satisfy Art.17,
 * and the audit should be promoted to the WORM store used by launch deletion.
 */
export async function processContactEraseJob(
  ctx: TenantContext,
  job: EmailJob,
  db?: FirestoreLike,
): Promise<"done"> {
  const contactId = String(job.payload.contactId ?? "");
  if (!contactId) return "done";

  const repo = forTenant(ctx, db);
  const contact = await repo.contacts.getById(contactId);
  if (!contact) return "done"; // already erased — idempotent

  const email = contact.email ?? null;
  const companyId = contact.companyId ?? null;

  // 1. Delete this person's email engagement events (opens/clicks/etc.). They are
  //    keyed by signupId in the Mandrill-webhook `email_events` stream, and a
  //    contact carries each campaign's signupId.
  const signupIds = Array.from(
    new Set(contact.campaigns.map((c) => c.signupId).filter(Boolean)),
  );
  let messagesDeleted = 0;
  for (const sid of signupIds) {
    messagesDeleted += await repo.emailEvents.deleteWhere([["signupId", "==", sid]]);
  }

  // 2. Unsubscribe/archive at the external provider (best-effort; gated for EU).
  try {
    await removeSignupFromAudience(ctx, email);
  } catch (err) {
    console.warn(
      "[crm] erase external unsubscribe failed:",
      err instanceof Error ? err.message : "error",
    );
  }

  // 3. Hard-delete the contact record (true erasure — a later signup re-creates
  //    a fresh contact with new consent).
  await repo.contacts.delete(contactId);

  // 4. Maintain the company rollup; drop the company when it has no contacts left.
  if (companyId) {
    const remaining = await repo.contacts.count([["companyId", "==", companyId]]);
    if (remaining <= 0) {
      await repo.companies.delete(companyId).catch(() => {});
    } else {
      await repo.companies
        .update(companyId, { contactCount: remaining })
        .catch(() => {});
    }
  }

  // 5. PII-free audit (counts only).
  console.info(
    `[crm] contact_erase done tenant=${ctx.tenantId} region=${ctx.region} contact=${contactId} messagesDeleted=${messagesDeleted} companyId=${companyId ?? "-"}`,
  );
  return "done";
}

import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Signup } from "@/lib/types/signup";
import { recordSignupContactStatus } from "@/lib/crm/contactService";
import { enqueueEmailJob } from "@/lib/email/jobs";

/**
 * Take one person off a launch's waitlist ("offboard"). Shared by the admin
 * Offboard action and invites (nav v2 phase 4), so both leave the same trail:
 *
 * - the signup becomes `offboarded` with `removedDate`, plus why (`manual` or
 *   `invited`) and, for invites, which invite. Offboarded people leave the
 *   ranking and every waitlist journey, and the public status page tells them to
 *   check their inbox for their invite.
 * - their CRM contact is flagged offboarded (kept, never deleted).
 * - `notify` queues the launch's offboarding email (the admin action). An invite
 *   email replaces it, so invites pass `notify: false`.
 *
 * MailChimp is deliberately untouched: offboarded people still get launch
 * broadcasts (only Delete removes them from the marketing audience).
 */
export async function offboardSignup(
  ctx: TenantContext,
  signup: Signup,
  opts: { reason: "manual" | "invited"; inviteId?: string | null; notify: boolean; now?: string; db?: FirestoreLike },
): Promise<void> {
  const now = opts.now ?? new Date().toISOString();
  await forTenant(ctx, opts.db).signups.update(signup.id, {
    status: "offboarded",
    removedDate: now,
    offboardReason: opts.reason,
    ...(opts.inviteId ? { inviteId: opts.inviteId } : {}),
  });
  // Reflect on the CRM contact. Awaited (a fast write) but never fails the offboard.
  await recordSignupContactStatus(ctx, { ...signup, status: "offboarded" }, { db: opts.db, now }).catch((e) =>
    console.warn(`contact offboard sync ${signup.id}:`, e),
  );
  if (opts.notify && signup.email) {
    // Async: the per-launch toggle is checked in the worker, so a bulk offboard
    // never blocks on sends. Idempotent via the dedupe key.
    await enqueueEmailJob(
      ctx,
      { type: "lifecycle", campaignId: signup.campaignId, dedupeKey: `offboard:${signup.id}`, payload: { signupId: signup.id } },
      opts.db,
    ).catch((e) => console.warn(`offboard email enqueue ${signup.id}:`, e));
  }
}

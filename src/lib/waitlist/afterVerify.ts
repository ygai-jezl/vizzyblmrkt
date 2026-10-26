import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { syncSignupToAudience } from "@/lib/mailchimp";
import { enrolSignupInWaitlistJourney } from "@/lib/journey/router";
import { recordSignupContact } from "@/lib/crm/contactService";

/**
 * What happens once a signup is newly confirmed, wherever it was confirmed (the
 * confirmation link, or the Confirm subscription page for a site sign-up): keep the
 * marketing audience in sync, enrol them into the launch's journey (so anyone who
 * confirms after it went live still gets it), and refresh the CRM contact.
 *
 * Three best-effort, INDEPENDENT steps: each is isolated so one failing can't skip
 * the others, and none can fail the confirmation. `resubscribe`: they unsubscribed
 * before and just confirmed again (src/lib/mailchimp/sync.ts).
 */
export async function afterVerify(
  ctx: TenantContext,
  campaign: Campaign,
  signup: Signup,
  opts: { resubscribe?: boolean } = {},
): Promise<void> {
  try {
    await syncSignupToAudience(ctx, campaign, signup, { resubscribe: opts.resubscribe });
  } catch (err) {
    console.warn(`[mailchimp] audience sync on verify failed for ${campaign.id}:`, err);
  }
  try {
    await enrolSignupInWaitlistJourney(ctx, campaign.id, signup);
  } catch (err) {
    console.warn(`[journey] enrollment on verify failed for ${campaign.id}:`, err);
  }
  // Force verified state: the caller only gets here once the signup is confirmed,
  // so don't depend on the row it read being fresh.
  try {
    await recordSignupContact(ctx, campaign, { ...signup, status: "verified_active", verified: true });
  } catch (err) {
    console.warn(`[crm] contact upsert on verify failed for ${campaign.id}:`, err);
  }
}

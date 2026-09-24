import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { enrollSignupInActiveJourney, stampJourneyEngine } from "@/lib/email/delivery";
import { enrolWaitlistSignup, waitlistJourneyFor } from "@/lib/lifecycle/waitlist/enrol";

/**
 * The one door into a launch's waitlist journey (engine move). Signup and verify
 * both come through here, and the LAUNCH decides which engine emails a new
 * person (`campaign.waitlistEngine`):
 *
 *  - the original engine (the default): enrol, and stamp the person "legacy";
 *  - a rehearsal: the same, plus a shadow enrolment on the lifecycle engine that
 *    only mails the operator's inbox and stamps nobody;
 *  - the lifecycle engine: enrol there (stamping the person "lifecycle"), even
 *    while its journey is paused or the engine switched off — they wait.
 *
 * It decides once: the choice is stamped on the signup, and neither engine enrols
 * or emails someone stamped for the other.
 */
export async function enrolSignupInWaitlistJourney(
  ctx: TenantContext,
  campaignId: string,
  signup: { id: string; email?: string | null; journeyEngine?: "legacy" | "lifecycle" | null },
  db?: FirestoreLike,
): Promise<"enqueued" | "skipped"> {
  const repo = forTenant(ctx, db);
  const campaign = await repo.campaigns.getById(campaignId);
  const engine = campaign?.waitlistEngine ?? "legacy";

  if (campaign && engine === "lifecycle") {
    const target = await waitlistJourneyFor(ctx, campaignId, db);
    // Not published yet: its first publish enrols everyone verified by then.
    if (!target?.version) return "skipped";
    const fresh = await repo.signups.getById(signup.id);
    if (!fresh) return "skipped";
    const r = await enrolWaitlistSignup(ctx, { journey: target.journey, version: target.version, campaign, signup: fresh, source: "trigger" }, { db });
    return r.outcome === "enrolled" ? "enqueued" : "skipped";
  }

  if (signup.journeyEngine === "lifecycle") return "skipped";
  const r = await enrollSignupInActiveJourney(ctx, campaignId, signup, db);
  if (r === "enqueued" && !signup.journeyEngine) await stampJourneyEngine(ctx, signup.id, db);

  if (campaign && engine === "rehearsal") {
    // Best-effort: a rehearsal never affects the real welcome.
    await rehearse(ctx, campaign, signup.id, db).catch((err) =>
      console.warn(`[journey] rehearsal enrolment failed for ${campaignId}:`, err instanceof Error ? err.message : err),
    );
  }
  return r;
}

async function rehearse(
  ctx: TenantContext,
  campaign: Campaign,
  signupId: string,
  db?: FirestoreLike,
): Promise<void> {
  const target = await waitlistJourneyFor(ctx, campaign.id, db);
  if (!target?.version || target.journey.deliveryMode !== "shadow") return;
  const fresh = await forTenant(ctx, db).signups.getById(signupId);
  if (!fresh) return;
  await enrolWaitlistSignup(ctx, { journey: target.journey, version: target.version, campaign, signup: fresh, source: "trigger", rehearsal: true }, { db });
}

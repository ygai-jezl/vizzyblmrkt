import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { enrollSignupInActiveJourney, stampJourneyEngine } from "@/lib/email/delivery";

/**
 * The one door into a launch's waitlist journey (engine move D1). Signup and
 * verify both come through here, so when D5 adds the lifecycle engine a single
 * place decides which engine emails a person — and it decides once: the choice is
 * stamped on the signup, and neither engine enrols someone stamped for the other.
 * Today it always uses the original engine.
 */
export async function enrolSignupInWaitlistJourney(
  ctx: TenantContext,
  campaignId: string,
  signup: { id: string; email?: string | null; journeyEngine?: "legacy" | "lifecycle" | null },
  db?: FirestoreLike,
): Promise<"enqueued" | "skipped"> {
  if (signup.journeyEngine === "lifecycle") return "skipped";
  const r = await enrollSignupInActiveJourney(ctx, campaignId, signup, db);
  if (r === "enqueued" && !signup.journeyEngine) await stampJourneyEngine(ctx, signup.id, db);
  return r;
}

import { usageMeter } from "@/lib/plans/meter";
import { markVoiceDone } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { voiceDayOf } from "@/lib/types/businessProfile";
import type { OnboardingConversation } from "@/lib/types/onboarding";
import { closeStaleConversations } from "../store";

/**
 * What follows the end of a Talk with Vizzy call (ONBOARDING_VOICE_ENABLED), run once by whatever
 * ended it: the end route, or the brand's next start for a call left open. Server only.
 */

export interface CallDeps {
  db?: FirestoreLike;
}

/**
 * Count the call's seconds in the usage meter (Voice conversations), and use up the brand's call
 * for the day when someone spoke. A dropped call ("error") leaves the day, so its starts are
 * still there to try again.
 */
export async function afterCallEnded(ctx: TenantContext, c: OnboardingConversation, deps: CallDeps = {}): Promise<void> {
  if (c.source !== "voice") return;
  if (c.meteredSeconds > 0) await usageMeter(ctx, "voice_seconds", "onboarding_voice", { db: deps.db }).record(c.meteredSeconds);
  const spoke = (c.turns ?? []).some((t) => t.who === "member");
  if (spoke && c.endReason !== "error") await markVoiceDone(ctx.tenantId, voiceDayOf(c.startedAt), deps.db).catch(() => false);
}

/** Close the brand's calls left open (a tab closed with no end) and count them, before a new one. */
export async function closeStaleCalls(ctx: TenantContext, deps: CallDeps & { now?: () => number } = {}): Promise<number> {
  const closed = await closeStaleConversations(ctx, deps);
  for (const c of closed) await afterCallEnded(ctx, c, deps);
  return closed.length;
}

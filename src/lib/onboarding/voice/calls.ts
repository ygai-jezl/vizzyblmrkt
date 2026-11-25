import { usageMeter } from "@/lib/plans/meter";
import { markVoiceDone } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { voiceDayOf } from "@/lib/types/businessProfile";
import type { OnboardingConversation } from "@/lib/types/onboarding";
import { closeStaleConversations, deleteConversation } from "../store";

/**
 * What follows the end of a Talk with Vizzy call (ONBOARDING_VOICE_ENABLED), run once by whatever
 * ended it: the end route, or the brand's next start for a call left open. Server only.
 */

export interface CallDeps {
  db?: FirestoreLike;
}

/** Whether the member said anything on the call (Vizzy's lines alone don't count). */
export function memberSpoke(c: Pick<OnboardingConversation, "turns">): boolean {
  return (c.turns ?? []).some((t) => t.who === "member");
}

/**
 * Count the call's seconds in the usage meter (Voice conversations), and use up the brand's call
 * for the day when someone spoke. A dropped call ("error") leaves the day, so its starts are
 * still there to try again, and so does a call left open (`leftOpen`, closed by the next start):
 * it never ended, so no one saw what Vizzy learned from it.
 */
export async function afterCallEnded(ctx: TenantContext, c: OnboardingConversation, deps: CallDeps & { leftOpen?: boolean } = {}): Promise<void> {
  if (c.source !== "voice") return;
  if (c.meteredSeconds > 0) await usageMeter(ctx, "voice_seconds", "onboarding_voice", { db: deps.db }).record(c.meteredSeconds);
  if (memberSpoke(c) && c.endReason !== "error" && !deps.leftOpen) await markVoiceDone(ctx.tenantId, voiceDayOf(c.startedAt), deps.db).catch(() => false);
}

/**
 * A call where the member never spoke (it never connected, it dropped first, or they ended it
 * first) is not kept: once it is counted, it is deleted, so it never lists in Settings, never
 * makes it "Talk with Vizzy again" and never counts toward the 20 kept. True when it was deleted.
 */
export async function dropIfSilent(ctx: TenantContext, c: OnboardingConversation, deps: CallDeps = {}): Promise<boolean> {
  if (c.source !== "voice" || c.status !== "ended" || memberSpoke(c)) return false;
  const gone = await deleteConversation(ctx, c.id, { db: deps.db }).catch(() => null);
  return !!gone?.ok;
}

/** Close the brand's calls left open (a tab closed with no end) and count them, before a new one. */
export async function closeStaleCalls(ctx: TenantContext, deps: CallDeps & { now?: () => number } = {}): Promise<number> {
  const closed = await closeStaleConversations(ctx, deps);
  for (const c of closed) {
    await afterCallEnded(ctx, c, { ...deps, leftOpen: true });
    await dropIfSilent(ctx, c, deps);
  }
  return closed.length;
}

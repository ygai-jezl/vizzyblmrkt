import { isLiveConfigured } from "@/lib/agents/gemini";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import type { Tenant } from "@/lib/types/tenant";
import { isOnboardingVoiceEnabled } from "./flags";

/**
 * Talk with Vizzy, for the welcome and Settings: the voice switch, a Live API key, and this
 * brand's access (every plan has it; a copy may keep it for granted brands). Server only. No read:
 * the caller passes the brand it already has.
 */
export function mayTalkWithVizzy(tenant: Tenant | null): boolean {
  return isOnboardingVoiceEnabled() && isLiveConfigured() && tenantMayUse(tenant, "onboarding_voice");
}

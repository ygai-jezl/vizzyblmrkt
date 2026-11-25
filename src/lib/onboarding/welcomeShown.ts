import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { shouldWelcome } from "@/lib/onboarding/firstVisit";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { isEmailStyleUiEnabled } from "@/lib/email/flags";
import { isBrandMapUiEnabled } from "@/lib/brandMap/flags";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { startBusinessProfile } from "@/lib/tenant/control";

export interface WelcomeShownDeps {
  loadSignals?: typeof loadGrowthSignals;
  start?: (tenantId: string) => Promise<boolean>;
}

/**
 * The welcome marks itself shown (the profile `started`), once per brand, when it renders for a
 * brand Home would send here (shouldWelcome, with the same reads Home makes). Home only redirects:
 * a redirect can be lost (a refresh racing it, a prefetch), and a welcome marked shown before anyone
 * saw it never comes back. A brand that already has a profile, a member, or a busy brand that opens
 * the welcome from Settings is left alone, so its sidebar stays as it is. Fails soft: false.
 */
export async function markWelcomeShown(
  ctx: TenantContext,
  tenant: Pick<Tenant, "businessProfile" | "emailSenderConfig" | "socialConnections" | "gitConnections" | "brandVoice"> | null,
  deps: WelcomeShownDeps = {},
): Promise<boolean> {
  if (!isOnboardingEnabled() || ctx.role !== "admin" || !tenant || tenant.businessProfile) return false;
  try {
    const guide = isSetupGuideEnabled();
    const signals = await (deps.loadSignals ?? loadGrowthSignals)(ctx, {
      lifecycle: isLifecycleEnabled(),
      setup: guide ? { emailStyle: isEmailStyleUiEnabled(), brandMap: isBrandMapUiEnabled() } : undefined,
    });
    if (!shouldWelcome(tenant, signals, ctx.role)) return false;
    return await (deps.start ?? ((id: string) => startBusinessProfile(id)))(ctx.tenantId);
  } catch {
    return false;
  }
}

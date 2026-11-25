import { notFound, redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { deriveFaviconUrl, getTenantById } from "@/lib/tenant";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { isLiveConfigured } from "@/lib/agents/gemini";
import { isOnboardingEnabled, isOnboardingVoiceEnabled } from "@/lib/onboarding/flags";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { OnboardingFrame } from "@/components/admin/onboarding/OnboardingFrame";

export const dynamic = "force-dynamic";

/**
 * The getting to know you pages (ONBOARDING_ENABLED, with nav v2 phase 2): the welcome, the
 * 4 quick questions and what Vizzy learned. Admins only: a member goes to Home. One read of the
 * brand for its name, its mark and the answers so far, shared by every screen under it.
 */
export default async function WelcomeLayout({ children }: { children: React.ReactNode }) {
  if (!isOnboardingEnabled() || !isNavV2Phase2Enabled()) notFound();
  const ctx = await requireAdminContext();
  if (ctx.role !== "admin") redirect("/admin");
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const brand = {
    name: tenant?.tenantName ?? ctx.tenantId,
    faviconUrl: tenant?.faviconUrl || (tenant ? deriveFaviconUrl(tenant.rootDomain) : undefined),
  };
  // Talk with Vizzy: the voice switch, a Live API key, and this brand's access (every plan has it;
  // a copy may keep it for granted brands). Without it the questions are the main choice.
  const voice = isOnboardingVoiceEnabled() && isLiveConfigured() && tenantMayUse(tenant, "onboarding_voice");
  return (
    <OnboardingFrame brand={brand} voice={voice} answers={tenant?.businessProfile?.answers ?? {}}>
      {children}
    </OnboardingFrame>
  );
}

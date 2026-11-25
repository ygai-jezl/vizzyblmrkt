import { notFound, redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { deriveFaviconUrl, getTenantById } from "@/lib/tenant";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
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
  // Talk with Vizzy waits for the voice call; until then the questions are the main choice.
  const voice = false;
  return (
    <OnboardingFrame brand={brand} voice={voice} answers={tenant?.businessProfile?.answers ?? {}}>
      {children}
    </OnboardingFrame>
  );
}

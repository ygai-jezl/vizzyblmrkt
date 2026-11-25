import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { markWelcomeShown } from "@/lib/onboarding/welcomeShown";
import { WelcomeScreen } from "@/components/admin/onboarding/WelcomeScreen";

export const dynamic = "force-dynamic";

/**
 * The welcome (the layout checks the switch and the admin). Rendering it for a new brand marks it
 * shown, once per brand (markWelcomeShown): Home only redirects here.
 */
export default async function WelcomePage() {
  const ctx = await requireAdminContext();
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  await markWelcomeShown(ctx, tenant);
  return <WelcomeScreen />;
}

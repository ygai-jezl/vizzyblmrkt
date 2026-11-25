import { NextResponse } from "next/server";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { computeGrowth } from "@/lib/nav/growth";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";
import { isBrandMapUiEnabled } from "@/lib/brandMap/flags";
import { isEmailStyleUiEnabled } from "@/lib/email/flags";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isOnboardingEnabled } from "@/lib/onboarding/flags";
import { growSidebarReveal } from "@/lib/onboarding/revealFacts";
import { getTenantById } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * The growth path's stage statuses, for the sidebar's progress dots (nav v2 phase 2).
 * With the setup guide on, every step too, for the How to drawer and Vizzy, in the words the
 * screens use (Create an idea, with the Ideas words on).
 *
 * With ONBOARDING_ENABLED, for a brand whose sidebar has Coming up (`tenant.sidebarReveal`), also
 * `reveal.shown`: the sections it shows now. A waiting section that now holds data is stored, so it
 * never hides again; the tenant doc is written only when that set grows. Any member may call this.
 */
export async function GET(req: Request) {
  if (!isNavV2Phase2Enabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const guide = isSetupGuideEnabled();
  const [signals, tenant] = await Promise.all([
    loadGrowthSignals(ctx, {
      lifecycle: isLifecycleEnabled(),
      invites: isInvitesUiEnabled() && isInvitesEnabled(),
      setup: guide ? { emailStyle: isEmailStyleUiEnabled(), brandMap: isBrandMapUiEnabled() } : undefined,
    }),
    // One more read, only while getting to know you is on. A blip leaves the sidebar as the page drew it.
    isOnboardingEnabled() ? getTenantById(ctx.tenantId).catch(() => null) : Promise.resolve(null),
  ]);
  const growth = computeGrowth(signals, { ideas: isIdeaWordsEnabled() });
  const stored = tenant?.sidebarReveal;
  const reveal = stored
    ? await growSidebarReveal(ctx, { sidebarReveal: stored, businessProfile: tenant.businessProfile }, signals).catch(() => null)
    : null;
  return NextResponse.json(
    {
      stages: growth.stages.map((s) => ({ key: s.key, status: s.status })),
      allRunning: growth.allRunning,
      ...(guide ? { steps: growth.stages.flatMap((s) => s.steps) } : {}),
      ...(reveal ? { reveal } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

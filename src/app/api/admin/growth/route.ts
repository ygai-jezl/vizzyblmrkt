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

export const dynamic = "force-dynamic";

/**
 * The growth path's stage statuses, for the sidebar's progress dots (nav v2 phase 2).
 * With the setup guide on, every step too, for the How to drawer and Vizzy.
 */
export async function GET(req: Request) {
  if (!isNavV2Phase2Enabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const guide = isSetupGuideEnabled();
  const growth = computeGrowth(
    await loadGrowthSignals(ctx, {
      lifecycle: isLifecycleEnabled(),
      invites: isInvitesUiEnabled() && isInvitesEnabled(),
      setup: guide ? { emailStyle: isEmailStyleUiEnabled(), brandMap: isBrandMapUiEnabled() } : undefined,
    }),
  );
  return NextResponse.json(
    {
      stages: growth.stages.map((s) => ({ key: s.key, status: s.status })),
      allRunning: growth.allRunning,
      ...(guide ? { steps: growth.stages.flatMap((s) => s.steps) } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { computeGrowth } from "@/lib/nav/growth";
import { loadGrowthSignals } from "@/lib/nav/growthSignals";

export const dynamic = "force-dynamic";

/** The growth path's stage statuses, for the sidebar's progress dots (nav v2 phase 2). */
export async function GET(req: Request) {
  if (!isNavV2Phase2Enabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const growth = computeGrowth(
    await loadGrowthSignals(ctx, { lifecycle: isLifecycleEnabled(), invites: isInvitesUiEnabled() && isInvitesEnabled() }),
  );
  return NextResponse.json(
    {
      stages: growth.stages.map((s) => ({ key: s.key, status: s.status })),
      allRunning: growth.allRunning,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

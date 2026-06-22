import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { journeyIdFor } from "@/lib/journey/service";
import { computeHybridSequenceBreakdown } from "@/lib/analytics/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ campaignId: string; journeyId: string }> };

/** Per-email (per-node) breakdown for one sequence, with per-A/B-arm sub-rows. */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, journeyId } = await params;
  // Defend against a mismatched id in the path: a launch's journey id is
  // deterministic, so ignore whatever was passed and derive it.
  const expected = journeyIdFor(campaignId);
  if (journeyId !== expected) {
    return NextResponse.json({ error: "journey_mismatch" }, { status: 400 });
  }
  const breakdown = await computeHybridSequenceBreakdown(ctx, expected);
  return NextResponse.json({ breakdown });
}

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { computeHybridEmailAnalytics } from "@/lib/analytics/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ campaignId: string }> };

/** Launch-wide email engagement: KPI cards + one row per sequence and broadcast. */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const analytics = await computeHybridEmailAnalytics(ctx, campaignId);
  return NextResponse.json({ analytics });
}

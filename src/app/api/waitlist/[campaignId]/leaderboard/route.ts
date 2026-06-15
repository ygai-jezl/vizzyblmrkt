import { NextResponse } from "next/server";
import {
  resolveTenantFromOrigin,
  forTenant,
  TenantNotFoundError,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { getLeaderboard } from "@/lib/waitlist/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated leaderboard. The payload is fully PII-masked and
 * cacheable: `s-maxage` lets the CDN serve it without re-querying Firestore on
 * every hit. The response is cookie-free so the CDN will actually cache it.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const origin = originFromHeaders(req.headers);

  let ctx;
  try {
    ctx = await resolveTenantFromOrigin(origin);
  } catch (err) {
    if (err instanceof TenantNotFoundError) {
      return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
    }
    throw err;
  }

  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  const leaderboard = await getLeaderboard(ctx, campaign);

  return NextResponse.json(
    { leaderboard },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    },
  );
}

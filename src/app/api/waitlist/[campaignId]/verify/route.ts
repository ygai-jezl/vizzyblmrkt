import { NextResponse } from "next/server";
import {
  resolveTenantFromOrigin,
  forTenant,
  verifySignupByToken,
  creditReferral,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Double opt-in confirmation link (GET). Atomically verifies the signup, credits
 * the referrer (once), and redirects back to the hosted page with a status.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const origin = originFromHeaders(req.headers);

  // Always redirect to a relative path resolved against the request URL — never
  // reflect a (spoofable) Host header into the Location.
  const back = (param: string) =>
    NextResponse.redirect(
      new URL(`/waitlist/${encodeURIComponent(campaignId)}?${param}`, req.url),
    );

  const ctx = await resolveTenantFromOrigin(origin).catch(() => null);
  if (!ctx) return back("verify=invalid");

  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) return back("verify=invalid");

  const result = await verifySignupByToken(ctx, campaignId, token);

  if (result.status === "verified" && result.referredBySignupToken) {
    // The referee is now verified → credit the referrer (once).
    try {
      await creditReferral(
        ctx,
        campaign.id,
        result.referredBySignupToken,
        result.referralToken!,
        campaign.spotsToMoveUponReferral,
      );
    } catch (err) {
      console.warn(`referral credit on verify failed for ${campaign.id}:`, err);
    }
  }

  return back(
    result.status === "verified" || result.status === "already_verified"
      ? "verified=1"
      : "verify=invalid",
  );
}

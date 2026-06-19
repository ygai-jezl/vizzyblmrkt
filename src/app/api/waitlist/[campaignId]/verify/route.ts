import { NextResponse } from "next/server";
import {
  resolveTenantForRequest,
  forTenant,
  verifySignupByToken,
  creditReferral,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { tenantParamFromUrl, appendTenantParam } from "@/lib/http/tenantParam";
import { syncSignupToAudience } from "@/lib/mailchimp";
import { enrollSignupInActiveJourney } from "@/lib/email/delivery";

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
  const tenantId = tenantParamFromUrl(req.url);

  // Emit a RELATIVE Location: the browser resolves it against the public URL it
  // actually navigated to (the host in the confirmation email). This never
  // reflects a (spoofable) Host header, and — critically — avoids `req.url`,
  // which on App Hosting/Cloud Run is the internal bind (http://0.0.0.0:8080)
  // and would otherwise produce an unreachable Location. Carry the ?t= hint so
  // the hosted page resolves the same tenant on the shared platform host.
  const back = (param: string) =>
    new NextResponse(null, {
      // 303 See Other: this GET performed a side effect (verification); send the
      // client on to the result page with a plain GET.
      status: 303,
      headers: {
        Location: appendTenantParam(
          `/waitlist/${encodeURIComponent(campaignId)}?${param}`,
          tenantId,
        ),
      },
    });

  const ctx = await resolveTenantForRequest({ tenantId, origin }).catch(() => null);
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

  // Newly verified → push them into the marketing audience (best-effort). The
  // verification token is not cleared on verify, so it still resolves the row.
  if (result.status === "verified") {
    const rows = await forTenant(ctx)
      .signups.find({
        where: [
          ["campaignId", "==", campaignId],
          ["verificationToken", "==", token],
        ],
        limit: 1,
      })
      .catch(() => []);
    const signup = rows[0];
    if (signup) {
      // Two best-effort, INDEPENDENT side effects: keep the marketing audience in
      // sync, and enrol the new subscriber into the active journey (so late
      // joiners — anyone verifying after the journey was activated — still get the
      // sequence). Each is isolated so one failing can't skip the other, and
      // neither can break the verification redirect.
      try {
        await syncSignupToAudience(ctx, campaign, signup);
      } catch (err) {
        console.warn(
          `[mailchimp] audience sync on verify failed for ${campaign.id}:`,
          err,
        );
      }
      try {
        await enrollSignupInActiveJourney(ctx, campaign.id, signup);
      } catch (err) {
        console.warn(
          `[journey] enrollment on verify failed for ${campaign.id}:`,
          err,
        );
      }
    }
  }

  if (result.status === "verified" || result.status === "already_verified") {
    // Carry the verified signup's (already-public) referral token so the hosted
    // landing can resolve the signup and render the FULL post-signup payoff —
    // referral link, share buttons, position, and the voice CTA — instead of a
    // bare "email confirmed" notice. Critical for embed signups, whose confirm
    // link is a top-level navigation off the customer's site onto our host.
    const rt = result.referralToken
      ? `&rt=${encodeURIComponent(result.referralToken)}`
      : "";
    return back(`verified=1${rt}`);
  }
  return back("verify=invalid");
}

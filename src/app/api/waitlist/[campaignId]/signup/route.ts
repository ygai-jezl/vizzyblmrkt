import { NextResponse } from "next/server";
import {
  resolveTenantFromOrigin,
  forTenant,
  creditReferral,
  TenantNotFoundError,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import {
  SignupInputSchema,
  validateSignupAgainstCampaign,
} from "@/lib/waitlist/signupInput";
import { createSignup } from "@/lib/waitlist/signupService";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const origin = originFromHeaders(req.headers);

  // Resolve tenant + region from the request host (routing only).
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

  // Shape validation (strict: rejects unknown fields).
  const body: unknown = await req.json().catch(() => null);
  const parsed = SignupInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  // Campaign-specific validation (required contact, name, answers vs questions).
  const v = validateSignupAgainstCampaign(campaign, parsed.data);
  if (!v.ok) {
    return NextResponse.json(
      { error: "validation_failed", issues: v.errors },
      { status: 400 },
    );
  }

  // Bot defense (feature-flagged; passes through when disabled).
  const captcha = await verifyRecaptcha(parsed.data.recaptchaToken, "signup");
  if (!captcha.ok) {
    return NextResponse.json(
      { error: "captcha_failed", reason: captcha.reason },
      { status: 400 },
    );
  }

  const result = await createSignup(ctx, campaign, parsed.data, {
    hostedPageBaseUrl: origin,
    captchaValid: captcha.ok && !captcha.skipped,
  });

  // Credit the referrer — only on a genuinely NEW, verified signup (idempotent
  // re-submits skip this). A credit failure must never fail the signup itself.
  if (
    !result.alreadyJoined &&
    result.signup.status === "verified_active" &&
    parsed.data.referredBySignupToken
  ) {
    try {
      await creditReferral(
        ctx,
        campaign.id,
        parsed.data.referredBySignupToken,
        result.signup.referralToken,
        campaign.spotsToMoveUponReferral,
      );
    } catch (err) {
      // Best-effort: never block the signup on referral attribution. Log so a
      // dropped credit is observable (transient Firestore/contention error).
      console.warn(
        `referral credit failed for campaign=${campaign.id} referrer=${parsed.data.referredBySignupToken}:`,
        err,
      );
    }
  }

  return NextResponse.json(
    {
      alreadyJoined: result.alreadyJoined,
      status: result.signup.status,
      referralToken: result.signup.referralToken,
      referralLink: result.signup.referralLink,
      totalSignups: result.totalSignups,
    },
    { status: result.alreadyJoined ? 200 : 201 },
  );
}

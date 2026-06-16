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
import { computeRanks } from "@/lib/waitlist/rank";
import {
  DEFAULT_SHARE_MESSAGE,
  parseEnabledPlatforms,
} from "@/lib/waitlist/socialPlatforms";
import { renderMergeVars } from "@/lib/email/mergeVars";
import { verifyRecaptcha } from "@/lib/security/recaptcha";
import { sendEmail } from "@/lib/email";
import { verificationEmail } from "@/lib/email/templates";
import { syncSignupToAudience } from "@/lib/mailchimp";

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

  // Double opt-in: an unverified signup gets a confirmation email; the referrer
  // is credited only once the referee verifies (see the verify route).
  if (
    !result.alreadyJoined &&
    result.signup.status === "unverified" &&
    result.signup.email &&
    result.signup.verificationToken
  ) {
    const verifyUrl = `${origin}/api/waitlist/${campaign.id}/verify?token=${encodeURIComponent(result.signup.verificationToken)}`;
    let emailSent = false;
    try {
      const r = await sendEmail(
        verificationEmail({
          to: result.signup.email,
          waitlistName: campaign.waitlistName,
          firstName: result.signup.firstName,
          verifyUrl,
        }),
      );
      emailSent = r.sent;
    } catch (err) {
      console.warn(`verification email failed for ${campaign.id}:`, err);
    }
    // If a verification-required campaign couldn't actually send the email in a
    // real environment (no/broken provider), don't strand the user as a stuck
    // unverified signup: remove it and fail loudly so a retry can try again.
    // The emulator log-provider path (dev/tests) is intentionally allowed.
    if (!emailSent && !process.env.FIRESTORE_EMULATOR_HOST) {
      try {
        await forTenant(ctx).signups.delete(result.signup.id);
      } catch {
        /* best effort */
      }
      return NextResponse.json(
        { error: "verification_unavailable" },
        { status: 503 },
      );
    }
  }

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

  // No-verification campaigns are verified_active immediately → sync to the
  // marketing audience now (verification campaigns sync on the verify step).
  if (
    !result.alreadyJoined &&
    result.signup.status === "verified_active" &&
    result.signup.email
  ) {
    try {
      await syncSignupToAudience(ctx, campaign, result.signup);
    } catch (err) {
      console.warn(
        `[mailchimp] audience sync on signup failed for ${campaign.id}:`,
        err,
      );
    }
  }

  // Gamified payoff: the verified user's live position + a ready-to-share message.
  // Rank only exists once verified_active (unverified signups aren't counted yet).
  let rank: number | null = null;
  if (result.signup.status === "verified_active") {
    try {
      const ranks = await computeRanks(ctx, campaign.id);
      rank = ranks.get(result.signup.id) ?? null;
    } catch (err) {
      console.warn(`rank computation failed for ${campaign.id}:`, err);
    }
  }
  const shareMessage = renderMergeVars(
    campaign.configurationStyleJson.shareMessage || DEFAULT_SHARE_MESSAGE,
    { signup: result.signup, campaign, rank: rank ?? undefined },
  );

  return NextResponse.json(
    {
      alreadyJoined: result.alreadyJoined,
      status: result.signup.status,
      needsVerification: result.signup.status === "unverified",
      referralToken: result.signup.referralToken,
      referralLink: result.signup.referralLink,
      totalSignups: result.totalSignups,
      // Post-signup share section (see components/waitlist/ShareSection).
      rank,
      amountReferred: result.signup.amountReferred,
      hideCounts: campaign.hideCounts,
      shareMessage,
      enabledSharePlatforms: parseEnabledPlatforms(
        campaign.configurationStyleJson.enabledSharePlatforms,
      ),
      // Emulator-only test hook — never exposed against real Firestore.
      ...(process.env.FIRESTORE_EMULATOR_HOST && result.signup.verificationToken
        ? { _devVerificationToken: result.signup.verificationToken }
        : {}),
    },
    { status: result.alreadyJoined ? 200 : 201 },
  );
}

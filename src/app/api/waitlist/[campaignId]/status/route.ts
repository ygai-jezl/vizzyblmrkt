import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveTenantForRequest,
  forTenant,
  TenantNotFoundError,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { tenantParamFromUrl } from "@/lib/http/tenantParam";
import {
  deterministicSignupId,
  normalizeEmail,
} from "@/lib/waitlist/identifiers";
import { buildSharePayload } from "@/lib/waitlist/postSignup";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Signed up before? Check your status." A returning visitor enters their email
 * and gets their live waitlist position, referral count, status and referral
 * link back instantly. Email-keyed (we recompute the deterministic signup id, a
 * single doc read — no query); phone-only signups aren't lookup-able here.
 *
 * Email enumeration is an accepted trade-off (matches the public reference), so
 * reCAPTCHA is the only abuse control — there is no rate-limit infra to lean on.
 */
// Mirror the signup route's email validation (lib/waitlist/signupInput EMAIL_RE).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const StatusInputSchema = z
  .object({
    email: z.string().trim().max(320).regex(EMAIL_RE, "invalid email"),
    recaptchaToken: z.string().optional(),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const origin = originFromHeaders(req.headers);
  const tenantId = tenantParamFromUrl(req.url);

  let ctx;
  try {
    ctx = await resolveTenantForRequest({ tenantId, origin });
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

  const body: unknown = await req.json().catch(() => null);
  const parsed = StatusInputSchema.safeParse(body);
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

  const captcha = await verifyRecaptcha(parsed.data.recaptchaToken, "status");
  if (!captcha.ok) {
    return NextResponse.json(
      { error: "captcha_failed", reason: captcha.reason },
      { status: 400 },
    );
  }

  const id = deterministicSignupId(campaign.id, normalizeEmail(parsed.data.email));
  const signup = await forTenant(ctx).signups.getById(id);

  // Missing and soft-deleted both read as "nothing to show".
  if (!signup || signup.status === "deleted") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (signup.status === "unverified") {
    return NextResponse.json({
      status: "unverified",
      message: "Confirm your email to lock in your spot.",
    });
  }

  if (signup.status === "offboarded") {
    return NextResponse.json({
      status: "offboarded",
      message: "You've been moved off the waitlist — check your inbox for your invite.",
    });
  }

  // verified_active — the user's own data, returned unmasked.
  const share = await buildSharePayload(ctx, campaign, signup);
  return NextResponse.json({ status: "verified_active", ...share });
}

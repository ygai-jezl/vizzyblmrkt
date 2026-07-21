import { NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveTenantForRequest,
  forTenant,
  TenantNotFoundError,
} from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { tenantParamFromUrl } from "@/lib/http/tenantParam";
import { verifyRecaptcha } from "@/lib/security/recaptcha";
import { isClosed, WAITLIST_CLOSED } from "@/lib/waitlist/closed";
import { getLiveTokenClient } from "@/lib/agents/gemini";
import { LIVE_MODEL, buildLiveConnectConfig } from "@/lib/agents/liveConversation";
import { activeBrandVoiceText } from "@/lib/content/create/activeBrandVoice";
import { isLiveSupportedLocale, resolveCampaignLocale } from "@/lib/i18n/locale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Browser proof-of-signup + bot token. The referralToken is only ever handed to
 * a successful signup, so it doubles as a lightweight ownership credential. */
const TokenRequestSchema = z
  .object({
    referralToken: z.string().min(1).max(64),
    recaptchaToken: z.string().optional(),
  })
  .strict();

/**
 * Mint a short-lived, single-use Gemini Live ephemeral token for the post-signup
 * voice conversation. Public-callable (no admin session) but abuse-resistant:
 * the caller must prove a real signup, pass reCAPTCHA, and the model + per-launch
 * system instruction are LOCKED into the token server-side (never sent to the
 * browser). The token is `uses: 1`, expires quickly, and is scoped to this
 * campaign's context.
 */
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
  // Closed launch: minting a token is new participation (and grants a leaderboard
  // boost), so it stops once the launch is archived.
  if (isClosed(campaign)) {
    return NextResponse.json({ error: WAITLIST_CLOSED }, { status: 409 });
  }
  // Feature gate: the whole conversation surface is off unless the launch enabled it.
  if (!campaign.aiConversation?.enabled) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }

  // Graceful degradation when no Developer-API key is provisioned.
  const live = getLiveTokenClient();
  if (!live) {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const parsed = TokenRequestSchema.safeParse(await req.json().catch(() => null));
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

  // Bot defense (feature-flagged; passes through when disabled).
  const captcha = await verifyRecaptcha(parsed.data.recaptchaToken, "conversation");
  if (!captcha.ok) {
    return NextResponse.json(
      { error: "captcha_failed", reason: captcha.reason },
      { status: 400 },
    );
  }

  // Abuse gate: the caller must own a real signup in THIS campaign. Equality-only
  // query (tenant predicate is injected) — no composite index required.
  const [owner] = await forTenant(ctx).signups.find({
    where: [
      ["campaignId", "==", campaignId],
      ["referralToken", "==", parsed.data.referralToken],
    ],
    limit: 1,
  });
  if (!owner || owner.status === "deleted" || owner.status === "offboarded") {
    return NextResponse.json({ error: "no_signup" }, { status: 403 });
  }
  // One conversation per signup.
  if (owner.aiConversation?.completed) {
    return NextResponse.json({ error: "already_completed" }, { status: 409 });
  }

  // The native-audio Live model only speaks the languages in the Live voice set.
  // If the launch's content language is text-only (e.g. zh), fall back to an
  // English voice chat rather than asking the model to speak a language it can't.
  const contentLocale = resolveCampaignLocale(campaign);
  const voiceLocale = isLiveSupportedLocale(contentLocale) ? contentLocale : "en";

  // Tenant-global authored brand voice — the assistant embodies it (null ⇒ tone enum only).
  const brandVoice = await activeBrandVoiceText(ctx.tenantId);

  try {
    const token = await live.authTokens.create({
      config: {
        uses: 1,
        // 30 min to send messages over the connection; 1 min to START a session.
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
        // Lock the model + per-launch prompt/modality server-side.
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: buildLiveConnectConfig(campaign, voiceLocale, brandVoice),
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    if (!token.name) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    return NextResponse.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    console.warn(`[live] ephemeral token mint failed for ${campaignId}:`, err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

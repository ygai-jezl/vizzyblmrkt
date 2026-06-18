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
import { computeRanks } from "@/lib/waitlist/rank";
import type { AiConversationData } from "@/lib/types/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CompleteRequestSchema = z
  .object({
    referralToken: z.string().min(1).max(64),
    transcript: z
      .array(
        z.object({
          role: z.enum(["user", "model"]),
          text: z.string().max(4000),
        }),
      )
      .max(200),
    summary: z.string().max(4000).optional(),
    recaptchaToken: z.string().optional(),
  })
  .strict();

/**
 * Persist the captured "golden data" from a completed Gemini Live voice
 * conversation onto the signup, and apply the one-time leaderboard boost. Same
 * tenant resolution + reCAPTCHA + proof-of-signup gate as the token route.
 * Idempotent: a re-submitted completion returns `already: true` without
 * re-crediting.
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
  if (!campaign.aiConversation?.enabled) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }

  const parsed = CompleteRequestSchema.safeParse(
    await req.json().catch(() => null),
  );
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

  const captcha = await verifyRecaptcha(parsed.data.recaptchaToken, "conversation");
  if (!captcha.ok) {
    return NextResponse.json(
      { error: "captcha_failed", reason: captcha.reason },
      { status: 400 },
    );
  }

  // Proof-of-signup gate (equality-only query; tenant predicate injected).
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

  // Idempotent: a completed conversation is terminal — don't overwrite or re-credit.
  if (owner.aiConversation?.completed) {
    return NextResponse.json({ ok: true, already: true });
  }

  const bonus = campaign.aiConversation.leaderboardBonus ?? 0;
  const aiConversation: AiConversationData = {
    completed: true,
    transcript: parsed.data.transcript,
    capturedAt: new Date().toISOString(),
    bonusApplied: bonus > 0,
    ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
  };

  await forTenant(ctx).signups.update(owner.id, {
    aiConversation,
    engagementBonus: bonus,
  });

  // Best-effort new queue position to show the user ("Spot boosted!"). Only
  // verified signups are ranked; never let a rank read fail the completion.
  let rank: number | undefined;
  if (bonus > 0 && owner.status === "verified_active") {
    try {
      rank = (await computeRanks(ctx, campaignId)).get(owner.id);
    } catch (err) {
      console.warn(`[live] rank recompute failed for ${campaignId}:`, err);
    }
  }

  return NextResponse.json({ ok: true, bonus, ...(rank != null ? { rank } : {}) });
}

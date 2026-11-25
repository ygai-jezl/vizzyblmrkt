import { z } from "zod";
import { getLiveTokenClient } from "@/lib/agents/gemini";
import { fail, invalidInput, ok, onboardingAdmin, readJsonBody, refused } from "@/lib/onboarding/api";
import { countConversations, startConversation } from "@/lib/onboarding/store";
import { closeStaleCalls } from "@/lib/onboarding/voice/calls";
import { buildOnboardingLiveConfig, CALL_SECONDS } from "@/lib/onboarding/voice/config";
import { mintOnboardingVoiceToken } from "@/lib/onboarding/voice/mint";
import { brandCanUse } from "@/lib/plans/brandAccess";
import { getTenantById } from "@/lib/tenant";
import { claimVoiceStart, releaseVoiceStart } from "@/lib/tenant/control";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { voiceDayOf } from "@/lib/types/businessProfile";
import { ONBOARDING_LIMITS } from "@/lib/types/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per brand: a call is a few minutes, so this only stops a loop. The day's allowance is the real limit. */
const START_LIMIT = { prefix: "onboarding_voice_start", burstLimit: 2, hourlyLimit: 4 };

/** Nothing from the browser shapes the call. */
const Body = z.object({}).strict();

/**
 * Talk with Vizzy (ONBOARDING_VOICE_ENABLED; admins): a locked, single-use Live token and the
 * conversation its words go to. In order: the gate, the Live key, the brand's access, a rate
 * limit, calls left open closed (and counted), the 20 kept conversations, the day's allowance
 * (one finished call, three starts), then the token. A token that can't be made gives the start
 * back. The brand is the session's.
 */
export async function POST(req: Request) {
  const g = await onboardingAdmin(req, { need: "voice" });
  if (!g.ok) return g.response;
  const ctx = g.ctx;
  const body = await readJsonBody(req, 1_000);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.value);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const live = getLiveTokenClient();
  if (!live) return fail(503, "unavailable");
  if (!(await brandCanUse(ctx, "onboarding_voice"))) return fail(403, "not_included");
  if (await isRateLimited(`tenant:${ctx.tenantId}`, START_LIMIT)) return fail(429, "rate_limited");

  await closeStaleCalls(ctx);
  if ((await countConversations(ctx)) >= ONBOARDING_LIMITS.MAX_CONVERSATIONS) return fail(409, "too_many_conversations");

  const day = voiceDayOf(Date.now());
  const claim = await claimVoiceStart(ctx.tenantId, day);
  if (claim === "done_today") return fail(429, "voice_used_today");
  if (claim === "too_many") return fail(429, "voice_starts_used");
  if (claim === "missing") return fail(404, "not_found");

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const config = buildOnboardingLiveConfig({ brandName: tenant?.tenantName ?? "" });
  const minted = await mintOnboardingVoiceToken(live, config).catch((err: unknown) => {
    console.warn(`[onboarding] voice token for ${ctx.tenantId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  });
  if (!minted) {
    await releaseVoiceStart(ctx.tenantId, day).catch(() => false);
    return fail(503, "unavailable");
  }

  const started = await startConversation(ctx, { model: minted.model, source: "voice" });
  if (!started.ok) {
    await releaseVoiceStart(ctx.tenantId, day).catch(() => false);
    return refused(started);
  }
  return ok({
    conversationId: started.value.id,
    token: minted.token,
    model: minted.model,
    callSeconds: CALL_SECONDS,
    expiresAt: minted.expiresAt,
  });
}

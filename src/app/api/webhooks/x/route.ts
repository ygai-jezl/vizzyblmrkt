import { NextResponse } from "next/server";
import { getSocialSubscription } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { xCrcResponse, verifyXWebhookSignature, parseXActivity } from "@/lib/social/x/webhook";
import { recordSocialEvent } from "@/lib/social/socialEvents";
import { upsertEngagedContact } from "@/lib/social/engagedContacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject oversized bodies before parsing (public endpoint memory-DoS guard). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * X Account Activity webhook. Public (X has no session) — authenticated by an
 * HMAC-SHA256 signature over the raw body keyed by the app's CONSUMER secret
 * (X_WEBHOOK_CONSUMER_SECRET — distinct from the OAuth 2.0 client secret). Events
 * identify only the connected ACCOUNT (for_user_id); we map that to a tenant+region
 * via the social_subscriptions index (written at connect), then record each inbound
 * interaction to that tenant's `social_events`.
 *
 * ENTERPRISE-gated: dormant until X Account Activity access is provisioned and the
 * webhook is registered + a subscription created (403/not_configured until then).
 */

/** Registration/health check: echo back the HMAC of X's crc_token. */
export async function GET(req: Request) {
  const secret = process.env.X_WEBHOOK_CONSUMER_SECRET;
  const crcToken = new URL(req.url).searchParams.get("crc_token");
  if (!secret || !crcToken) {
    return NextResponse.json({ error: "bad_crc_request" }, { status: 400 });
  }
  return NextResponse.json(xCrcResponse(crcToken, secret));
}

export async function POST(req: Request) {
  const secret = process.env.X_WEBHOOK_CONSUMER_SECRET;
  if (!secret) {
    // Accept-and-drop (200) so X doesn't retry-storm, but make the gap loud.
    console.error("[x-webhook] missing X_WEBHOOK_CONSUMER_SECRET");
    return NextResponse.json({ ok: false, reason: "not_configured" });
  }

  // Reject an oversized body before reading/parsing (unauthenticated memory DoS).
  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }
  const sig = req.headers.get("x-twitter-webhooks-signature");
  if (!verifyXWebhookSignature(rawBody, sig, secret)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  const { forUserId, events, truncated } = parseXActivity(rawBody, new Date().toISOString());
  if (truncated) {
    // Never silently drop: surface that the batch hit the per-delivery cap.
    console.warn(`[x-webhook] batch for ${forUserId} capped at MAX_EVENTS_PER_BATCH`);
  }
  if (!forUserId || events.length === 0) {
    return NextResponse.json({ ok: true, recorded: 0, skipped: 0 });
  }

  // Attribute the whole batch (one for_user_id per delivery) to a tenant. A genuine
  // "not found" acks (unmapped); a TRANSIENT read error is left to throw → 500 so X
  // retries the delivery rather than losing the batch to a silent ack.
  const sub = await getSocialSubscription("x", forUserId);
  if (!sub) {
    // Unknown account (disconnected / never subscribed) — ack so X stops retrying.
    return NextResponse.json({ ok: true, recorded: 0, skipped: events.length, reason: "unmapped" });
  }

  const ctx: TenantContext = { tenantId: sub.tenantId, region: sub.region, source: "system" };
  // HIGH-INTENT engagers → the CRM Engaged tab. A bare like/follow is low-signal and
  // bot-prone, so it is recorded as a social_event but does NOT mint an engaged
  // record; only a reply/mention/quote/DM (genuine outreach) does.
  const HIGH_INTENT = new Set(["reply", "mention", "quote", "dm"]);
  const engagers = new Map<string, { handle?: string; name?: string; ts: string }>();
  let recorded = 0;
  let skipped = 0;
  for (const ev of events) {
    try {
      const outcome = await recordSocialEvent(ctx, { platform: "x", ...ev });
      if (outcome === "recorded") recorded += 1;
      else skipped += 1;
    } catch (err) {
      // One bad event must never fail the batch (that triggers a full re-send).
      console.error("[x-webhook] failed to record event", err);
      skipped += 1;
    }
    if (HIGH_INTENT.has(ev.type)) {
      engagers.set(ev.actorId, { handle: ev.actorHandle, name: ev.actorName, ts: ev.ts });
    }
  }
  for (const [userId, who] of engagers) {
    try {
      await upsertEngagedContact(ctx, {
        platform: "x",
        userId,
        handle: who.handle ?? null,
        name: who.name ?? null,
        engagedAt: who.ts,
      });
    } catch (err) {
      // Contact upsert failure must not fail the (already-recorded) event batch.
      console.error("[x-webhook] failed to upsert engaged contact", err);
    }
  }
  return NextResponse.json({ ok: true, recorded, skipped });
}

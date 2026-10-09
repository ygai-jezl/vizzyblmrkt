import { NextResponse } from "next/server";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import {
  verifyMandrillSignature,
  parseMandrillEvents,
  mapMandrillEventType,
  readEventMetadata,
  readEnrolmentSendRef,
  type EventMetadata,
} from "@/lib/email/mandrillWebhook";
import { attributionOfEnrolmentSend } from "@/lib/lifecycle/sendAttribution";
import { recordEmailEvent } from "@/lib/email/events";
import { suppressEmail } from "@/lib/email/suppression";
import { notifyProductOfSuppression } from "@/lib/connect/suppressed";
import { isSuppressionWebhookEnabled } from "@/lib/connect/v2/flags";
import type { EmailSuppressionReason } from "@/lib/types/emailSuppression";

/** Engagement events that mean "never email this address again". */
const SUPPRESSION_REASON: Partial<Record<string, EmailSuppressionReason>> = {
  unsub: "unsubscribe",
  spam: "spam",
  bounce: "hard_bounce", // mapMandrillEventType maps hard_bounce → "bounce"
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mandrill engagement webhook. Public (Mandrill has no session) — authenticated
 * by an HMAC signature over the registered URL + payload. Each event carries the
 * `metadata` we stamped at send time (tenant/journey/node/signup/variant), so we
 * attribute and store it with no lookup beyond resolving the tenant's region.
 *
 * A product journey's email sent with LIFECYCLE_SEND_TRACKING on names only its
 * enrolment (Mandrill drops metadata over 250 bytes): the rest is read from that
 * enrolment, once per batch.
 */

/** Mandrill validates the endpoint with a HEAD request on add/edit. */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}

export async function POST(req: Request) {
  const key = process.env.MANDRILL_WEBHOOK_KEY;
  const url = process.env.MANDRILL_WEBHOOK_URL;
  if (!key || !url) {
    // Misconfigured: accept-and-drop (200) so Mandrill doesn't retry-storm, but
    // make the gap loud in logs.
    console.error("[mandrill-webhook] missing MANDRILL_WEBHOOK_KEY / MANDRILL_WEBHOOK_URL");
    return NextResponse.json({ ok: false, reason: "not_configured" });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-mandrill-signature");
  if (!verifyMandrillSignature(url, rawBody, sig, key)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  const events = parseMandrillEvents(rawBody);
  // Events in a batch usually share a tenant; cache the region lookup.
  const regionCache = new Map<string, Region | null>();
  const enrolmentSends = new Map<string, EventMetadata | null>();
  let recorded = 0;
  let skipped = 0;

  for (const ev of events) {
    const type = mapMandrillEventType(ev.event);
    // A product journey's email names its enrolment; every other email carries its own attribution.
    const ref = readEnrolmentSendRef(ev);
    const direct = ref ? null : readEventMetadata(ev);
    const tenantId = ref?.tenantId ?? direct?.tenantId;
    if (!type || !tenantId) {
      skipped += 1;
      continue;
    }

    let region = regionCache.get(tenantId);
    if (region === undefined) {
      const tenant = await getTenantById(tenantId).catch(() => null);
      region = tenant?.region ?? null;
      regionCache.set(tenantId, region);
    }
    if (!region) {
      skipped += 1;
      continue;
    }

    const ctx: TenantContext = {
      tenantId,
      region,
      source: "system",
    };
    // Null: the enrolment has gone (the person was erased), so there is nobody to put the event against.
    const meta = ref
      ? await attributionOfEnrolmentSend(ctx, ref, { cache: enrolmentSends }).catch((err) => {
          console.error("[mandrill-webhook] failed to read the enrolment", err);
          return null;
        })
      : direct;
    // An email that couldn't say which step it was is still someone's: its bounce or complaint counts below.
    if (!meta?.nodeId) {
      skipped += 1;
    } else {
      try {
        const outcome = await recordEmailEvent(ctx, {
          campaignId: meta.campaignId,
          journeyId: meta.journeyId,
          nodeId: meta.nodeId,
          signupId: meta.signupId,
          variantId: meta.variantId,
          recipientKind: meta.recipientKind,
          connectionId: meta.connectionId ?? null,
          enrolmentId: meta.enrolmentId ?? null,
          type,
          ts: ev.ts
            ? new Date(ev.ts * 1000).toISOString()
            : new Date().toISOString(),
          mandrillMessageId: ev.msg?._id ?? null,
          url: ev.url ?? null,
        });
        if (outcome === "recorded") recorded += 1;
        else skipped += 1;
      } catch (err) {
        // One bad event must never fail the batch (that triggers a full re-send).
        console.error("[mandrill-webhook] failed to record event", err);
        skipped += 1;
      }
    }

    // Tenant-wide suppression: an unsubscribe / spam complaint / hard bounce means
    // stop ALL future marketing to this address (journey + broadcast). Best-effort.
    const reason = SUPPRESSION_REASON[type];
    const email = typeof ev.msg?.email === "string" ? ev.msg.email : "";
    if (reason && email) {
      try {
        await suppressEmail(ctx, {
          email,
          reason,
          source: `mandrill-${ev.event}`,
          campaignId: meta?.campaignId || null,
          signupId: meta?.signupId || null,
        });
        // A journey email to a product user: tell that product (a hard bounce or a complaint).
        if (
          meta &&
          isSuppressionWebhookEnabled() &&
          (reason === "hard_bounce" || reason === "spam") &&
          meta.recipientKind === "product_user" &&
          meta.connectionId &&
          meta.signupId
        ) {
          await notifyProductOfSuppression(ctx, { connectionId: meta.connectionId, productUserId: meta.signupId, reason });
        }
      } catch (err) {
        console.error("[mandrill-webhook] failed to suppress", err);
      }
    }
  }

  return NextResponse.json({ ok: true, recorded, skipped });
}

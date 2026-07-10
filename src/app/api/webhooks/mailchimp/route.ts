import { NextResponse } from "next/server";
import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { suppressEmail } from "@/lib/email/suppression";
import type { EmailSuppressionReason } from "@/lib/types/emailSuppression";
import {
  deriveTenantWebhookKey,
  tenantWebhookKeyMatches,
} from "@/lib/email/mailchimpWebhookAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MailChimp audience webhook. Broadcasts use MailChimp's native *|UNSUB|* /
 * *|UPDATE_PROFILE|* links, so an unsubscribe there archives the address from the
 * audience (stopping broadcasts) but wouldn't otherwise reach our suppression
 * store (stopping journeys). This webhook mirrors MailChimp unsubscribe / cleaned
 * (hard-bounce) / abuse events into `email_suppressions` so opt-out stays
 * TENANT-WIDE across both providers.
 *
 * MailChimp has no HMAC signing, so the webhook URL carries the tenant(s) (`?t=`)
 * and a key (`?key=`) = HMAC(MAILCHIMP_WEBHOOK_KEY, <the exact ?t= string>) — see
 * mailchimpWebhookAuth.ts. The key is bound to that tenant string, so a tenant
 * admin who can read their OWN webhook URL (BYO MailChimp accounts host their own
 * webhook) still cannot forge a key for a different `?t=` — closing the
 * cross-tenant suppression hole a single global key would open.
 *
 * `?t=` may be a COMMA-SEPARATED list of tenant ids: prod uses ONE shared MailChimp
 * audience across brands, so an audience-level unsubscribe/clean is mirrored into
 * EVERY brand that shares it (consistent with MailChimp removing them from the
 * whole shared audience). BYO/single-audience setups just pass one id.
 */

/** MailChimp verifies the endpoint with a GET before accepting the webhook. */
export function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const master = process.env.MAILCHIMP_WEBHOOK_KEY;
  const tParam = (url.searchParams.get("t") ?? "").trim();
  if (!master) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!tParam) return NextResponse.json({ ok: false, reason: "no_tenant" });
  // The key is derived over the EXACT ?t= string (the whole comma list), so a
  // tenant can't extend their own key to cover a different set of tenants.
  if (!tenantWebhookKeyMatches(url.searchParams.get("key") ?? "", deriveTenantWebhookKey(tParam, master))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // MailChimp POSTs form-encoded fields like `type`, `data[email]`, `data[reason]`.
  const form = new URLSearchParams(await req.text());
  const type = form.get("type") ?? "";
  const email = form.get("data[email]") ?? "";
  const dataReason = (form.get("data[reason]") ?? "").toLowerCase();

  let reason: EmailSuppressionReason | null = null;
  if (type === "unsubscribe") reason = dataReason === "abuse" ? "spam" : "unsubscribe";
  else if (type === "cleaned") reason = "hard_bounce";
  if (!reason || !email) return NextResponse.json({ ok: true, skipped: true });

  // Mirror into every brand sharing this audience (idempotent per tenant).
  const tenantIds = tParam.split(",").map((s) => s.trim()).filter(Boolean);
  for (const tenantId of tenantIds) {
    const tenant = await getTenantById(tenantId).catch(() => null);
    if (!tenant) continue;
    const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };
    try {
      await suppressEmail(ctx, { email, reason, source: `mailchimp-${type}` });
    } catch (err) {
      console.error("[mailchimp-webhook] failed to suppress", err);
    }
  }
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getTenantById, getTenantsByMailchimpAudience } from "@/lib/tenant";
import type { Tenant } from "@/lib/types/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { suppressEmail } from "@/lib/email/suppression";
import type { EmailSuppressionReason } from "@/lib/types/emailSuppression";
import {
  deriveMailchimpWebhookKey,
  mailchimpWebhookKeyMatches,
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
 * The webhook URL carries NO tenant ids — only a secret `?key=` bound to the
 * AUDIENCE it fires for (`key = HMAC(MAILCHIMP_WEBHOOK_KEY, data[list_id])`; see
 * mailchimpWebhookAuth.ts). The owning tenant is resolved from the event's
 * `list_id`, so onboarding a tenant with its own audience needs no URL change and
 * it scales to any number of tenants:
 *   1. tenants whose `mailchimpConfig.audienceId` == list_id (BYO/dedicated); else
 *   2. if list_id is the shared platform audience (MAILCHIMP_AUDIENCE_ID), the
 *      brands sharing it, declared in MAILCHIMP_SHARED_AUDIENCE_TENANTS.
 */

/** MailChimp verifies the endpoint with a GET before accepting the webhook. */
export function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const master = process.env.MAILCHIMP_WEBHOOK_KEY;
  if (!master) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  // MailChimp POSTs form-encoded fields like `type`, `data[email]`, `data[list_id]`.
  const form = new URLSearchParams(await req.text());
  const type = form.get("type") ?? "";
  const email = form.get("data[email]") ?? "";
  const listId = (form.get("data[list_id]") ?? "").trim();
  const dataReason = (form.get("data[reason]") ?? "").toLowerCase();

  // The key is bound to THIS audience id — a key for one audience can never
  // authorise a write for another list_id (and the URL leaks no tenant ids).
  if (
    !listId ||
    !mailchimpWebhookKeyMatches(
      url.searchParams.get("key") ?? "",
      deriveMailchimpWebhookKey(listId, master),
    )
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let reason: EmailSuppressionReason | null = null;
  if (type === "unsubscribe") reason = dataReason === "abuse" ? "spam" : "unsubscribe";
  else if (type === "cleaned") reason = "hard_bounce";
  if (!reason || !email) return NextResponse.json({ ok: true, skipped: true });

  // Resolve the owning tenant(s) from the audience — never from the URL.
  const tenants = await resolveTenantsForAudience(listId);

  // Mirror into every resolved brand (idempotent per tenant).
  for (const tenant of tenants) {
    const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };
    try {
      await suppressEmail(ctx, { email, reason, source: `mailchimp-${type}` });
    } catch (err) {
      console.error("[mailchimp-webhook] failed to suppress", err);
    }
  }
  return NextResponse.json({ ok: true, tenants: tenants.length });
}

/** Tenants that own / share the given MailChimp audience (see the header comment). */
async function resolveTenantsForAudience(listId: string): Promise<Tenant[]> {
  // 1. Dedicated / BYO audiences: the tenant carries mailchimpConfig.audienceId.
  const owners = await getTenantsByMailchimpAudience(listId).catch(() => []);
  if (owners.length) return owners;

  // 2. The shared platform audience: its brands aren't on tenant docs, so they're
  //    declared in env (rarely changes; not per-tenant, so it never grows a URL).
  if (listId === process.env.MAILCHIMP_AUDIENCE_ID?.trim()) {
    const ids = (process.env.MAILCHIMP_SHARED_AUDIENCE_TENANTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const resolved = await Promise.all(ids.map((id) => getTenantById(id).catch(() => null)));
    return resolved.filter((t): t is Tenant => t != null);
  }

  return [];
}

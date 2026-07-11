import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Auth for the MailChimp audience webhook. MailChimp Marketing webhooks aren't
 * reliably request-signed, so the webhook URL carries a secret `?key=` bound to
 * the AUDIENCE (list) id it fires for: `key = HMAC(MAILCHIMP_WEBHOOK_KEY, listId)`.
 * The route reads `data[list_id]` from the (form-encoded) body and recomputes the
 * expected key, so:
 *   - the URL contains NO tenant ids — the tenant is resolved from the audience
 *     (getTenantsByMailchimpAudience) — so onboarding a tenant needs no URL change
 *     and it scales to any number of tenants; and
 *   - the key is unforgeable across audiences: knowing your own audience's key
 *     never authorises a write for a different `list_id`.
 * Onboarding computes the key with this same function over the tenant's audience id.
 */
export function deriveMailchimpWebhookKey(audienceId: string, master: string): string {
  return createHmac("sha256", master).update(audienceId).digest("base64url");
}

/** Constant-time compare of a provided key against the expected per-audience key. */
export function mailchimpWebhookKeyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

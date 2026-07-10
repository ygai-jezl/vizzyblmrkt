import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Per-tenant auth for the MailChimp audience webhook. MailChimp has no request
 * signing, so the webhook URL carries `?t=<tenantId>&key=<derived>` where the key
 * is HMAC(MAILCHIMP_WEBHOOK_KEY, tenantId). Because the key is bound to the
 * tenant, a (BYO-account) tenant admin who can read their OWN webhook URL still
 * can't forge a key for any other `?t=` — closing the cross-tenant suppression
 * hole a single global key would open. Provision each per-audience webhook with
 * the derived key.
 */
export function deriveTenantWebhookKey(tenantId: string, master: string): string {
  return createHmac("sha256", master).update(tenantId).digest("base64url");
}

/** Constant-time compare of a provided key against the expected per-tenant key. */
export function tenantWebhookKeyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

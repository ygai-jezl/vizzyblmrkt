import type { Tenant } from "@/lib/types/tenant";
import type { MailchimpConfigResult } from "./types";

/**
 * Resolve the MailChimp Marketing credentials for a tenant, honoring the
 * per-tenant feature gate (see Tenant.mailchimpConfig):
 *
 *  - `requiresOwnApiKey === true` → the tenant is gated OFF the shared account;
 *    it MUST provide its own apiKey (+ audienceId). The shared account is never
 *    used as a fallback.
 *  - a tenant that simply set its own apiKey (gate off) still uses it.
 *  - otherwise → the SHARED account from env (MAILCHIMP_API_KEY, …).
 *
 * The data-center prefix (e.g. "us21") is the suffix of the API key (keys look
 * like "<hex>-us21"); we derive it unless explicitly configured.
 *
 * Returns a discriminated result rather than throwing, so callers (best-effort
 * sync hooks, the delivery worker) can log + continue.
 */
export function resolveMailchimpConfig(
  tenant: Tenant | null,
): MailchimpConfigResult {
  const cfg = tenant?.mailchimpConfig;
  const ownKey = cfg?.apiKey?.trim();

  // Gate on, but nothing to fall back to.
  if (cfg?.requiresOwnApiKey && !ownKey) {
    return { ok: false, reason: "byo_required_not_configured" };
  }

  // Bring-your-own (either forced by the gate, or voluntarily configured).
  if (ownKey) {
    const serverPrefix = cfg?.serverPrefix?.trim() || deriveServerPrefix(ownKey);
    const audienceId = cfg?.audienceId?.trim();
    if (!serverPrefix) return { ok: false, reason: "no_server_prefix" };
    if (!audienceId) return { ok: false, reason: "byo_required_not_configured" };
    return {
      ok: true,
      config: { apiKey: ownKey, serverPrefix, audienceId, source: "tenant" },
    };
  }

  // Shared account (env-configured).
  const apiKey = process.env.MAILCHIMP_API_KEY?.trim();
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID?.trim();
  if (!apiKey || !audienceId) {
    return { ok: false, reason: "shared_not_configured" };
  }
  const serverPrefix =
    process.env.MAILCHIMP_SERVER_PREFIX?.trim() || deriveServerPrefix(apiKey);
  if (!serverPrefix) return { ok: false, reason: "no_server_prefix" };
  return {
    ok: true,
    config: { apiKey, serverPrefix, audienceId, source: "shared" },
  };
}

/** MailChimp keys end in "-<dc>", e.g. "abc123…-us21" → "us21". */
export function deriveServerPrefix(apiKey: string): string | null {
  const idx = apiKey.lastIndexOf("-");
  if (idx < 0 || idx === apiKey.length - 1) return null;
  return apiKey.slice(idx + 1);
}

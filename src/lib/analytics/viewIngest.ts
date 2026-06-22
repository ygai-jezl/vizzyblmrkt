import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WidgetViewRow } from "./bigquery";

/**
 * Server-side normalization + abuse controls for the public widget-view beacon
 * (POST /api/track/view). The endpoint is unauthenticated and cross-origin (the
 * widget is framed on customer sites), so this module is the OWASP boundary:
 *
 *  - INPUT (API3): strict, length-bounded Zod schema; values are only ever stored
 *    as plain typed columns and bound as query params elsewhere — never
 *    interpolated into SQL.
 *  - PII / minimization: the stored row carries NO email/IP/cookie/raw-UA/full
 *    URL — the referrer is reduced to its host, and the User-Agent to a coarse
 *    class. event_id/event_ts are SERVER-minted (no client-controlled dedupe key
 *    → no replay-driven inflation).
 *  - RESOURCE CONSUMPTION (API4): a cheap UA bot filter, a per-IP+campaign rate
 *    limiter, and a bounded campaign-existence cache cap the work a flood can
 *    cause. All state is in-process (per instance) — documented; the real spend
 *    backstop is maxInstances + the budget kill-switch (docs/SETUP.md §6).
 */

const Str = (n: number) => z.string().trim().max(n).optional();

/** The beacon request body. `.strict()` rejects any unknown field. */
export const ViewBeaconSchema = z
  .object({
    campaignId: z.string().trim().min(1).max(200),
    /** Tenant ROUTING hint (re-resolved server-side); never trusted as identity. */
    t: Str(200),
    /** Raw referrer URL (reduced to host server-side; never stored raw). */
    ref: Str(2048),
    utm: z
      .object({
        source: Str(200),
        medium: Str(200),
        campaign: Str(200),
        content: Str(200),
        term: Str(200),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ViewBeaconInput = z.infer<typeof ViewBeaconSchema>;

// --- bot classification -----------------------------------------------------

// Obvious non-browser agents — crawlers, link-preview unfurlers, HTTP libraries.
const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|whatsapp|telegrambot|discordbot|skypeuripreview|headless|phantomjs|python-requests|curl\/|wget|go-http-client|java\/|okhttp|axios|node-fetch|libwww|monitoring|pingdom|uptime/i;

// A recognisable real-browser token. Required to count a view as a human.
const BROWSER_RE = /mozilla\/|applewebkit|gecko|chrome|safari|firefox|edg\/|opr\//i;

export type UaClass = "browser" | "bot" | "unknown";

/**
 * Classify a User-Agent into a coarse bucket. A missing UA is treated as a bot
 * (a real browser always sends one) so a header-less script can't inflate views.
 * "unknown" (a UA with no recognisable browser token) is retained but flagged as
 * a bot so the dashboard excludes it — without dropping it for later analysis.
 */
export function classifyUa(ua: string | null | undefined): UaClass {
  if (!ua) return "bot";
  if (BOT_RE.test(ua)) return "bot";
  if (BROWSER_RE.test(ua)) return "browser";
  return "unknown";
}

// --- normalization (PII-free row) -------------------------------------------

/** Host of a referrer URL, lowercased; null for empty/invalid/over-long hosts. */
export function referrerHost(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.toLowerCase();
    // A real hostname is short and made of label chars; reject anything else.
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** Trim, strip control chars, null out empties. Length already bounded by Zod. */
function cleanUtm(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned || null;
}

/**
 * Build the normalized, PII-free widget_views row. tenantId + campaignId are the
 * SERVER-derived/validated values (never the request body's `t`). event_id and
 * event_ts use the server clock so a client can't supply a stable dedupe key.
 */
export function buildWidgetViewRow(
  input: ViewBeaconInput,
  headers: Headers,
  tenantId: string,
  campaignId: string,
): WidgetViewRow {
  const uaClass = classifyUa(headers.get("user-agent"));
  const now = new Date();
  return {
    event_id: randomUUID(),
    tenant_id: tenantId,
    campaign_id: campaignId,
    event_ts: now.toISOString(),
    referrer_host: referrerHost(input.ref),
    utm_source: cleanUtm(input.utm?.source),
    utm_medium: cleanUtm(input.utm?.medium),
    utm_campaign: cleanUtm(input.utm?.campaign),
    utm_content: cleanUtm(input.utm?.content),
    utm_term: cleanUtm(input.utm?.term),
    ua_class: uaClass,
    // The route already dropped clear "bot"s, so this is "browser" or "unknown";
    // a non-browser token is still flagged so the dashboard can exclude it.
    is_bot: uaClass !== "browser",
    ingest_day: now.toISOString().slice(0, 10),
  };
}

/** Loose IPv4/IPv6 literal check — rejects spoofed non-IP junk used as a key. */
export function isIpLiteral(s: string): boolean {
  if (!s) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split(".").every((o) => Number(o) <= 255);
  }
  return s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s); // loose IPv6
}

/**
 * Best-effort client IP for rate-limit keying. Returns the first VALID IP literal
 * in x-forwarded-for (else x-real-ip), folding spoofed non-IP junk to a single
 * "unknown" bucket so an attacker can't mint a fresh bucket per garbage value.
 * XFF is client-influenced, so this is best-effort only — the IP-INDEPENDENT
 * per-tenant caps in the route are the real resource backstop (see route.ts).
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    for (const hop of xff.split(",")) {
      const ip = hop.trim();
      if (isIpLiteral(ip)) return ip;
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  return real && isIpLiteral(real) ? real : "unknown";
}

// --- in-process abuse state (per instance; documented single-instance caveat) -

/** Hard cap on entries for any in-process map → bounds memory under a flood. */
const MAX_ENTRIES = 10_000;

function evictIfFull(map: Map<string, unknown>): void {
  if (map.size < MAX_ENTRIES) return;
  // Maps iterate in insertion order — drop the oldest entries.
  const drop = Math.ceil(MAX_ENTRIES * 0.1);
  let i = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++i >= drop) break;
  }
}

interface RateWindow {
  count: number;
  resetAt: number;
}
const RATE_WINDOW_MS = 60_000;
const buckets = new Map<string, RateWindow>();

/**
 * Per-minute ceilings for the view beacon (all per-instance, best-effort):
 *  - perCampaign: (IP, tenant, campaign) — caps view-count inflation on one campaign.
 *  - perTenantBeacon: (IP, tenant) — coarse flood cap across a tenant's campaigns.
 *  - perTenantMiss: (tenant) — IP-INDEPENDENT cap on campaign-existence cache MISSES,
 *    so forged-campaign-id enumeration can't amplify Firestore reads regardless of
 *    how the attacker rotates IPs. This is the real read-cost backstop.
 */
export const VIEW_LIMITS = {
  perCampaign: 30,
  perTenantBeacon: 600,
  perTenantMiss: 120,
} as const;

/**
 * Fixed-window per-key rate limit against a caller-supplied ceiling. Returns true
 * when the caller is OVER the limit (and should be dropped). `now` is injected
 * for testability. Distinct key prefixes share the bounded map without colliding.
 */
export function fixedWindowExceeded(key: string, now: number, limit: number): boolean {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    evictIfFull(buckets);
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

/** Back-compat helper: per-(IP,tenant,campaign) view limit at the default ceiling. */
export function rateLimitExceeded(key: string, now: number): boolean {
  return fixedWindowExceeded(key, now, VIEW_LIMITS.perCampaign);
}

interface CachedBool {
  value: boolean;
  expiresAt: number;
}
const CAMPAIGN_TTL_MS = 5 * 60_000;
const campaignCache = new Map<string, CachedBool>();

/** Recall a cached campaign-existence answer, or undefined when not cached/expired. */
export function recallCampaignExists(key: string, now: number): boolean | undefined {
  const hit = campaignCache.get(key);
  if (!hit || now >= hit.expiresAt) return undefined;
  return hit.value;
}

/** Cache a campaign-existence answer (positive AND negative) with a short TTL. */
export function rememberCampaignExists(key: string, value: boolean, now: number): void {
  evictIfFull(campaignCache);
  campaignCache.set(key, { value, expiresAt: now + CAMPAIGN_TTL_MS });
}

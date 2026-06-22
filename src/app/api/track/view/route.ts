import { resolveTenantForRequest, forTenant } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { tenantParamFromUrl } from "@/lib/http/tenantParam";
import { analyticsBqEnabled, recordWidgetView } from "@/lib/analytics/bigquery";
import {
  ViewBeaconSchema,
  VIEW_LIMITS,
  classifyUa,
  clientIp,
  fixedWindowExceeded,
  recallCampaignExists,
  rememberCampaignExists,
  buildWidgetViewRow,
} from "@/lib/analytics/viewIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated widget-view beacon. The embed client fires this once
 * per render (navigator.sendBeacon) to record a widget impression. It is the one
 * public write path with no reCAPTCHA, so it is deliberately defensive:
 *
 *  - always 204 (body-less) — never leak tenant/campaign existence, never 400 a
 *    fire-and-forget beacon, never read/set cookies (stays CDN-friendly);
 *  - drop clear bots BEFORE any tenant/DB/BQ work;
 *  - tenant is SERVER-derived (origin / re-resolved ?t=), campaign re-validated
 *    under that tenant — the body can never assert identity (OWASP API1/BOLA);
 *  - per-IP+campaign rate limit + cached campaign check cap resource use (API4);
 *  - the stored row is PII-free and the write is awaited but best-effort (a
 *    dropped view is acceptable; an inflated or blocking beacon is not).
 *
 * See lib/analytics/viewIngest.ts for the OWASP boundary details.
 */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

export async function POST(req: Request): Promise<Response> {
  // Pipeline off → inert. (The client beacon is also tree-shaken off when the
  // public flag is unset, so this is just defense in depth.)
  if (!analyticsBqEnabled()) return noContent();

  // Drop obvious bots before doing ANY work (tenant lookup, parse, DB, BQ).
  if (classifyUa(req.headers.get("user-agent")) === "bot") return noContent();

  // Reject an oversized body before parsing it (a beacon body is tiny).
  if (Number(req.headers.get("content-length") ?? 0) > 4096) return noContent();

  const parsed = ViewBeaconSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noContent(); // never 400 a beacon

  // Tenant is resolved server-side: ?t= / body `t` are routing hints only,
  // re-resolved against the registry; origin is the custom-domain fallback.
  const origin = originFromHeaders(req.headers);
  const tenantHint = tenantParamFromUrl(req.url) ?? parsed.data.t;
  const ctx = await resolveTenantForRequest({ tenantId: tenantHint, origin }).catch(
    () => null,
  );
  if (!ctx) return noContent(); // unknown/suspended tenant → drop, no oracle

  const now = Date.now();
  const ip = clientIp(req.headers);
  const campaignId = parsed.data.campaignId;

  // Layered rate limits (all silently drop over-limit):
  //  - coarse per (IP, tenant): caps a single source's beacon flood;
  //  - fine per (IP, tenant, campaign): caps view-count inflation on one campaign.
  if (fixedWindowExceeded(`beacon:${ip}:${ctx.tenantId}`, now, VIEW_LIMITS.perTenantBeacon)) {
    return noContent();
  }
  if (
    fixedWindowExceeded(`view:${ip}:${ctx.tenantId}:${campaignId}`, now, VIEW_LIMITS.perCampaign)
  ) {
    return noContent();
  }

  // Campaign must belong to the resolved tenant (BOLA guard). Cached (positive
  // AND negative) so repeats are free. On a cache MISS we additionally consume an
  // IP-INDEPENDENT per-tenant miss budget BEFORE the Firestore read, so forged
  // campaign-id enumeration can't amplify reads even if the attacker rotates IPs.
  const cacheKey = `${ctx.tenantId}:${campaignId}`;
  let exists = recallCampaignExists(cacheKey, now);
  if (exists === undefined) {
    if (fixedWindowExceeded(`miss:${ctx.tenantId}`, now, VIEW_LIMITS.perTenantMiss)) {
      return noContent();
    }
    const campaign = await forTenant(ctx).campaigns.getById(campaignId).catch(() => null);
    exists = campaign !== null;
    rememberCampaignExists(cacheKey, exists, now);
  }
  if (!exists) return noContent();

  // Build the PII-free row and write it. Awaited (the browser never reads this
  // response, so there is no latency cost) but best-effort — recordWidgetView
  // swallows its own errors and returns false rather than throwing.
  const row = buildWidgetViewRow(parsed.data, req.headers, ctx.tenantId, campaignId);
  await recordWidgetView(ctx, row);
  return noContent();
}

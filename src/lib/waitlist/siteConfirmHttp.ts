import { NextResponse } from "next/server";
import { forTenant, resolveTenantForRequest, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { originFromHeaders } from "@/lib/http/origin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { appendTenantParam, tenantParamFromUrl } from "@/lib/http/tenantParam";
import { isSiteSignupsEnabled } from "./siteFlags";
import { confirmSiteSignup } from "./siteSignup";

/**
 * The Confirm subscription button (POST /api/waitlist/{id}/confirm), for site
 * sign-ups (LAUNCH_SITE_SIGNUPS_ENABLED). The token comes in the form body, never
 * the URL, and the request must come from the confirm page itself. Then on to the
 * brand's thank-you page, or the confirm page's own result.
 */

/** The confirm page for a result (relative, so it never reflects the Host header). */
export function confirmPagePath(campaignId: string, params: Record<string, string>, tenantId?: string): string {
  const q = new URLSearchParams(params).toString();
  return appendTenantParam(`/waitlist/${encodeURIComponent(campaignId)}/confirm${q ? `?${q}` : ""}`, tenantId);
}

/** Only an https address is ever a redirect target. */
export function safeThankYouUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, "cache-control": "no-store" } });
}

export async function handleSiteConfirmPost(
  req: Request,
  campaignId: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<Response> {
  if (!isSiteSignupsEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const tenantId = tenantParamFromUrl(req.url);
  const ctx: TenantContext | null = await resolveTenantForRequest({ tenantId, origin: originFromHeaders(req.headers) }, deps.db).catch(() => null);
  if (!ctx) return seeOther(confirmPagePath(campaignId, { state: "invalid" }, tenantId));

  const form = await req.formData().catch(() => null);
  const token = typeof form?.get("token") === "string" ? (form!.get("token") as string).slice(0, 200) : "";
  const result = await confirmSiteSignup(ctx, campaignId, token, deps);
  if (result.outcome !== "confirmed" && result.outcome !== "already") {
    return seeOther(confirmPagePath(campaignId, { state: result.outcome }, tenantId));
  }
  const key = await forTenant(ctx, deps.db).siteKeys.getById(campaignId).catch(() => null);
  const thanks = safeThankYouUrl(key?.siteConfirmedUrl);
  if (thanks) return seeOther(thanks);
  const lng = result.locale;
  return seeOther(confirmPagePath(campaignId, { state: "done", ...(lng ? { lng } : {}) }, tenantId));
}

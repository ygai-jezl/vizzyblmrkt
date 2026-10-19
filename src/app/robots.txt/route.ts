import { originFromHeaders } from "@/lib/http/origin";
import { isCanonicalHost, isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { robotsTxt } from "@/lib/site/robots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * robots.txt: everyone welcome on the canonical host (NEXT_PUBLIC_SITE_ORIGIN or the platform origin);
 * every other host kept out of search, and every host when neither is set. 404 while SITE_SEO_ENABLED is off.
 */
export function GET(req: Request) {
  if (!isSiteSeoEnabled()) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return new Response(robotsTxt(siteOrigin() || originFromHeaders(req.headers), { indexable: isCanonicalHost(host) }), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

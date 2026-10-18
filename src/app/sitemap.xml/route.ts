import { isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { sitemapEntries, sitemapXml } from "@/lib/site/sitemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** sitemap.xml: every public page switched on here, with its language versions. 404 while SITE_SEO_ENABLED is off. */
export function GET() {
  if (!isSiteSeoEnabled()) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(sitemapXml(sitemapEntries(siteOrigin())), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

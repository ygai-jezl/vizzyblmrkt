import { isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { baseGraph, serializeJsonLd } from "@/lib/site/jsonLd";

/**
 * Who we are (Organization, WebSite, SoftwareApplication) as JSON-LD, for pages outside the loop site.
 * Off unless SITE_SEO_ENABLED, and only with a canonical origin (schema.org wants absolute URLs).
 */
export function BaseJsonLd() {
  const origin = siteOrigin();
  if (!isSiteSeoEnabled() || !origin) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(baseGraph(origin)) }} />;
}

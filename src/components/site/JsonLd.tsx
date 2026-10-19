import { isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { baseGraph, serializeJsonLd } from "@/lib/site/jsonLd";

/** Who we are (Organization, WebSite, SoftwareApplication) as JSON-LD, for pages outside the loop site. Off unless SITE_SEO_ENABLED. */
export function BaseJsonLd() {
  if (!isSiteSeoEnabled()) return null;
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(baseGraph(siteOrigin())) }} />;
}

import { agentFile, llmsTxt, PLAIN } from "@/lib/developers/agentDocs";
import { isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { siteLlmsTxt } from "@/lib/site/llms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The llms.txt index (https://llmstxt.org). With SITE_SEO_ENABLED it describes the
 * whole site and keeps the developer index inside it; otherwise it is the developer
 * index alone, where a coding agent starts.
 */
export function GET() {
  if (isSiteSeoEnabled()) {
    return new Response(siteLlmsTxt(siteOrigin()), {
      headers: { "content-type": PLAIN, "cache-control": "public, max-age=300", "x-robots-tag": "noindex" },
    });
  }
  return agentFile(() => llmsTxt(), PLAIN);
}

import { agentFile, llmsTxt, PLAIN } from "@/lib/developers/agentDocs";
import { originFromHeaders } from "@/lib/http/origin";
import { isSiteSeoEnabled, siteOrigin } from "@/lib/site/flags";
import { siteLlmsTxt } from "@/lib/site/llms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The llms.txt index (https://llmstxt.org). With SITE_SEO_ENABLED it describes the
 * whole site and keeps the developer index inside it; otherwise it is the developer
 * index alone, where a coding agent starts.
 */
export function GET(req: Request) {
  if (isSiteSeoEnabled()) {
    return new Response(siteLlmsTxt(siteOrigin() || originFromHeaders(req.headers)), {
      headers: { "content-type": PLAIN, "cache-control": "public, max-age=300", "x-robots-tag": "noindex" },
    });
  }
  return agentFile(() => llmsTxt(), PLAIN);
}

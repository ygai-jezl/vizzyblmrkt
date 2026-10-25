import { agentFile, MARKDOWN, pageMarkdown } from "@/lib/developers/agentDocs";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /developers/site-signups as Markdown, for coding agents (only while LAUNCH_SITE_SIGNUPS_ENABLED is on). */
export function GET() {
  return agentFile(() => (isSiteSignupsEnabled() ? pageMarkdown("site-signups") : null), MARKDOWN);
}

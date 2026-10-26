import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/newsletter-from-your-site as Markdown, for AI assistants (only while LAUNCH_SITE_SIGNUPS_ENABLED is on). */
export function GET() {
  return helpFile(() => (isSiteSignupsEnabled() ? helpPageMarkdown("newsletter-from-your-site") : null), MARKDOWN);
}

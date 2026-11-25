import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isOrganisationJoinEnabled } from "@/lib/plans/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/organisation-brands as Markdown, for AI assistants (only while ORGANISATION_JOIN_ENABLED is on). */
export function GET() {
  return helpFile(() => (isOrganisationJoinEnabled() ? helpPageMarkdown("organisation-brands") : null), MARKDOWN);
}

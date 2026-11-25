import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/shared-connections as Markdown, for AI assistants (only while CONNECTORS_SHARING_ENABLED is on). */
export function GET() {
  return helpFile(() => (isConnectorsSharingEnabled() ? helpPageMarkdown("shared-connections") : null), MARKDOWN);
}

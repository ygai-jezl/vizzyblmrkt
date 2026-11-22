import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/connected-data as Markdown, for AI assistants (only while NEXT_PUBLIC_CONNECTORS_ENABLED is on). */
export function GET() {
  return helpFile(() => (isConnectorsScreenEnabled() ? helpPageMarkdown("connected-data") : null), MARKDOWN);
}

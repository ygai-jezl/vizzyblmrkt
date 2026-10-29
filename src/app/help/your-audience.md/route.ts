import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isOneViewEnabled } from "@/lib/audience/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/your-audience as Markdown, for AI assistants (only while AUDIENCE_ONE_VIEW_ENABLED is on). */
export function GET() {
  return helpFile(() => (isOneViewEnabled() ? helpPageMarkdown("your-audience") : null), MARKDOWN);
}

import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isPasteEnabled } from "@/lib/crm/paste/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/paste-a-list as Markdown, for AI assistants (only while RAISE_PASTE_ENABLED is on). */
export function GET() {
  return helpFile(() => (isPasteEnabled() ? helpPageMarkdown("paste-a-list") : null), MARKDOWN);
}

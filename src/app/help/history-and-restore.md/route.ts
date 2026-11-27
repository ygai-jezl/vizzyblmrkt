import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isSettingsHistoryEnabled } from "@/lib/settings/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/history-and-restore as Markdown, for AI assistants (only while SETTINGS_HISTORY_ENABLED is on). */
export function GET() {
  return helpFile(() => (isSettingsHistoryEnabled() ? helpPageMarkdown("history-and-restore") : null), MARKDOWN);
}

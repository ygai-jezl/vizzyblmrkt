import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isWorkEnabled } from "@/lib/work/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/work as Markdown, for AI assistants (only while WORK_ENABLED is on). */
export function GET() {
  return helpFile(() => (isWorkEnabled() ? helpPageMarkdown("work") : null), MARKDOWN);
}

import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isPlansUiEnabled } from "@/lib/plans/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/plan-and-usage as Markdown, for AI assistants (only while NEXT_PUBLIC_PLANS_ENABLED is on). */
export function GET() {
  return helpFile(() => (isPlansUiEnabled() ? helpPageMarkdown("plan-and-usage") : null), MARKDOWN);
}

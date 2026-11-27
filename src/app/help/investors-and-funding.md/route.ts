import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isRaisePipelineEnabled } from "@/lib/raise/pipeline/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/investors-and-funding as Markdown, for AI assistants (only while RAISE_PIPELINE_ENABLED is on). */
export function GET() {
  return helpFile(() => (isRaisePipelineEnabled() ? helpPageMarkdown("investors-and-funding") : null), MARKDOWN);
}

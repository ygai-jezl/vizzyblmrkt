import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/what-yougrow-learned as Markdown, for AI assistants (only while IMAGE_STYLE_VERSIONS_ENABLED is on). */
export function GET() {
  return helpFile(() => (isImageStyleVersionsOn() ? helpPageMarkdown("what-yougrow-learned") : null), MARKDOWN);
}

import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { helpPage, isHelpPageShown } from "@/lib/help/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/what-yougrow-learned as Markdown, for AI assistants: served while the page is listed (image style versions or LOOPS_ENABLED on). */
export function GET() {
  return helpFile(() => {
    const page = helpPage("what-yougrow-learned");
    return page && isHelpPageShown(page) ? helpPageMarkdown("what-yougrow-learned") : null;
  }, MARKDOWN);
}

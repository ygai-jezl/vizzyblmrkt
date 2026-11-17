import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isSearchUiEnabled } from "@/lib/search/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/search as Markdown, for AI assistants (only while NEXT_PUBLIC_SEARCH_ENABLED is on). */
export function GET() {
  return helpFile(() => (isSearchUiEnabled() ? helpPageMarkdown("search") : null), MARKDOWN);
}

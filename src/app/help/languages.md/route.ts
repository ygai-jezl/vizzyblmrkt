import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isContentLanguageEnabled } from "@/lib/i18n/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/languages as Markdown, for AI assistants (only while CONTENT_LANGUAGE_ENABLED is on). */
export function GET() {
  return helpFile(() => (isContentLanguageEnabled() ? helpPageMarkdown("languages") : null), MARKDOWN);
}

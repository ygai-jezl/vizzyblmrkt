import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/people as Markdown, for AI assistants. */
export function GET() {
  return helpFile(() => helpPageMarkdown("people"), MARKDOWN);
}

import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help as Markdown, for AI assistants. */
export function GET() {
  return helpFile(() => helpPageMarkdown(""), MARKDOWN);
}

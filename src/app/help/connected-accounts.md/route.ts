import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/connected-accounts as Markdown, for AI assistants. */
export function GET() {
  return helpFile(() => helpPageMarkdown("connected-accounts"), MARKDOWN);
}

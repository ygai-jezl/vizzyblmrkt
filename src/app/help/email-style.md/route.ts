import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/email-style as Markdown, for AI assistants. */
export function GET() {
  return helpFile(() => helpPageMarkdown("email-style"), MARKDOWN);
}

import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/invite-your-waitlist as Markdown, for AI assistants. */
export function GET() {
  return helpFile(() => helpPageMarkdown("invite-your-waitlist"), MARKDOWN);
}

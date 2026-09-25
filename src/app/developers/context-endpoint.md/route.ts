import { agentFile, MARKDOWN, pageMarkdown } from "@/lib/developers/agentDocs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /developers/context-endpoint as Markdown, for coding agents. */
export function GET() {
  return agentFile(() => pageMarkdown("context-endpoint"), MARKDOWN);
}

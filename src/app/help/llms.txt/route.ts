import { helpFile, helpLlmsTxt, PLAIN } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The help pages' llms.txt index (https://llmstxt.org), for AI assistants. */
export function GET() {
  return helpFile(() => helpLlmsTxt(), PLAIN);
}

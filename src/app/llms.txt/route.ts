import { agentFile, llmsTxt, PLAIN } from "@/lib/developers/agentDocs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The llms.txt index (https://llmstxt.org): where a coding agent starts. */
export function GET() {
  return agentFile(() => llmsTxt(), PLAIN);
}

import { agentFile, llmsFullTxt, PLAIN } from "@/lib/developers/agentDocs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every docs page as Markdown in one file — the one URL a coding agent needs. */
export function GET() {
  return agentFile(() => llmsFullTxt(), PLAIN);
}

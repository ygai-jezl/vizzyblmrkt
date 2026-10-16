import { helpFile, helpLlmsFullTxt, PLAIN } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every help page as Markdown in one file. */
export function GET() {
  return helpFile(() => helpLlmsFullTxt(), PLAIN);
}

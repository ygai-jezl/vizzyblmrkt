import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";
import { isRaiseKitEnabled } from "@/lib/raise/docs/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/raise-kit as Markdown, for AI assistants (only while RAISE_KIT_ENABLED is on). */
export function GET() {
  return helpFile(() => (isRaiseKitEnabled() ? helpPageMarkdown("raise-kit") : null), MARKDOWN);
}

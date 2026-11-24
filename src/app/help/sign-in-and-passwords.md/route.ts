import { isPasswordSigninAvailable } from "@/lib/auth/flags";
import { helpFile, MARKDOWN, helpPageMarkdown } from "@/lib/help/agentFiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /help/sign-in-and-passwords as Markdown, for AI assistants (only while PASSWORD_SIGNIN_ENABLED is on). */
export function GET() {
  return helpFile(() => (isPasswordSigninAvailable() ? helpPageMarkdown("sign-in-and-passwords") : null), MARKDOWN);
}

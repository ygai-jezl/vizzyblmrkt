import { agentRedirect } from "@/lib/developers/agentDocs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /developers/events.md moved to /developers/users.md with API v2 (2026-09-25): prompts copied earlier still land. */
export function GET() {
  return agentRedirect("/developers/users.md");
}

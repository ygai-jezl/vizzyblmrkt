import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  isAgentRuntimeConfigured,
  compositeUserId,
  getAgentSession,
} from "@/lib/agents/agentRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fetch one session (including its event history) so the dashboard can rehydrate
 * a prior conversation. Scoped to the caller's composite user id, so a user can
 * only read their own tenant-scoped sessions.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAgentRuntimeConfigured()) {
    return NextResponse.json({ error: "agent_not_configured" }, { status: 503 });
  }
  const { sessionId } = await params;
  try {
    const session = await getAgentSession(compositeUserId(ctx), sessionId);
    return NextResponse.json({ session });
  } catch (err) {
    console.error("[agent-session] get failed:", err);
    return NextResponse.json({ error: "session_get_failed" }, { status: 502 });
  }
}

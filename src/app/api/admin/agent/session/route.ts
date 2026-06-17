import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  isAgentRuntimeConfigured,
  compositeUserId,
  createAgentSession,
  listAgentSessions,
} from "@/lib/agents/agentRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Root-agent session management. Sessions are owned by Agent Runtime, scoped by
 * the composite `{tenantId}_{userId}` Memory Bank key so a user's sessions never
 * cross tenants. POST mints a session; GET lists the current user's sessions
 * (forward-looking — a session switcher lands in a later phase).
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAgentRuntimeConfigured()) {
    return NextResponse.json({ error: "agent_not_configured" }, { status: 503 });
  }
  try {
    const sessionId = await createAgentSession(compositeUserId(ctx));
    return NextResponse.json({ sessionId });
  } catch (err) {
    console.error("[agent-session] create failed:", err);
    return NextResponse.json({ error: "session_create_failed" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx || !ctx.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAgentRuntimeConfigured()) {
    return NextResponse.json({ sessions: [] });
  }
  try {
    const sessions = await listAgentSessions(compositeUserId(ctx));
    return NextResponse.json({ sessions });
  } catch (err) {
    console.error("[agent-session] list failed:", err);
    return NextResponse.json({ error: "session_list_failed" }, { status: 502 });
  }
}

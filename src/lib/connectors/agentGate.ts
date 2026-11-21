import { isRateLimited, type TenantContext } from "@/lib/tenant";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isConnectorsChatEnabled } from "./flags";
import type { ConnectorActor } from "./grants";

/** What an agent route answers: a status and a JSON body. */
export type AgentApiResult = { status: number; body: Record<string, unknown> };

/**
 * Vizzy's reads are tight: each spends the provider's quota (a Google Analytics property has daily
 * tokens), so a burst of 10 and 60 an hour per brand.
 */
export const CONNECTORS_AGENT_LIMIT = { prefix: "connectors_agent", burstLimit: 10, hourlyLimit: 60 };

/**
 * For /api/agent/connectors/*, copied from resultsAgentGate (src/lib/metrics/agentGate.ts): the
 * switch, then the signed canvas token in `X-Canvas-Context` (the brand comes from the token, never
 * the request), then a rate limit per brand. The actor is Vizzy reading for the signed-in person
 * whose role the token carries: anything but "admin" reads as a member, so the grants table
 * (src/lib/connectors/grants.ts) never shows a member more through Vizzy than they could read.
 */
export async function connectorsAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext; actor: ConnectorActor } | { ok: false; result: AgentApiResult }> {
  if (!isConnectorsChatEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, CONNECTORS_AGENT_LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx, actor: { kind: "agent", agent: "vizzy", forRole: verified.claims.role === "admin" ? "admin" : "member" } };
}

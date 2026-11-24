import { isRateLimited, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isConnectorsChatEnabled, isConnectorSignalsEnabled, isConnectorsNumbersEnabled } from "./flags";
import type { ConnectorActor } from "./grants";

/** What an agent route answers: a status and a JSON body. */
export type AgentApiResult = { status: number; body: Record<string, unknown> };

/**
 * Vizzy's reads are tight: each spends the provider's quota (a Google Analytics property has daily
 * tokens), so a burst of 10 and 60 an hour per brand.
 */
export const CONNECTORS_AGENT_LIMIT: RateLimitConfig = { prefix: "connectors_agent", burstLimit: 10, hourlyLimit: 60 };

/**
 * Collected numbers (Connectors 2, ADR-0012) read only YouGrow's own snapshots, never the provider,
 * so they get a bucket of their own and a looser hour: a burst of 10 and 120 an hour per brand. Not
 * the live reads' bucket (a provider's quota), nor the results routes' (shared with email and post
 * results).
 */
export const CONNECTORS_NUMBERS_LIMIT: RateLimitConfig = { prefix: "connectors_numbers", burstLimit: 10, hourlyLimit: 120 };

/** Which switch a route needs and which bucket it counts in; the live reads' by default. */
export interface ConnectorsGateOptions {
  enabled?: () => boolean;
  limit?: RateLimitConfig;
}

/** The numbers route: Vizzy reading connected data and collected numbers both on, its own bucket. */
export const NUMBERS_GATE: Required<ConnectorsGateOptions> = { enabled: isConnectorsNumbersEnabled, limit: CONNECTORS_NUMBERS_LIMIT };

/** The suggestions route (get_number_suggestions): signals on instead of chat, sharing the numbers bucket. */
export const SUGGESTIONS_GATE: Required<ConnectorsGateOptions> = { enabled: isConnectorSignalsEnabled, limit: CONNECTORS_NUMBERS_LIMIT };

/**
 * For /api/agent/connectors/*, copied from resultsAgentGate (src/lib/metrics/agentGate.ts): the
 * switch, then the signed canvas token in `X-Canvas-Context` (the brand comes from the token, never
 * the request), then a rate limit per brand. The actor is Vizzy reading for the signed-in person
 * whose role the token carries: anything but "admin" reads as a member, so the grants table
 * (src/lib/connectors/grants.ts) never shows a member more through Vizzy than they could read.
 */
export async function connectorsAgentGate(
  req: Request,
  opts: ConnectorsGateOptions = {},
): Promise<{ ok: true; ctx: TenantContext; actor: ConnectorActor } | { ok: false; result: AgentApiResult }> {
  if (!(opts.enabled ?? isConnectorsChatEnabled)()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, opts.limit ?? CONNECTORS_AGENT_LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx, actor: { kind: "agent", agent: "vizzy", forRole: verified.claims.role === "admin" ? "admin" : "member" } };
}

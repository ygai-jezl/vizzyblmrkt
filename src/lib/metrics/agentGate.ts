import { isRateLimited, type TenantContext } from "@/lib/tenant";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isResultsChatEnabled } from "./flags";
import type { ApiResult } from "./results";

const RESULTS_LIMIT = { prefix: "results_agent", burstLimit: 10, hourlyLimit: 120 };

/**
 * For /api/agent/results/*: the switch, then the signed canvas token in `X-Canvas-Context` (the
 * brand comes from the token, never the request), then a rate limit per brand.
 */
export async function resultsAgentGate(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isResultsChatEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, RESULTS_LIMIT)) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

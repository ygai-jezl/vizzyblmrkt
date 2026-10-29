import { isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isOneViewEnabled } from "./flags";
import { peopleFilters } from "./peopleList";

/**
 * What Vizzy may read about a brand's audience (AUDIENCE_ONE_VIEW_ENABLED): how many
 * people there are, how many we can email, and how many are on each launch, from the
 * brand's own site, and in each product at each stage. Counts only, never a person, a
 * name or an address. Auth is the signed canvas token, which also names the brand.
 */

export type ApiResult = { status: number; body: unknown };

/** One read is a few count() queries per launch and product; plenty for a chat. */
const COUNTS_LIMIT = { prefix: "audience_agent", burstLimit: 10, hourlyLimit: 120 };

export function audienceAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isOneViewEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

export async function agentAudienceCounts(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, COUNTS_LIMIT, { db })) return { status: 429, body: { error: "rate_limited" } };
  const f = await peopleFilters(ctx, db);
  return {
    status: 200,
    body: {
      people: f.everyone,
      canEmail: f.canEmail,
      fromYourSite: f.via.site,
      launches: f.launches.map((l) => ({ name: l.name, people: l.count })),
      products: f.products.map((p) => ({ name: p.name, people: p.count, stages: p.stages })),
      note: "One person per address across every launch and product. Stages are per product: someone stuck is not counted as onboarding, and quiet overlaps the other stages.",
    },
  };
}

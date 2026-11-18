import { z } from "zod";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { monthlyLimit } from "@/lib/plans/limits";
import { getTenantById } from "@/lib/tenant";
import { setTenantSearchMarket } from "@/lib/tenant/control";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { SearchMarketSchema } from "@/lib/types/brandSignal";
import type { Tenant } from "@/lib/types/tenant";
import { collectSignal, lookUpQuestion, ownHostsOf, type CollectDeps } from "./collect";
import { dataForSeoConfigured } from "./dataforseo";
import { isBrandSignalsEnabled, isSignalsDataForSeoEnabled } from "./flags";
import { brandMarket, DEFAULT_MARKET, isKnownMarket, LANGUAGES, marketLabel, MARKETS } from "./markets";
import { getSignal, lookupsThisMonth } from "./store";
import { signalView } from "./view";

/**
 * The admin APIs behind "Get from Google" (the brief's What buyers ask box) and Settings ›
 * Google market. Routes call these after the origin check and sign-in; the tenant always comes
 * from the session.
 */

export type ApiResult = { status: number; body: unknown };

export interface AdminDeps extends CollectDeps {
  rateLimited?: (subject: string) => Promise<boolean>;
}

const loadOf = (deps: AdminDeps) => deps.loadTenant ?? getTenantById;

/** Whether "Get from Google" can be offered, the market it searches, and this month's use. */
export async function lookupStatus(ctx: TenantContext, deps: AdminDeps = {}): Promise<ApiResult> {
  if (!isSignalsDataForSeoEnabled()) return { status: 503, body: { error: "unavailable" } };
  const tenant = await loadOf(deps)(ctx.tenantId).catch(() => null);
  if (!tenantMayUse(tenant, "next_up")) return { status: 403, body: { error: "not_included" } };
  const market = brandMarket(tenant?.searchMarket);
  return {
    status: 200,
    body: {
      available: dataForSeoConfigured(deps.env ?? process.env),
      market: marketLabel(market),
      used: await lookupsThisMonth(ctx, deps),
      limit: monthlyLimit(tenant, "next_up"),
    },
  };
}

export const LookupInput = z.object({
  query: z.string().trim().min(3).max(300),
  questionId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable()
    .optional(),
  subjectId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable()
    .optional(),
});

/** Look a question up for the person waiting (members may ask: the brand's cap is the guard). */
export async function startLookup(ctx: TenantContext, raw: unknown, deps: AdminDeps = {}): Promise<ApiResult> {
  if (!isSignalsDataForSeoEnabled()) return { status: 503, body: { error: "unavailable" } };
  const parsed = LookupInput.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const limited = deps.rateLimited ?? ((s: string) => isRateLimited(s, { prefix: "serp_lookup", burstLimit: 5, hourlyLimit: 30 }));
  if (await limited(`tenant:${ctx.tenantId}`)) return { status: 429, body: { error: "rate_limited" } };
  const got = await lookUpQuestion(
    ctx,
    { query: parsed.data.query, questionId: parsed.data.questionId ?? null, subjectId: parsed.data.subjectId ?? null },
    deps,
  );
  if (!got.ok) {
    if (got.detail) console.warn(`[signals] lookup for ${ctx.tenantId} failed: ${got.detail}`);
    return { status: got.status, body: { error: got.error } };
  }
  return { status: 200, body: { reused: got.reused, signal: signalView(got.signal) } };
}

const SIGNAL_ID = /^sig_[a-f0-9]{24}$/;

/** One lookup, collected now when DataForSEO should have finished, so the page needn't wait for the tick. */
export async function readLookup(ctx: TenantContext, id: string, deps: AdminDeps = {}): Promise<ApiResult> {
  if (!isSignalsDataForSeoEnabled()) return { status: 503, body: { error: "unavailable" } };
  if (!SIGNAL_ID.test(id)) return { status: 400, body: { error: "invalid_input" } };
  let signal = await getSignal(ctx, id, deps);
  if (!signal) return { status: 404, body: { error: "not_found" } };
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  if (signal.status === "posted" && Date.parse(signal.dueAt) <= nowMs && dataForSeoConfigured(deps.env ?? process.env)) {
    const tenant = await loadOf(deps)(ctx.tenantId).catch(() => null);
    await collectSignal(ctx, signal, await ownHostsOf(ctx, tenant, deps), deps);
    signal = (await getSignal(ctx, id, deps)) ?? signal;
  }
  return { status: 200, body: { signal: signalView(signal) } };
}

/** The brand's Google market and the choices. */
export async function readMarket(ctx: TenantContext, deps: AdminDeps = {}): Promise<ApiResult> {
  if (!isBrandSignalsEnabled()) return { status: 503, body: { error: "unavailable" } };
  const tenant: Tenant | null = await loadOf(deps)(ctx.tenantId).catch(() => null);
  const market = brandMarket(tenant?.searchMarket);
  return {
    status: 200,
    body: {
      market,
      chosen: Boolean(tenant?.searchMarket && isKnownMarket(tenant.searchMarket)),
      label: marketLabel(market),
      countries: MARKETS.map((m) => ({ country: m.country, name: m.name, language: m.language })),
      languages: Object.entries(LANGUAGES).map(([code, name]) => ({ code, name })),
      default: DEFAULT_MARKET,
    },
  };
}

/** Admins choose the brand's Google market, or `null` for the default. */
export async function saveMarket(
  ctx: TenantContext,
  raw: unknown,
  deps: AdminDeps & { save?: typeof setTenantSearchMarket } = {},
): Promise<ApiResult> {
  if (!isBrandSignalsEnabled()) return { status: 503, body: { error: "unavailable" } };
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  const body = raw as { market?: unknown } | null;
  if (body && body.market === null) {
    const ok = await (deps.save ?? setTenantSearchMarket)(ctx.tenantId, null);
    return ok ? { status: 200, body: { market: DEFAULT_MARKET, label: marketLabel(DEFAULT_MARKET), chosen: false } } : { status: 404, body: { error: "not_found" } };
  }
  const parsed = SearchMarketSchema.safeParse(body?.market);
  if (!parsed.success || !isKnownMarket(parsed.data)) return { status: 400, body: { error: "invalid_input" } };
  const ok = await (deps.save ?? setTenantSearchMarket)(ctx.tenantId, parsed.data);
  return ok ? { status: 200, body: { market: parsed.data, label: marketLabel(parsed.data), chosen: true } } : { status: 404, body: { error: "not_found" } };
}

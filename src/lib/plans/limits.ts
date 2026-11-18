import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";

/**
 * How much of a costly feature one brand may use in a calendar month. One place decides it, so a
 * cap is changed without code:
 *
 *   1. the brand's own value (`tenant.featureLimits[feature]`, set with
 *      `scripts/grant-feature.ts --limit`), else
 *   2. this copy's setting, FEATURE_MONTHLY_LIMITS ("next_up=100,competitor_articles=200"), else
 *   3. the default below.
 *
 * A cap of 0 stops the feature for that brand without taking the grant away.
 */
export const LIMITED_FEATURES = ["next_up", "competitor_articles"] as const;
export type LimitedFeature = (typeof LIMITED_FEATURES)[number];

export const DEFAULT_MONTHLY_LIMITS: Record<LimitedFeature, number> = {
  /** Google results looked up through DataForSEO. */
  next_up: 100,
  /** Competitor articles read by Gemini. */
  competitor_articles: 200,
};

/** The most a cap may be set to, so a typo can't open the tap. */
export const MAX_MONTHLY_LIMIT = 100_000;

export function isLimitedFeature(f: string): f is LimitedFeature {
  return (LIMITED_FEATURES as readonly string[]).includes(f);
}

function validCap(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_MONTHLY_LIMIT;
}

/** This copy's caps from FEATURE_MONTHLY_LIMITS. A part that doesn't parse is ignored. */
export function copyMonthlyLimits(raw: string | undefined = process.env.FEATURE_MONTHLY_LIMITS): Partial<Record<LimitedFeature, number>> {
  const out: Partial<Record<LimitedFeature, number>> = {};
  for (const part of (raw ?? "").split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (!key || !value || !isLimitedFeature(key) || !/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (validCap(n)) out[key] = n;
  }
  return out;
}

/** The cap in force for a brand, and where it came from. Pure. */
export function monthlyLimitOf(
  tenant: Pick<Tenant, "featureLimits"> | null,
  feature: LimitedFeature,
): { limit: number; from: "brand" | "copy" | "default" } {
  const own = tenant?.featureLimits?.[feature];
  if (validCap(own)) return { limit: own, from: "brand" };
  const copy = copyMonthlyLimits()[feature];
  if (validCap(copy)) return { limit: copy, from: "copy" };
  return { limit: DEFAULT_MONTHLY_LIMITS[feature], from: "default" };
}

/** The cap in force for a brand. Pure. */
export function monthlyLimit(tenant: Pick<Tenant, "featureLimits"> | null, feature: LimitedFeature): number {
  return monthlyLimitOf(tenant, feature).limit;
}

/** The signed-in brand's cap. Reads the brand record; a failed read falls back to the copy's cap. */
export async function brandMonthlyLimit(
  ctx: Pick<TenantContext, "tenantId">,
  feature: LimitedFeature,
  load: (id: string) => Promise<Tenant | null> = getTenantById,
): Promise<number> {
  const tenant = await load(ctx.tenantId).catch(() => null);
  return monthlyLimit(tenant, feature);
}

/** `--limit` for scripts/grant-feature.ts: a cap, null for "default" (the copy's cap), or "invalid". */
export function parseLimitArg(raw: string): number | null | "invalid" {
  const v = raw.trim().toLowerCase();
  if (v === "default") return null;
  if (!/^\d+$/.test(v)) return "invalid";
  const n = Number(v);
  return validCap(n) ? n : "invalid";
}

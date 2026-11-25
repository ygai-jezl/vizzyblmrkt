import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { activePlanOf } from "./catalog";
import { isPlansEnabled } from "./flags";
import { RESOURCE_IDS, RESOURCES, type ResourceId } from "./resources";

/**
 * How much of a costly feature one brand may use in a calendar month. One place decides it, so a
 * cap is changed without code:
 *
 *   1. the brand's own value (`tenant.featureLimits[feature]`, set with
 *      `scripts/grant-feature.ts --limit`), else
 *   2. with PLANS_ENABLED, its plan's cap (`monthlyCaps` in src/lib/plans/catalog.ts), else
 *   3. this copy's setting, FEATURE_MONTHLY_LIMITS ("next_up=100,competitor_articles=200"), else
 *   4. the default below.
 *
 * A plan that sets no cap for a feature falls through to the copy's setting. Paid resources
 * (src/lib/plans/resources.ts, such as web searches for research) are capped the same way.
 * A cap of 0 stops the feature for that brand without taking the grant away.
 */
export const LIMITED_FEATURES = ["next_up", "competitor_articles", "article_autopilot", "article_refresh"] as const;
export type LimitedFeature = (typeof LIMITED_FEATURES)[number];

/** Paid resources with a monthly cap (src/lib/plans/resources.ts), capped the same way as a feature. */
export type LimitedResource = { [K in ResourceId]: (typeof RESOURCES)[K]["capped"] extends true ? K : never }[ResourceId];
export const LIMITED_RESOURCES = RESOURCE_IDS.filter((r) => RESOURCES[r].capped) as LimitedResource[];

/** Anything with a monthly cap: a costly feature, or a paid resource. */
export type CapKey = LimitedFeature | LimitedResource;

export const DEFAULT_MONTHLY_LIMITS: Record<CapKey, number> = {
  /** Google results looked up through DataForSEO. */
  next_up: 100,
  /** Competitor articles read by Gemini. */
  competitor_articles: 200,
  /** Workflows the article autopilot drafts (counted when the plan is made). */
  article_autopilot: 8,
  /** Refresh reviews of live articles (counted when one starts). */
  article_refresh: 20,
  /** Google searches Gemini runs for research: counted, but in practice uncapped unless a plan or this copy sets one. */
  web_searches: 100_000,
  /** Images a model draws: counted, and in practice uncapped until a plan or this copy sets a cap. */
  images: 100_000,
};

/** The most a cap may be set to, so a typo can't open the tap. */
export const MAX_MONTHLY_LIMIT = 100_000;

export function isLimitedFeature(f: string): f is LimitedFeature {
  return (LIMITED_FEATURES as readonly string[]).includes(f);
}

export function isLimitedResource(r: string): r is LimitedResource {
  return (LIMITED_RESOURCES as readonly string[]).includes(r);
}

export function isCapKey(k: string): k is CapKey {
  return isLimitedFeature(k) || isLimitedResource(k);
}

function validCap(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_MONTHLY_LIMIT;
}

/** This copy's caps from FEATURE_MONTHLY_LIMITS. A part that doesn't parse is ignored. */
export function copyMonthlyLimits(raw: string | undefined = process.env.FEATURE_MONTHLY_LIMITS): Partial<Record<CapKey, number>> {
  const out: Partial<Record<CapKey, number>> = {};
  for (const part of (raw ?? "").split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim());
    if (!key || !value || !isCapKey(key) || !/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (validCap(n)) out[key] = n;
  }
  return out;
}

type CapFields = Pick<Tenant, "featureLimits" | "orgPlan">;
export type CapSource = "brand" | "plan" | "copy" | "default";

/** The cap in force for a brand and where it came from, with plans on or off as given. Pure (reads the settings). */
export function monthlyLimitWith(
  tenant: CapFields | null | undefined,
  feature: CapKey,
  plansOn: boolean,
): { limit: number; from: CapSource } {
  const own = tenant?.featureLimits?.[feature];
  if (validCap(own)) return { limit: own, from: "brand" };
  const planCap = activePlanOf(tenant, plansOn)?.monthlyCaps[feature];
  if (validCap(planCap)) return { limit: planCap, from: "plan" };
  const copy = copyMonthlyLimits()[feature];
  if (validCap(copy)) return { limit: copy, from: "copy" };
  return { limit: DEFAULT_MONTHLY_LIMITS[feature], from: "default" };
}

/** The cap in force for a brand, and where it came from. Pure. */
export function monthlyLimitOf(tenant: CapFields | null, feature: CapKey): { limit: number; from: CapSource } {
  return monthlyLimitWith(tenant, feature, isPlansEnabled());
}

/** The cap in force for a brand. Pure. */
export function monthlyLimit(tenant: CapFields | null, feature: CapKey): number {
  return monthlyLimitOf(tenant, feature).limit;
}

/** The signed-in brand's cap. Reads the brand record; a failed read falls back to the copy's cap. */
export async function brandMonthlyLimit(
  ctx: Pick<TenantContext, "tenantId">,
  feature: CapKey,
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

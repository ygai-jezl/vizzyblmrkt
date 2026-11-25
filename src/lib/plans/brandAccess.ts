import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { activePlanOf, INCLUDED_IN_EVERY_PLAN } from "./catalog";
import { isPlansEnabled } from "./flags";

/**
 * Which brands may use a feature that costs money to run. Each feature also has its own switch;
 * this decides between brands once the switch is on. It is the one place a plan check belongs.
 *
 * In this order (decision 18):
 *   1. GRANTED_ONLY_FEATURES (comma-separated) names the features only some brands get. A brand
 *      gets a listed feature only when its record's `grantedFeatures` includes it, whatever its
 *      plan says.
 *   2. A brand's own grant adds a feature its plan lacks.
 *   3. With PLANS_ENABLED, the plan its organisation is on (the brand's `orgPlan` copy,
 *      src/lib/plans/catalog.ts) decides.
 *   4. Otherwise the brand may use it. No plan, or an unknown plan, means open.
 *
 * With PLANS_ENABLED off and GRANTED_ONLY_FEATURES empty, every brand may use every feature (a
 * self-hosted copy's default), exactly as before plans.
 */
export const METERED_FEATURES = ["edit_vizzy", "edit_vizzy_learning", "competitors", "competitor_articles", "brand_search", "next_up", "article_autopilot", "article_refresh"] as const;
export type MeteredFeature = (typeof METERED_FEATURES)[number];

/** The features this deployment keeps for granted brands. */
export function grantedOnlyFeatures(): Set<string> {
  return new Set(
    (process.env.GRANTED_ONLY_FEATURES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

type AccessFields = Pick<Tenant, "grantedFeatures" | "orgPlan">;

/** Whether a brand may use the feature, with plans on or off as given. Pure (reads the settings). */
export function mayUseWith(tenant: AccessFields | null | undefined, feature: MeteredFeature, plansOn: boolean): boolean {
  const granted = Boolean(tenant?.grantedFeatures?.includes(feature));
  if (grantedOnlyFeatures().has(feature)) return granted;
  if (granted) return true;
  const plan = activePlanOf(tenant, plansOn);
  return plan ? plan.features.includes(feature) : true;
}

/**
 * Features that only work alongside another. In today's code the article autopilot sits behind
 * Next up: its scheduled runs pick only brands with next_up (src/lib/autopilot/tick.ts) and every
 * autopilot route checks next_up first (src/lib/autopilot/adminApi.ts nextUpGate, agentApi.ts).
 * So a brand that may use the autopilot but not Next up can't reach it. No plan includes one
 * without the other (catalog.test.ts checks), but a brand's own grant can give it alone.
 */
export const FEATURE_NEEDS: Partial<Record<MeteredFeature, MeteredFeature>> = { article_autopilot: "next_up" };

/**
 * Whether a brand can actually reach the feature: it may use it and what it needs. What Plan and
 * usage and the dry runs report; the features' own checks stay as they are. Pure.
 */
export function mayReachWith(tenant: AccessFields | null | undefined, feature: MeteredFeature, plansOn: boolean): boolean {
  if (!mayUseWith(tenant, feature, plansOn)) return false;
  const needs = FEATURE_NEEDS[feature];
  return needs ? mayReachWith(tenant, needs, plansOn) : true;
}

/** Whether a brand may use the feature, given its record. Pure. */
export function tenantMayUse(tenant: AccessFields | null, feature: MeteredFeature): boolean {
  return mayUseWith(tenant, feature, isPlansEnabled());
}

/**
 * Whether the signed-in brand may use the feature. Reads the brand only when it has to: never for
 * a feature that isn't held back when plans are off, or that every plan includes. A failed read
 * answers as for a brand with no record: no for a held back feature, yes otherwise.
 */
export async function brandCanUse(
  ctx: Pick<TenantContext, "tenantId">,
  feature: MeteredFeature,
  load: (id: string) => Promise<Tenant | null> = getTenantById,
): Promise<boolean> {
  const plansOn = isPlansEnabled();
  if (!grantedOnlyFeatures().has(feature) && (!plansOn || INCLUDED_IN_EVERY_PLAN.includes(feature))) return true;
  const tenant = await load(ctx.tenantId).catch(() => null);
  return mayUseWith(tenant, feature, plansOn);
}

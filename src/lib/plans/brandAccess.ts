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
export const METERED_FEATURES = ["edit_vizzy", "edit_vizzy_learning", "competitors", "competitor_articles", "brand_search", "next_up", "article_autopilot"] as const;
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

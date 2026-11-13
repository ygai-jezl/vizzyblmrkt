import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";

/**
 * Which brands may use a feature that costs money to run. Each feature also has its own switch;
 * this decides between brands once the switch is on. It is the one place a plan or tier check
 * belongs when there are plans.
 *
 * GRANTED_ONLY_FEATURES (comma-separated) names the features only some brands get. A brand gets
 * a listed feature when its record's `grantedFeatures` includes it. Empty or unset: every brand
 * may use every feature (a self-hosted copy's default).
 */
export const METERED_FEATURES = ["edit_vizzy", "edit_vizzy_learning"] as const;
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

/** Whether a brand may use the feature, given its record. Pure. */
export function tenantMayUse(tenant: Pick<Tenant, "grantedFeatures"> | null, feature: MeteredFeature): boolean {
  if (!grantedOnlyFeatures().has(feature)) return true;
  return Boolean(tenant?.grantedFeatures?.includes(feature));
}

/** Whether the signed-in brand may use the feature. Reads the brand only when it has to. */
export async function brandCanUse(
  ctx: Pick<TenantContext, "tenantId">,
  feature: MeteredFeature,
  load: (id: string) => Promise<Tenant | null> = getTenantById,
): Promise<boolean> {
  if (!grantedOnlyFeatures().has(feature)) return true;
  const tenant = await load(ctx.tenantId).catch(() => null);
  return tenantMayUse(tenant, feature);
}

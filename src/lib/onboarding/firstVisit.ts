import type { Tenant } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * Whether Home sends this person to the welcome (ONBOARDING_ENABLED, checked by the caller):
 * an admin, of a brand with no profile yet, that has never made anything (launches and programmes,
 * archived ones too, any connection, sandboxes too, and any lifecycle journey) and has no
 * sign-ups. Anything unknown says no: a failed read of the brand, its records or its sign-ups
 * never sends a busy brand to the welcome. Existing brands always have something, so they start
 * from Settings instead; members never get it.
 *
 * Home then marks the profile started (startBusinessProfile), so it shows once per brand.
 */
export function shouldWelcome(
  tenant: Pick<Tenant, "businessProfile"> | null,
  signals: { recordsEver: number | null; signups: number | null },
  role: TenantRole | undefined,
): boolean {
  return role === "admin" && !!tenant && !tenant.businessProfile && signals.recordsEver === 0 && signals.signups === 0;
}

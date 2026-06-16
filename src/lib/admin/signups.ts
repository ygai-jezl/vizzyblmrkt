import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { AdminSignupRow } from "@/components/admin/SignupsTable";

/**
 * Fetch admin signup rows for the global table or a single launch (campaign).
 *
 * Shared by the global Signups page and the per-launch Signups tab so both
 * render the identical table. Admins own their tenant's data, so PII is
 * returned UNMASKED (the public leaderboard masks; this admin view does not).
 * Deleted signups are filtered out.
 *
 * When `campaignId` is set the query adds `where(campaignId == id)` +
 * `orderBy(createdAt desc)`, which needs the composite index
 * `tenantId, campaignId, createdAt` (see firestore.indexes.json).
 */
export async function fetchAdminSignupRows(
  ctx: TenantContext,
  opts: { campaignId?: string; limit?: number } = {},
): Promise<AdminSignupRow[]> {
  const signups = await forTenant(ctx).signups.find({
    where: opts.campaignId ? [["campaignId", "==", opts.campaignId]] : [],
    orderBy: [["createdAt", "desc"]],
    limit: opts.limit ?? 200,
  });

  return signups
    .filter((s) => s.status !== "deleted")
    .map((s) => ({
      id: s.id,
      email: s.email ?? null,
      firstName: s.firstName ?? null,
      lastName: s.lastName ?? null,
      status: s.status,
      amountReferred: s.amountReferred,
      createdAt: s.createdAt,
    }));
}

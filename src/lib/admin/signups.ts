import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { computeRanks } from "@/lib/waitlist/rank";
import type { AdminSignupRow } from "@/components/admin/SignupsTable";

/**
 * Fetch admin signup rows for the global table or a single launch (campaign).
 *
 * Shared by the global Signups page and the per-launch Signups tab so both
 * render the identical table. Admins own their tenant's data, so PII is
 * returned UNMASKED (the public leaderboard masks; this admin view does not).
 *
 * `status` splits the Active list from the Offboarded directory (PRD §4.2):
 *   - "active" (default): everything except offboarded + deleted;
 *   - "offboarded": only offboarded (still retained in the CRM, just off the list).
 * Filtering is in-memory over the latest `limit` (cursor pagination is a separate,
 * deferred slice), matching the existing window behaviour.
 *
 * When `campaignId` is set, queue `rank` is attached per row (per-campaign +
 * only meaningful in a single-launch view; null for unverified/offboarded rows).
 */
export async function fetchAdminSignupRows(
  ctx: TenantContext,
  opts: { campaignId?: string; limit?: number; status?: "active" | "offboarded" } = {},
): Promise<AdminSignupRow[]> {
  const status = opts.status ?? "active";
  const signups = await forTenant(ctx).signups.find({
    where: opts.campaignId ? [["campaignId", "==", opts.campaignId]] : [],
    orderBy: [["createdAt", "desc"]],
    limit: opts.limit ?? 200,
  });

  const visible = signups.filter((s) =>
    status === "offboarded"
      ? s.status === "offboarded"
      : s.status !== "offboarded" && s.status !== "deleted",
  );

  // Rank only in a single-launch view (it is per-campaign). Best-effort: a rank
  // failure must not blank the whole table.
  const ranks = opts.campaignId
    ? await computeRanks(ctx, opts.campaignId).catch(() => null)
    : null;

  return visible.map((s) => ({
    id: s.id,
    email: s.email ?? null,
    firstName: s.firstName ?? null,
    lastName: s.lastName ?? null,
    status: s.status,
    amountReferred: s.amountReferred,
    rank: ranks?.get(s.id),
    createdAt: s.createdAt,
  }));
}

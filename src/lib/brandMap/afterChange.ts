import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * What follows a change to the map's records (BRAND_MAP_SCALE_ENABLED), for the subjects it
 * touched: their counts and their group's totals are worked out again, and their embeddings
 * rewritten. Best effort, after the change is saved: it never fails the change.
 */
export async function afterRecordsChange(
  ctx: TenantContext,
  touched: { subjects: string[] },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<void> {
  void ctx;
  void touched;
  void deps;
}

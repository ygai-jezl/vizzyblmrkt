import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TENANT_FIELD } from "./repository";
import type { FirestoreLike, QueryLike, TenantContext } from "./types";

/**
 * How many of a brand's launches are live (not archived), for Plan and usage. A launch is live
 * while it has no `archivedAt` (src/lib/types/campaign.ts).
 *
 * It pages the brand's campaigns in document-id order reading only `tenantId` and `archivedAt`,
 * as src/lib/tenant/brandMapPages.ts does: document-id order needs no composite index, and
 * launches written before `archivedAt` existed are still read (a filter on it would skip them).
 * Counting unarchived launches with a query would need a composite index on archivedAt.
 *
 * Every document read is billed even with a projection, so it reads at most `max` launches. When
 * there are more, `capped` is true and the count is a floor ("5000 or more"), never a silent
 * undercount.
 */
export async function countLiveLaunches(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  opts: { max?: number; pageSize?: number } = {},
  db?: FirestoreLike,
): Promise<{ count: number; capped: boolean }> {
  const regional = db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const max = Math.max(1, opts.max ?? 5000);
  const pageSize = Math.max(1, opts.pageSize ?? 500);
  let count = 0;
  let read = 0;
  let after: string | null = null;
  for (;;) {
    // One more than `max` in all, to tell "exactly max" from "more than max".
    const want = Math.min(pageSize, max + 1 - read);
    let q: QueryLike = regional.collection("campaigns").where(TENANT_FIELD, "==", ctx.tenantId).orderBy("__name__", "asc");
    if (q.select) q = q.select(TENANT_FIELD, "archivedAt");
    if (after) q = q.startAfter(after);
    const snap = await q.limit(want).get();
    for (const d of snap.docs) {
      if (read >= max) return { count, capped: true };
      read += 1;
      const data = d.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId) continue; // defence in depth
      if (!data.archivedAt) count += 1;
    }
    if (snap.docs.length < want) return { count, capped: false };
    after = snap.docs[snap.docs.length - 1]!.id;
  }
}

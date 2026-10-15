import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { recountSubject } from "./recount";

/**
 * What follows a change to the map's records (BRAND_MAP_SCALE_ENABLED), for the subjects it
 * touched: their counts and their group's totals are worked out again (and, next, their
 * embeddings rewritten). Best effort, after the change is saved: it never fails the change.
 */
export async function afterRecordsChange(
  ctx: TenantContext,
  touched: { subjects: string[] },
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<void> {
  const subjects = [...new Set(touched.subjects)];
  for (let i = 0; i < subjects.length; i += 5) {
    await Promise.all(
      subjects.slice(i, i + 5).map((id) =>
        recountSubject(ctx, id, deps).catch((err: unknown) => {
          console.warn("[brand-map] recount after a change failed", err instanceof Error ? err.message.slice(0, 200) : "error");
          return null;
        }),
      ),
    );
  }
}

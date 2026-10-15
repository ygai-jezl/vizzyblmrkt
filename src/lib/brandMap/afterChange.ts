import type { TenantContext } from "@/lib/tenant/types";
import { embedSubjects, type EmbedDeps } from "./embed";
import { recountGroup, recountSubject } from "./recount";

/**
 * What follows a change to the map's records (BRAND_MAP_SCALE_ENABLED), for the subjects it
 * touched: their counts are worked out again, then the totals of every group they are in (and
 * of `groups`: one a subject left, or was in before it was removed or merged away), each
 * group once; and their embeddings are rewritten (with their status). Best effort, after the
 * change is saved: it never fails it.
 */
export async function afterRecordsChange(
  ctx: TenantContext,
  touched: { subjects: string[]; groups?: Array<string | null> },
  deps: EmbedDeps = {},
): Promise<void> {
  const subjects = [...new Set(touched.subjects)];
  const groups = new Set<string | null>(touched.groups ?? []);
  for (let i = 0; i < subjects.length; i += 5) {
    const reads = await Promise.all(
      subjects.slice(i, i + 5).map((id) =>
        recountSubject(ctx, id, deps, { group: false }).catch((err: unknown) => {
          console.warn("[brand-map] recount after a change failed", err instanceof Error ? err.message.slice(0, 200) : "error");
          return null;
        }),
      ),
    );
    for (const read of reads) if (read) groups.add(read.subject.groupId);
  }
  for (const group of groups) {
    await recountGroup(ctx, group, deps).catch((err: unknown) => {
      console.warn("[brand-map] group totals after a change failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    });
  }
  await embedSubjects(ctx, subjects, deps).catch((err: unknown) => {
    console.warn("[brand-map] embedding after a change failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return 0;
  });
}

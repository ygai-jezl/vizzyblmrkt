import { LOOP_DAYS, loopDayId } from "@/lib/tenant/loops";
import type { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { LOOP_RULES } from "../registry";

/**
 * For tests: a brand's week of counters as one tree, its shards added up, as the fold will add
 * them (learning loops step 4).
 */
export function sumWeek(db: FakeFirestore, tenantId: string, isoWeek: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const add = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(from)) {
      if (typeof v === "number") into[k] = ((into[k] as number | undefined) ?? 0) + v;
      else if (v && typeof v === "object") add((into[k] ??= {}) as Record<string, unknown>, v as Record<string, unknown>);
    }
  };
  for (let shard = 0; shard < LOOP_RULES.shards; shard++) {
    const doc = db.raw(LOOP_DAYS, loopDayId.week(tenantId, isoWeek, shard));
    if (doc?.d) add(out, doc.d as Record<string, unknown>);
  }
  return out;
}

import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { nextUpDocId } from "@/lib/types/autopilot";

/** The chip label Next up gives an AI answers line (ADR-0019). */
export const AI_ANSWERS_CHIP = "AI answers";

/**
 * Take off the stored Next up picks that weighed AI answers (a chip of their own), once a
 * connection that gives them stops feeding planning or is disconnected: the stored list is seen
 * by the whole team and by Vizzy, and a pick's reason may rest on those numbers, as for Search
 * Console (ADR-0012). The next pick weighs what is left. Returns how many.
 */
export async function dropAiAnswersPicks(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<number> {
  let dropped = 0;
  await forTenant(ctx, deps.db).nextUp.claim(nextUpDocId(ctx.tenantId), (cur) => {
    const keep = cur.picks.filter((p) => !p.chips.some((c) => c.label === AI_ANSWERS_CHIP));
    dropped = cur.picks.length - keep.length;
    return dropped ? { picks: keep } : null;
  });
  return dropped;
}

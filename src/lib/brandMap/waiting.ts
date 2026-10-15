import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { isBrandMapScaleEnabled } from "./flags";

/**
 * Proposals waiting on a map at any size (BRAND_MAP_SCALE_ENABLED): subjects, questions,
 * buying situations and groups research, an import or Vizzy proposed, for the Review row and
 * Vizzy's card. One cheap count each. 0 with the switch off.
 */
export async function proposalsWaiting(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<number> {
  if (!isBrandMapScaleEnabled()) return 0;
  const store = brandMapRecords(ctx, deps.db);
  const counts = await Promise.all((["sub", "q", "sit", "grp"] as const).map((kind) => store.count(kind, [["status", "==", "proposed"]]).catch(() => 0)));
  return counts.reduce((a, b) => a + b, 0);
}

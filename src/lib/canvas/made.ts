import { countMade } from "@/lib/loops/count";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Made } from "@/lib/types/loopStamp";
import type { CanvasKindName } from "./names";
import type { CanvasSaved } from "./types";

/**
 * The canvas route's made count (learning loops step 5, decision 20): `canvas.<kind>` made once
 * for a new draft (`saved: "created"`), and never for Vizzy's new words on a draft already counted
 * or for nothing new, so made never outruns the answers. Its own file, so the tests that count a
 * draft's answers count its made exactly as the route does. Never throws (countMade's rule).
 */
export async function countCanvasMade(
  ctx: TenantContext,
  kind: CanvasKindName,
  saved: CanvasSaved,
  made: Made,
  deps: { db?: FirestoreLike } = {},
): Promise<void> {
  if (saved !== "created") return;
  if (deps.db) await countMade(ctx, `canvas.${kind}`, made, { db: deps.db });
  else await countMade(ctx, `canvas.${kind}`, made);
}

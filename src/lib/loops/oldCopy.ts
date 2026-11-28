import { canonicalStyleId } from "@/lib/content/imageStyle/catalogue";
import { clearOldLooks } from "@/lib/tenant/control";
import type { TenantPageRow } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_SCOPE } from "./read";

/**
 * A forgotten look's old copy on the brand record (learning loops step 4, 3.5 and 3.7): the looks
 * kept there from before versions, in the United States, which Forget clears for its scope at once
 * and the loops lane tries again on each visit until they are gone. Only copies written at or
 * before the Forget go, so a look the old learner wrote later (with versions off) stays. Kept apart
 * from the person actions so the lane loads only this. Server only.
 */

/** The keys of the brand record's old looks a scope maps to: the brand look, or each style id kept under it. */
function oldKeysOf(row: TenantPageRow | null, scope: string): { brand: boolean; styleKeys: string[] } {
  if (scope === BRAND_SCOPE) return { brand: true, styleKeys: [] };
  const keys = Object.keys(row?.styleLooks ?? {}).filter((k) => {
    const id = canonicalStyleId(k);
    return id !== null && `image_style.${id}` === scope;
  });
  return { brand: false, styleKeys: keys };
}

/** Whether the brand record still holds a scope's old copy written at or before `writtenBy`. */
export function hasOldCopy(row: TenantPageRow | null, scope: string, writtenBy: string): boolean {
  const before = (at: string | null | undefined) => !at || at <= writtenBy;
  const keys = oldKeysOf(row, scope);
  if (keys.brand) return Boolean(row?.learnedImageStyle) && before(row?.learnedImageStyleUpdatedAt);
  return keys.styleKeys.some((k) => Boolean(row?.styleLooks[k]?.directive) && before(row?.styleLooks[k]?.updatedAt));
}

/**
 * Clear a scope's old copy on the brand record, written at or before `writtenBy`: Forget calls it
 * at once, and the lane on each visit until it is gone. Never throws; the count it cleared.
 */
export async function clearOldCopy(ctx: TenantContext, row: TenantPageRow | null, scope: string, writtenBy: string, deps: { controlDb?: FirestoreLike } = {}): Promise<number> {
  if (!hasOldCopy(row, scope, writtenBy)) return 0;
  const keys = oldKeysOf(row, scope);
  try {
    return await clearOldLooks(ctx.tenantId, { ...keys, writtenBy }, deps.controlDb);
  } catch (err) {
    console.warn("[loops] clearing a forgotten look's old copy failed; the lane tries again", err instanceof Error ? err.message.slice(0, 200) : "error");
    return 0;
  }
}

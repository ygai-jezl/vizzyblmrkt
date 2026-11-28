import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * An article's versions in other languages (PAGE_LANGUAGES_ENABLED), as records in `translations`
 * (kind "article"). This file holds what the content plan routes call.
 */

/** A deleted plan's article versions go with it, switch on or off. A failure is logged, never thrown. */
export async function forgetPlanTranslations(ctx: TenantContext, planId: string, db?: FirestoreLike): Promise<void> {
  try {
    await forTenant(ctx, db).translations.deleteWhere([["planId", "==", planId]]);
  } catch (err) {
    console.warn(`[translations] removing plan ${planId}'s versions failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { BrandMapPage, BrandMapPageFacts } from "@/lib/types/brandMapPage";
import { planPageId } from "@/lib/types/brandMapPage";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { buildPlanPage, pageFingerprint } from "./pageRow";
import { softly } from "./mapActions";

/**
 * Keeping the brand map's page rows in step with the articles (BRAND_MAP_PAGES_ENABLED).
 * Every write that changes a blog plan calls a hook here after its own write: at most two
 * seconds, and a failure never fails it. A row that falls behind is brought up to date by
 * the plan's next save, or by "Read what's already there". Off: nothing is read or written.
 */

export interface PageDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

export type PageSync = "written" | "unchanged" | "removed" | "off";

/**
 * Bring a plan's row up to date: written when its facts changed, removed when the plan is
 * gone or no longer a blog article. Reads the plan fresh unless handed one just read.
 */
export async function syncPlanPage(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string; plan?: ContentPlan | null },
  deps: PageDeps = {},
): Promise<PageSync> {
  if (!isBrandMapPagesEnabled()) return "off";
  const plan = args.plan !== undefined ? args.plan : await getContentPlan(ctx, args.workspaceId, args.planId, deps.db);
  const facts = plan ? buildPlanPage(plan) : null;
  if (!facts) return (await removePlanPage(ctx, args.planId, deps)) ? "removed" : "unchanged";
  return (await writePageRow(ctx, planPageId(args.planId), facts, deps)) ? "written" : "unchanged";
}

/** Write a row when its facts changed. True when it was written. */
export async function writePageRow(ctx: TenantContext, id: string, facts: BrandMapPageFacts, deps: PageDeps = {}): Promise<boolean> {
  const fingerprint = pageFingerprint(facts);
  const row: Omit<BrandMapPage, "id" | "tenantId"> = {
    ...facts,
    fingerprint,
    updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  // Each attempt of the transaction decides afresh; the last one is what was written.
  let wrote = false;
  await forTenant(ctx, deps.db).brandMapPages.upsert(
    id,
    () => {
      wrote = true;
      return row;
    },
    (current) => {
      wrote = current.fingerprint !== fingerprint;
      return wrote ? row : null;
    },
  );
  return wrote;
}

/** Remove an article's row (its plan was deleted). True when there was one. */
export async function removePlanPage(ctx: TenantContext, planId: string, deps: PageDeps = {}): Promise<boolean> {
  if (!isBrandMapPagesEnabled()) return false;
  const pages = forTenant(ctx, deps.db).brandMapPages;
  const id = planPageId(planId);
  if (!(await pages.getById(id))) return false;
  await pages.delete(id);
  return true;
}

/** Remove every article row of a programme (it was deleted). */
export async function removeWorkspacePages(ctx: TenantContext, workspaceId: string, deps: PageDeps = {}): Promise<number> {
  if (!isBrandMapPagesEnabled()) return 0;
  return forTenant(ctx, deps.db).brandMapPages.deleteWhere([["workspaceId", "==", workspaceId]]);
}

/** The hooks' form of syncPlanPage: after the caller's own write, bounded, never throwing. */
export function syncPlanPageSoftly(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string; plan?: ContentPlan | null },
  deps: PageDeps = {},
): Promise<PageSync | null> {
  if (!isBrandMapPagesEnabled()) return Promise.resolve(null);
  return softly("syncing an article's page", () => syncPlanPage(ctx, args, deps));
}

/** The hooks' form of removePlanPage. */
export function removePlanPageSoftly(ctx: TenantContext, planId: string, deps: PageDeps = {}): Promise<boolean | null> {
  if (!isBrandMapPagesEnabled()) return Promise.resolve(null);
  return softly("removing an article's page", () => removePlanPage(ctx, planId, deps));
}

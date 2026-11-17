import type { TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { contentPlanSources } from "./feeders";
import { isSearchIndexEnabled } from "./flags";
import { indexInBackground, removeInBackground } from "./indexer";

/**
 * Write a save through to the brand's search index straight away, after the response (the
 * scheduled check would get there within about 10 minutes anyway, and removes what a save
 * dropped). Off: nothing. Never slows or breaks the save.
 */

type Ctx = Pick<TenantContext, "tenantId" | "region">;

/** A content plan was saved: its article, newsletter or ebook, posts and email steps. */
export function indexPlanAfterSave(ctx: Ctx, plan: ContentPlan | null | undefined): void {
  if (!plan || !isSearchIndexEnabled()) return;
  for (const source of contentPlanSources(plan)) indexInBackground(ctx, source);
}

/** A content plan was deleted: take out everything it put in. */
export function removePlanAfterDelete(ctx: Ctx, plan: ContentPlan): void {
  if (!isSearchIndexEnabled()) return;
  for (const source of contentPlanSources(plan)) removeInBackground(ctx, source.kind, source.ref);
}

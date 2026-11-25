import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BlogArticleDates, BlogArticleLive, ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { getContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { autopilotHolds } from "@/lib/autopilot/planLock";
import { closeDraftRows } from "@/lib/autopilot/answers";
import { forgetReviewCount } from "@/lib/review/summary";
import { indexPlanAfterSave } from "@/lib/search/writeThrough";
import { keepApprovedSeen } from "./hubActions";
import { syncPlanPageSoftly } from "./pageActions";
import { recordApproval } from "@/lib/content/create/aiOriginals";

/**
 * Found live (BLOG_LIVE_WATCH_ENABLED): an article up on the brand's site was accepted by the
 * person who put it there, so being found live approves it, with everything a person's approval
 * does (src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/route.ts): the brand map
 * row, an autopilot draft's notes counted as used, brand search, and its rows in Review closed.
 */

/** May being found live approve this article? Only one written and waiting, never one autopilot is writing. */
export function mayApproveOnLive(plan: Pick<ContentPlan, "status" | "autopilot">, node: Pick<ContentNode, "type" | "status" | "body">): boolean {
  return plan.status !== "archived" && !autopilotHolds(plan) && node.type === "hub" && node.status === "generated" && Boolean(node.body.trim());
}

export interface LiveMarkDeps {
  db?: FirestoreLike;
}

/**
 * Write an article's live mark (`mark` makes it from the one stored) and, with `approve`, approve
 * the article in the same transaction when it may be (decided there, from the plan as stored).
 * With `dates` (BLOG_DATES_ENABLED), its Published and Updated are written with the mark.
 * Returns the hub as saved, or null when the plan or node is gone.
 */
export async function writeLiveMark(
  ctx: TenantContext,
  args: {
    workspaceId: string;
    plan: ContentPlan;
    nodeId: string;
    mark: (stored: BlogArticleLive | null) => BlogArticleLive | null;
    approve: boolean;
    dates?: (stored: BlogArticleDates | undefined, live: BlogArticleLive | null) => BlogArticleDates | undefined;
  },
  deps: LiveMarkDeps = {},
): Promise<{ node: ContentNode; approved: boolean } | null> {
  const { workspaceId, plan, nodeId } = args;
  let approved = false;
  const node = await updateContentPlanNode(ctx, workspaceId, plan.id, nodeId, {}, deps.db, {
    patchFor: (stored, storedNode) => {
      approved = args.approve && mayApproveOnLive(stored, storedNode);
      return approved ? { status: "approved" } : {};
    },
    setLive: (stored) => {
      const next = args.mark(stored);
      return next && approved ? { ...next, approvedOnLive: true } : next;
    },
    ...(args.dates ? { setDates: args.dates } : {}),
  });
  if (!node) return null;
  // Marked live is approved by whoever put it up: the AI original is kept beside the copy that went live.
  if (node.blog?.live) await recordApproval(ctx, { planId: plan.id, node, trigger: "live" }, { db: deps.db }).catch(() => null);
  if (!approved) {
    await syncPlanPageSoftly(ctx, { workspaceId, planId: plan.id }, { db: deps.db });
    return { node, approved };
  }
  const after = await getContentPlan(ctx, workspaceId, plan.id, deps.db).catch(() => null);
  await syncPlanPageSoftly(ctx, { workspaceId, planId: plan.id, ...(after ? { plan: after } : {}) }, { db: deps.db });
  if (after) {
    await keepApprovedSeen(ctx, { workspaceId, before: plan, after }, { db: deps.db });
    indexPlanAfterSave(ctx, after);
    await closeDraftRows(ctx, after, { db: deps.db });
  }
  forgetReviewCount(ctx.tenantId);
  return { node, approved };
}

import { createHash } from "node:crypto";
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
import { keepApprovedExample } from "@/lib/content/create/approvedExamples";

/**
 * Found live (BLOG_LIVE_WATCH_ENABLED): an article up on the brand's site was accepted by the
 * person who put it there, so being found live approves it, with everything a person's approval
 * does (src/app/api/admin/workspace/[workspaceId]/content-plans/[planId]/route.ts): the brand map
 * row, an autopilot draft's notes counted as used, brand search, and its rows in Review closed.
 */

/** A short hash of an article's words, kept on its live mark. */
export function articleBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/**
 * May being found live approve this article? Only one written and waiting, never one autopilot is
 * writing, and never words that changed since an earlier live mark (a refresh, an edit): a page
 * check can't tell a refreshed article from the one already up, so a person approves those. A
 * person pressing It's live (`person`) is that person.
 */
export function mayApproveOnLive(
  plan: Pick<ContentPlan, "status" | "autopilot">,
  node: Pick<ContentNode, "type" | "status" | "body"> & { blog?: { live?: Pick<BlogArticleLive, "bodyHash"> | null } | null },
  opts: { person?: boolean } = {},
): boolean {
  if (plan.status === "archived" || autopilotHolds(plan) || node.type !== "hub" || node.status !== "generated" || !node.body.trim()) return false;
  const earlier = node.blog?.live;
  return Boolean(opts.person) || !earlier || earlier.bodyHash === articleBodyHash(node.body);
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
    /** A person said it's live (It's live), so changed words may be approved too. */
    person?: boolean;
    dates?: (stored: BlogArticleDates | undefined, live: BlogArticleLive | null) => BlogArticleDates | undefined;
  },
  deps: LiveMarkDeps = {},
): Promise<{ node: ContentNode; approved: boolean } | null> {
  const { workspaceId, plan, nodeId } = args;
  let approved = false;
  const node = await updateContentPlanNode(ctx, workspaceId, plan.id, nodeId, {}, deps.db, {
    patchFor: (stored, storedNode) => {
      approved = args.approve && mayApproveOnLive(stored, storedNode, { person: args.person });
      return approved ? { status: "approved" } : {};
    },
    setLive: (stored, change) => {
      const next = args.mark(stored);
      if (!next) return next;
      // The hash says which words were last accepted as live. A check that couldn't approve changed
      // words keeps the earlier hash, so a later check can't approve them either: only a person can.
      const now = articleBodyHash(change.after.body);
      const accepted = approved || args.person || !stored || stored.bodyHash === now;
      const bodyHash = accepted ? now : stored?.bodyHash;
      const hashed = { ...next, ...(bodyHash ? { bodyHash } : {}) };
      if (!bodyHash) delete (hashed as { bodyHash?: string }).bodyHash;
      return approved ? { ...hashed, approvedOnLive: true } : hashed;
    },
    ...(args.dates ? { setDates: args.dates } : {}),
  });
  if (!node) return null;
  // Marked live is approved by whoever put it up: the AI original is kept beside the copy that went live.
  if (node.blog?.live) await recordApproval(ctx, { planId: plan.id, node, trigger: "live" }, { db: deps.db }).catch(() => null);
  // Approved by being found live: the article becomes an example the hub writer follows (CONTENT_APPROVED_EXAMPLES_ENABLED).
  if (approved) await keepApprovedExample(ctx, { workspaceId, planId: plan.id, node }, { db: deps.db }).catch(() => null);
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

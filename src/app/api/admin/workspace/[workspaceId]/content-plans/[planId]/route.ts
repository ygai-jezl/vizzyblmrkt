import { NextResponse } from "next/server";
import { forgetPlanTranslations } from "@/lib/i18n/articleTranslations";
import { keepApprovedSeen } from "@/lib/content/blog/hubActions";
import { recordApprovals } from "@/lib/content/create/aiOriginals";
import { forgetPlanExamples, forgetRemovedExamples, keepApprovedExamples } from "@/lib/content/create/approvedExamples";
import { AUTOPILOT_RUNNING, autopilotHolds } from "@/lib/autopilot/planLock";
import { closeDraftRows, draftDoneWith } from "@/lib/autopilot/answers";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  getContentPlan,
  updateContentPlan,
  deleteContentPlan,
} from "@/lib/tenant/workspaceContent";
import { BlogBriefSchema, ContentGraphSchema, ContentPlanStatus } from "@/lib/types/contentPlan";
import { keptBasedOn } from "@/lib/brandStrategy/basedOn";
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { articleAddressProblem } from "@/lib/content/blog/address";
import { removePlanPageSoftly, syncPlanPageSoftly } from "@/lib/content/blog/pageActions";
import { syncSeenHolds } from "@/lib/content/blog/seen";
import { indexPlanAfterSave, removePlanAfterDelete } from "@/lib/search/writeThrough";
import { wakeLiveWatch } from "@/lib/content/blog/liveWatchWake";
import { closePlanDraft } from "@/lib/agentRecord/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const SaveSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: ContentPlanStatus.optional(),
    graph: ContentGraphSchema.optional(),
    /** A blog plan's brief (buyer questions, allowed links and sources), edited on the canvas. */
    blog: BlogBriefSchema.optional(),
    /** A blog article's address, set after the plan was made (BRAND_MAP_PAGES_ENABLED; ignored while off). null = clear it. */
    hubUrl: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.status !== undefined || b.graph !== undefined || b.blog !== undefined || b.hubUrl !== undefined,
    { message: "nothing to update" },
  );

/** Load one plan (with its graph) for the canvas. */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ plan });
}

/** Save the plan's name / status / graph / blog brief (canvas Save; positions persist here). */
export async function PUT(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // The article autopilot is writing it: nothing saves over the run until it ends or a person takes over.
  if (autopilotHolds(plan)) return NextResponse.json(AUTOPILOT_RUNNING, { status: 409 });

  const parsed = SaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  // The address is only taken with its switch on; off, a save is exactly as before.
  const { hubUrl, ...rest } = parsed.data;
  const address = hubUrl !== undefined && isBrandMapPagesEnabled() ? (hubUrl?.trim() || null) : undefined;
  if (address === undefined && Object.values(rest).every((v) => v === undefined)) {
    return NextResponse.json({ error: "invalid_input", issues: [""] }, { status: 400 });
  }
  if (address !== undefined) {
    if (plan.topology.hubChannel !== "blog") return NextResponse.json({ error: "not_a_blog_plan" }, { status: 409 });
    const problem = address ? articleAddressProblem(address) : null;
    if (problem) return NextResponse.json({ error: "invalid_address", reason: problem }, { status: 400 });
  }
  // What the brief came from (STRATEGY_RESULTS_ENABLED) is the server's: the stored one stays, whatever a save sends.
  if (rest.blog) rest.blog = keptBasedOn(rest.blog, plan.blog);
  await updateContentPlan(ctx, workspaceId, planId, { ...rest, ...(address !== undefined ? { hubUrl: address } : {}) });
  const updated = await getContentPlan(ctx, workspaceId, planId);
  await syncPlanPageSoftly(ctx, { workspaceId, planId, plan: updated });
  // A new address is checked at Found live's next look.
  if (address && address !== (plan.strategy.hubUrl ?? null)) await wakeLiveWatch(ctx);
  // Notes a person added to or took out of the article are held for it, or let go.
  if (rest.blog !== undefined) {
    await syncSeenHolds(ctx, { article: { ref: `${workspaceId}/${planId}`, title: updated?.name ?? plan.name }, before: plan.blog, after: updated?.blog });
  }
  // An autopilot draft's notes count as used once a person approves it.
  await keepApprovedSeen(ctx, { workspaceId, before: plan, after: updated });
  // Each piece approved in this save keeps its AI original beside the approved copy (CONTENT_AI_ORIGINALS_ENABLED).
  await recordApprovals(ctx, { before: plan, after: updated });
  // Each workflow email and hub piece approved in this save becomes an example its writer follows (CONTENT_APPROVED_EXAMPLES_ENABLED).
  await keepApprovedExamples(ctx, { workspaceId, before: plan, after: updated });
  // A piece this save took off the canvas takes its example with it, even one kept before the switch went off.
  await forgetRemovedExamples(ctx, { workspaceId, before: plan, after: updated });
  // Approved or archived: an autopilot draft's question rows in Review close.
  if (updated?.autopilot && !draftDoneWith(plan) && draftDoneWith(updated)) await closeDraftRows(ctx, updated);
  // A plan an agent drafted: kept when this save approves a piece, dismissed when it archives the plan (agent record).
  if (updated) await closePlanDraft(ctx, workspaceId, plan, updated);
  indexPlanAfterSave(ctx, updated);
  return NextResponse.json({ plan: updated });
}

/** Delete a plan. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteContentPlan(ctx, workspaceId, planId);
  // Its article in other languages goes with it (PAGE_LANGUAGES_ENABLED), even ones made before the switch went off.
  await forgetPlanTranslations(ctx, planId);
  // Its pieces kept as examples go with it, even ones kept before the switch went off.
  await forgetPlanExamples(ctx, { workspaceId, plan });
  await closeDraftRows(ctx, plan);
  // A plan an agent drafted, deleted: dismissed by that person (agent record).
  await closePlanDraft(ctx, workspaceId, plan, null);
  await removePlanPageSoftly(ctx, planId);
  await syncSeenHolds(ctx, { article: { ref: `${workspaceId}/${planId}`, title: plan.name }, before: plan.blog, after: null });
  removePlanAfterDelete(ctx, plan);
  return NextResponse.json({ ok: true });
}

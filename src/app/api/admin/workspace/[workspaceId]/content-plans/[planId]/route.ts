import { NextResponse } from "next/server";
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
import { isBrandMapPagesEnabled } from "@/lib/brandMap/flags";
import { articleAddressProblem } from "@/lib/content/blog/address";
import { removePlanPageSoftly, syncPlanPageSoftly } from "@/lib/content/blog/pageActions";

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
  await updateContentPlan(ctx, workspaceId, planId, { ...rest, ...(address !== undefined ? { hubUrl: address } : {}) });
  const updated = await getContentPlan(ctx, workspaceId, planId);
  await syncPlanPageSoftly(ctx, { workspaceId, planId, plan: updated });
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
  await removePlanPageSoftly(ctx, planId);
  return NextResponse.json({ ok: true });
}

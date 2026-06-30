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
import { ContentGraphSchema, ContentPlanStatus } from "@/lib/types/contentPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

const SaveSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: ContentPlanStatus.optional(),
    graph: ContentGraphSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.status !== undefined || b.graph !== undefined, {
    message: "nothing to update",
  });

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

/** Save the plan's name / status / graph (canvas Save; positions persist here). */
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
  await updateContentPlan(ctx, workspaceId, planId, parsed.data);
  const updated = await getContentPlan(ctx, workspaceId, planId);
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
  return NextResponse.json({ ok: true });
}

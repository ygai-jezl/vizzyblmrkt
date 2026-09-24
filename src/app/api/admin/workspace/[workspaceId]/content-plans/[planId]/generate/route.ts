import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { runArchitect } from "@/lib/content/create/architectRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/**
 * Architect — build the plan's hub-and-spoke graph skeleton (one Gemini call,
 * grounded). Persists the graph (nodes status:"empty") and flips the plan to
 * "generating"; the client then fills each node via the per-node route.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const built = await runArchitect(ctx, { workspace: ws, plan });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status });
  const graph = built.graph;

  await updateContentPlan(ctx, workspaceId, planId, { graph, status: "generating" });
  const updated = await getContentPlan(ctx, workspaceId, planId);
  return NextResponse.json({ plan: updated });
}

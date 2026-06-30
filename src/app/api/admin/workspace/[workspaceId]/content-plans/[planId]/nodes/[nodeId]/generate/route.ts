import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  getContentPlan,
  getTemplate,
  updateContentPlan,
  updateContentPlanNode,
} from "@/lib/tenant/workspaceContent";
import { generateNode } from "@/lib/content/create/generateNode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/**
 * Fill ONE node (progressive generation). Bounded: exactly one node per request,
 * no loop — the client drives the sequence over empty nodes. When the last empty
 * node is filled, the plan flips to "ready".
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;

  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const node = plan.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  // If the operator chose a template for this node, fill ITS skeleton (else compose).
  // Only honor a template native to this node's channel — a stale/mismatched pick (e.g.
  // a LinkedIn template left on a node after switching it to X) falls back to composing.
  let skeletonBody: string | null = null;
  if (node.templateId) {
    const tpl = await getTemplate(ctx, workspaceId, node.templateId);
    skeletonBody = tpl && tpl.channel === node.channel ? tpl.body : null;
  }

  const patch = await generateNode({
    ctx,
    workspaceId,
    plan,
    node,
    brandVoice: ws.brandVoice ?? null,
    audience: ws.audience ?? null,
    skeletonBody,
  });

  const updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, {
    body: patch.body,
    placeholderValues: patch.placeholderValues,
    status: patch.status,
    warnings: patch.warnings,
    format: patch.format,
  });
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  // Flip to "ready" once nothing is left empty/generating. Read FRESH state after the
  // node transaction committed (not the pre-update snapshot) so concurrent per-node
  // generates can't all act on a stale count and leave the plan stuck in "generating".
  const fresh = await getContentPlan(ctx, workspaceId, planId);
  if (fresh && (fresh.status === "generating" || fresh.status === "draft")) {
    const remaining = fresh.graph.nodes.filter(
      (n) => n.status === "empty" || n.status === "generating",
    );
    if (remaining.length === 0) {
      await updateContentPlan(ctx, workspaceId, planId, { status: "ready" });
    }
  }

  return NextResponse.json({ node: updated });
}

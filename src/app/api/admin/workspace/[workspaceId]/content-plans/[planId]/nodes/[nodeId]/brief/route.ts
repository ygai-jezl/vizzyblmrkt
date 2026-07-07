import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import { generateNodeBrief } from "@/lib/content/create/nodeBrief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/** Node types that carry an atomizing brief (hub is the root; structural/email are out of scope). */
const BRIEFABLE = new Set(["spoke", "promo_pre", "promo_post"]);

/**
 * Auto-write ONE node's generation brief from the nodes it's connected to (its
 * upstream context up to the hub). Fired when the canvas connects a fresh node, and
 * from the inspector's "Suggest brief" button. Reads the PERSISTED plan (the client
 * saves the new edge first) so the ancestor walk sees the current graph. Only the
 * `brief` field is written — the node's body/status lifecycle is untouched.
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
  if (!BRIEFABLE.has(node.type)) {
    return NextResponse.json({ error: "not_briefable" }, { status: 400 });
  }

  const { brief } = await generateNodeBrief({
    ctx,
    workspaceId,
    plan,
    node,
    brandVoice: ws.brandVoice ?? null,
    audience: ws.audience ?? null,
  });

  // The persist re-validates the merged node via ContentNodeSchema.parse (throwing).
  // Guard it so a schema-invalid patch returns 422, not an uncaught 500.
  let updated;
  try {
    updated = await updateContentPlanNode(ctx, workspaceId, planId, nodeId, { brief });
  } catch {
    return NextResponse.json({ error: "invalid_node" }, { status: 422 });
  }
  if (!updated) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  return NextResponse.json({ node: updated });
}

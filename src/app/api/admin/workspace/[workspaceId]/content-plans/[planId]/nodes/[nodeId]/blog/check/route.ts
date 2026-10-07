import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { checkPlanBlogFacts } from "@/lib/content/blog/hubActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/**
 * Fact-check a blog hub's copy against the brand's own material and its checked sources.
 * Statements the material does not support are rewritten (or taken out) sentence by
 * sentence, and every change is recorded on the node for the operator to see. Reads the
 * PERSISTED node (the canvas saves first), so it also re-checks copy a person has edited.
 * Never touches an approved or scheduled piece. FLAG-GATED (503 until
 * CREATE_BLOG_CITABLE_ENABLED).
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

  const r = await checkPlanBlogFacts(ctx, { workspace: ws, plan, nodeId });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ node: r.node, corrected: r.corrected });
}

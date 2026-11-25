import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isAiOriginalsEnabled } from "@/lib/content/create/flags";
import { readOriginal } from "@/lib/content/create/aiOriginals";
import { aiOriginalView } from "@/lib/content/create/aiOriginalView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ workspaceId: string; planId: string; nodeId: string }>;
};

/**
 * A piece's AI original (CONTENT_AI_ORIGINALS_ENABLED): who made it and when, its last approval,
 * and how the copy as it is now differs from it, section by section. Read only; members and
 * admins alike, as for reading the piece. `original: null` when none was kept (written before
 * the switch was on, or by a person).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  if (!isAiOriginalsEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId, nodeId } = await params;
  if (!(await forTenant(ctx).workspaces.getById(workspaceId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  const node = plan?.graph.nodes.find((n) => n.id === nodeId);
  if (!plan || !node) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const doc = await readOriginal(ctx, plan.id, node.id);
  const original = doc && doc.workspaceId === workspaceId ? aiOriginalView(doc, node, new Date().toISOString()) : null;
  return NextResponse.json({ original }, { headers: { "cache-control": "no-store" } });
}

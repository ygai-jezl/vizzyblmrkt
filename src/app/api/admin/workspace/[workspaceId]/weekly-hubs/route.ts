import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { listReadyHubs } from "@/lib/distribute/weeklyHubs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weekly-newsletter tab data: every ready newsletter hub across the workspace's
 * plans, plus the tenant's launches (the operator picks which launch's weekly
 * audience receives the send — hubs are workspace-scoped, subscribers are
 * launch-scoped, and there is no workspace↔launch link).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [plans, allCampaigns] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]] }),
  ]);

  const hubs = listReadyHubs(plans);
  const campaigns = allCampaigns
    .filter((c) => !c.archivedAt)
    .map((c) => ({ id: c.id, name: c.waitlistName || c.id }));

  return NextResponse.json({ hubs, campaigns });
}

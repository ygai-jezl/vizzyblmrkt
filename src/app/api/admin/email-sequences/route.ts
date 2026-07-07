import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List the tenant's Content-OS email sequences (`email_sequence` ContentPlans),
 * across all its workspaces — the picker data for a Journey "Add exit" handoff.
 *
 * ContentPlans live in a per-workspace subcollection (not a TenantCollection),
 * so there is no single collection-group query: we fan out (1 workspace query +
 * 1 read per workspace). Fine for a handful of workspaces; revisit with a
 * denormalized index if workspace counts grow.
 *
 * Returns `hasWorkspace` / `firstWorkspaceId` so the caller can render the
 * empty states: no workspace at all → "create a workspace first"; a workspace
 * but no sequences → deep-link to that workspace's Create tab.
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const workspaces = (
    await forTenant(ctx).workspaces.find({ where: [], limit: 200 })
  )
    .filter((w) => !w.archivedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const sequences: Array<{
    planId: string;
    workspaceId: string;
    workspaceName: string;
    name: string;
    sequenceType: string | null;
    status: string;
  }> = [];
  for (const ws of workspaces) {
    for (const p of await listContentPlans(ctx, ws.id)) {
      if (p.strategy.objective !== "email_sequence") continue;
      if (p.status === "archived") continue; // archived plans aren't valid handoff targets
      sequences.push({
        planId: p.id,
        workspaceId: ws.id,
        workspaceName: ws.name,
        name: p.name,
        sequenceType: p.strategy.sequenceType ?? null,
        status: p.status,
      });
    }
  }

  return NextResponse.json({
    hasWorkspace: workspaces.length > 0,
    firstWorkspaceId: workspaces[0]?.id ?? null,
    sequences,
  });
}

import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import {
  verifyWorkspace,
  getIdeaItem,
  deleteIdeaItem,
} from "@/lib/tenant/workspaceContent";
import { deleteWorkspaceAsset } from "@/lib/workspace/assetStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete an idea (and its screenshot, best-effort). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string; ideaId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, ideaId } = await params;
  if (!(await verifyWorkspace(ctx, workspaceId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const idea = await getIdeaItem(ctx, workspaceId, ideaId);
  if (!idea) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (idea.screenshotPath) {
    await deleteWorkspaceAsset(ctx.tenantId, workspaceId, idea.screenshotPath);
  }
  await deleteIdeaItem(ctx, workspaceId, ideaId);
  return NextResponse.json({ ok: true });
}

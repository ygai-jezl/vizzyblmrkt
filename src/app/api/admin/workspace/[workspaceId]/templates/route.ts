import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { listTemplates } from "@/lib/tenant/workspaceContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a workspace's templates + its known structural groups (combobox options). */
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
  const templates = await listTemplates(ctx, workspaceId);
  return NextResponse.json({ templates, groups: ws.templateGroups ?? [] });
}

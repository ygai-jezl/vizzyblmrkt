import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { getEmailTemplate, deleteEmailTemplate } from "@/lib/tenant/workspaceContent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; templateId: string }> };

/** Fetch a single saved email template (for "Load template"). */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, templateId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const template = await getEmailTemplate(ctx, workspaceId, templateId);
  if (!template) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ template });
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, templateId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteEmailTemplate(ctx, workspaceId, templateId);
  return NextResponse.json({ ok: true });
}

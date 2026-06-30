import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { deleteWorkspace } from "@/lib/admin/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  const workspace = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workspace });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { workspaceId } = await params;
  const existing = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = UpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
  if (parsed.data.description !== undefined) {
    patch.description = parsed.data.description?.trim() || null;
  }
  if (parsed.data.archived !== undefined) {
    patch.archivedAt = parsed.data.archived ? new Date().toISOString() : null;
  }
  await forTenant(ctx).workspaces.update(workspaceId, patch);
  const workspace = await forTenant(ctx).workspaces.getById(workspaceId);
  return NextResponse.json({ workspace });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  const ok = await deleteWorkspace(ctx, workspaceId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

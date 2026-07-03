import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove one engaged social profile from the CRM Engaged tab (tenant-scoped). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  // forTenant.socialEngaged.delete re-verifies tenant ownership before deleting.
  await forTenant(ctx).socialEngaged.delete(id).catch(() => {});
  return NextResponse.json({ ok: true });
}

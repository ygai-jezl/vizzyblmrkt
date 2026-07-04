import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { deleteTenantSocialConnection } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect the tenant's X account (removes the encrypted tokens). */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteTenantSocialConnection(ctx.tenantId, "x");
  return NextResponse.json({ ok: true });
}

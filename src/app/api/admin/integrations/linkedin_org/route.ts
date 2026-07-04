import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { deleteTenantSocialConnection } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Disconnect the tenant's LinkedIn Pages connection (removes the CM tokens + pages). */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await deleteTenantSocialConnection(ctx.tenantId, "linkedin_org");
  return NextResponse.json({ ok: true });
}

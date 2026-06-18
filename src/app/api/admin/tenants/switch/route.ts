import { NextResponse } from "next/server";
import {
  getHomeAdminContext,
  setActiveTenantCookie,
  clearActiveTenantCookie,
} from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantMembership, getTenantById } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Switch the active brand. Authorization is relative to the HOME context (the
 * claims tenant), NOT the currently-active one — otherwise a user already
 * switched into brand B could never switch back to their home brand A (which has
 * no membership row). Selecting the home brand clears the override cookie; any
 * other target is RE-AUTHORIZED against `tenant_users` membership (403 if the
 * user doesn't belong to it). The client calls router.refresh() after a 200 so
 * every server component re-renders scoped to the new tenant.
 *
 * Body: `{ tenantId: string }`.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const home = await getHomeAdminContext();
  if (!home?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { tenantId?: unknown } | null;
  const tenantId = typeof body?.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  // Back to the home brand → drop the override (claims already authorize it).
  if (tenantId === home.tenantId) {
    await clearActiveTenantCookie();
    return NextResponse.json({ ok: true });
  }

  // Any other brand must be authorized by a membership row + be switchable.
  const membership = await getTenantMembership(home.userId, tenantId);
  if (!membership) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const tenant = await getTenantById(tenantId);
  if (!tenant || tenant.status === "suspended") {
    return NextResponse.json({ error: "tenant_unavailable" }, { status: 409 });
  }

  await setActiveTenantCookie(tenantId);
  return NextResponse.json({ ok: true });
}

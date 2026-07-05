import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { BrandKitSchema } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the tenant's brand kit. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tenant = await getTenantById(ctx.tenantId);
  return NextResponse.json({ brandKit: tenant?.brandKit ?? null });
}

/** Save the operator-edited brand kit. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = BrandKitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  await updateTenantConfig(ctx.tenantId, { brandKit: parsed.data });
  return NextResponse.json({ brandKit: parsed.data });
}

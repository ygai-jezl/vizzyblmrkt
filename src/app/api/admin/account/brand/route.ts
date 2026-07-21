import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig, withPreservedLearnedStyle } from "@/lib/tenant/control";
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
  // A manual save REPLACES the whole brandKit — preserve the feedback-loop learned style
  // server-side (don't trust the client to round-trip it; a stale tab would revert it).
  const existing = await getTenantById(ctx.tenantId);
  const merged = withPreservedLearnedStyle(parsed.data, existing?.brandKit);
  await updateTenantConfig(ctx.tenantId, { brandKit: merged });
  return NextResponse.json({ brandKit: merged });
}

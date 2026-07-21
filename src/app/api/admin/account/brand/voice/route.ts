import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { getTenantById } from "@/lib/tenant";
import { setTenantBrandVoice } from "@/lib/tenant/control";
import { BrandVoiceSchema } from "@/lib/types/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read the tenant's authored, global brand voice. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandVoiceEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tenant = await getTenantById(ctx.tenantId);
  return NextResponse.json({ brandVoice: tenant?.brandVoice ?? null });
}

/** Save the operator-edited brand voice (top-level tenant field; never touches brandKit). */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandVoiceEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = BrandVoiceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  await setTenantBrandVoice(ctx.tenantId, parsed.data);
  return NextResponse.json({ brandVoice: parsed.data });
}

/** Clear the brand voice (the "Delete" affordance). */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandVoiceEnabled()) return NextResponse.json({ error: "not_enabled" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await setTenantBrandVoice(ctx.tenantId, null);
  return NextResponse.json({ ok: true });
}

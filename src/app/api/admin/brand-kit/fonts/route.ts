import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { BrandTypographySchema } from "@/lib/types/tenant";
import { isBrandFontsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read/write the tenant's authored TYPOGRAPHY (Brand Kit → Fonts text styles + guidelines). This
 * writes the TOP-LEVEL `tenant.brandTypography` field (not `brandKit`), so it can never clobber the
 * extracted brand kit / palette / voice. Flag-gated (BRAND_FONTS_ENABLED), same-origin only.
 */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandFontsEnabled()) {
    return NextResponse.json({ error: "brand_fonts_disabled" }, { status: 503 });
  }
  const tenant = await getTenantById(ctx.tenantId);
  return NextResponse.json({ typography: tenant?.brandTypography ?? null });
}

export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandFontsEnabled()) {
    return NextResponse.json({ error: "brand_fonts_disabled" }, { status: 503 });
  }
  const parsed = BrandTypographySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const typography = { ...parsed.data, updatedAt: new Date().toISOString() };
  await updateTenantConfig(ctx.tenantId, { brandTypography: typography });
  return NextResponse.json({ typography });
}

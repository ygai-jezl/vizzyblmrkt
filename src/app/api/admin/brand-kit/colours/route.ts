import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getTenantById } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import { PaletteColorSchema, PaletteGroupSchema } from "@/lib/types/tenant";
import { isBrandColorsEnabled } from "@/lib/content/brandKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only the palette zones — the dedicated Colours page saves just these, preserving the rest. */
const ColoursPayloadSchema = z.object({
  palette: z.array(PaletteColorSchema).max(24).nullable().optional(),
  palettes: z.array(PaletteGroupSchema).max(20).nullable().optional(),
});

/**
 * Save ONLY the palette zones of the brand kit from the dedicated Brand Kit → Colours page. A
 * read-modify-write that patches `brandKit.palette` + `brandKit.palettes` and preserves every other
 * brandKit field (summary/tone/fonts/learned style/etc.) — so this page can never clobber data owned
 * by Account → Brand. Extraction actions (PDF/website/AI/logo) reuse the existing
 * /api/admin/account/brand/colors/* routes; this only persists the reviewed result. Flag-gated.
 */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isBrandColorsEnabled()) {
    return NextResponse.json({ error: "brand_colours_disabled" }, { status: 503 });
  }
  const parsed = ColoursPayloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const existing = await getTenantById(ctx.tenantId);
  const existingKit = existing?.brandKit ?? {};
  // Only overwrite a zone the client actually SENT (undefined = omitted = leave unchanged); an
  // explicit null/[] clears it. Prevents a partial payload from silently wiping the other zone.
  const merged = {
    ...existingKit,
    palette:
      parsed.data.palette !== undefined ? (parsed.data.palette ?? []) : (existingKit.palette ?? []),
    palettes:
      parsed.data.palettes !== undefined
        ? (parsed.data.palettes ?? [])
        : (existingKit.palettes ?? []),
  };
  await updateTenantConfig(ctx.tenantId, { brandKit: merged });
  return NextResponse.json({ palette: merged.palette, palettes: merged.palettes });
}

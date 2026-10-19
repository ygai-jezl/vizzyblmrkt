import { NextResponse } from "next/server";
import { z } from "zod";
import { clearTenantImageStyle, setTenantImageStyle } from "@/lib/tenant/control";
import { getTenantById } from "@/lib/tenant";
import { ImageStyleInputSchema } from "@/lib/types/imageStyle";
import { imageStyleAdmin, imageStyleMember } from "@/lib/content/imageStyle/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save's body: the style, plus the suggestion it applies (its `suggestedAt`) when saved from a Review. */
const SaveSchema = ImageStyleInputSchema.extend({ fromSuggestion: z.string().min(1).max(40).optional() });

/** The brand's image style and any pending Vizzy suggestion (Brand › Image style). Any member. */
export async function GET() {
  const g = await imageStyleMember();
  if (!g.ok) return g.response;
  const tenant = await getTenantById(g.ctx.tenantId);
  return NextResponse.json({
    imageStyle: tenant?.imageStyle ?? null,
    suggestion: tenant?.imageStyleSuggestion ?? null,
  });
}

/**
 * Save the image style. Admin-only. Writes only `tenant.imageStyle` (keeping what was learned
 * per style and the fonts found on the website), and, with `fromSuggestion`, clears the
 * suggestion it applies if it's still the pending one.
 */
export async function PUT(req: Request) {
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  const parsed = SaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }
  const { fromSuggestion, ...style } = parsed.data;
  const imageStyle = await setTenantImageStyle(g.ctx.tenantId, style, undefined, {
    updatedBy: g.ctx.userId,
    ...(fromSuggestion ? { clearSuggestionAt: fromSuggestion } : {}),
  });
  return NextResponse.json({ imageStyle });
}

/** "Reset": remove the image style, so images go back to today's presets. A pending suggestion stays. */
export async function DELETE(req: Request) {
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  await clearTenantImageStyle(g.ctx.tenantId);
  return NextResponse.json({ ok: true });
}

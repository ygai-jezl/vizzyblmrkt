import { NextResponse } from "next/server";
import { z } from "zod";
import { clearTenantImageStyle, setTenantImageStyle } from "@/lib/tenant/control";
import { getTenantById } from "@/lib/tenant";
import { ImageStyleInputSchema } from "@/lib/types/imageStyle";
import { imageStyleAdmin, imageStyleMember } from "@/lib/content/imageStyle/admin";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { seedBrand } from "@/lib/loops/seed";
import { closeStyle, memberOf } from "@/lib/agentRecord/record";
import { imageStylePrint } from "@/lib/agentRecord/fingerprints";
import { forgetReviewCount } from "@/lib/review/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save's body: the style, plus the suggestion it applies (its `suggestedAt`) when saved from a Review. */
const SaveSchema = ImageStyleInputSchema.extend({ fromSuggestion: z.string().min(1).max(40).optional() });

/**
 * The brand's image style and any pending Vizzy suggestion (Brand › Image style). Any member. With
 * image style versions on it also says `versions: true`, so the screens that read it know.
 */
export async function GET() {
  const g = await imageStyleMember();
  if (!g.ok) return g.response;
  const tenant = await getTenantById(g.ctx.tenantId);
  return NextResponse.json({
    imageStyle: tenant?.imageStyle ?? null,
    suggestion: tenant?.imageStyleSuggestion ?? null,
    // With versions on, the post image panel and the image details show the votes' new rows.
    ...(isImageStyleVersionsOn() ? { versions: true } : {}),
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
  // Saved from Vizzy's suggestion: applied by this admin, edited if it changed first (agent record).
  if (fromSuggestion) {
    await closeStyle(g.ctx, "image_style.suggest", fromSuggestion, { to: "acted", by: memberOf(g.ctx), fingerprint: imageStylePrint(imageStyle) });
    forgetReviewCount(g.ctx.tenantId);
  }
  return NextResponse.json({ imageStyle });
}

/** Reset with image style versions on, when the looks from before versions couldn't be kept first. */
const RESET_SEED_FAILED_MESSAGE = "Couldn't keep what YouGrow learned before resetting, so nothing changed. Try again.";

/**
 * "Reset": remove the image style, so images go back to today's presets. A pending suggestion stays.
 *
 * With image style versions on (learning loops step 4, decision 17) it also clears the old copy of
 * the looks on the brand record in the United States: the style looks go with the style, and the
 * brand look is cleared too. A brand not seeded yet is seeded first, so those looks are kept as
 * versions in its own region; what YouGrow learned stays, and Forget is how a look is dropped. If
 * the seed can't be written, nothing is reset.
 */
export async function DELETE(req: Request) {
  const g = await imageStyleAdmin(req);
  if (!g.ok) return g.response;
  if (isImageStyleVersionsOn()) {
    const seeded = await seedBrand(g.ctx, await getTenantById(g.ctx.tenantId));
    if (!seeded.ok) return NextResponse.json({ error: "seed_failed", message: RESET_SEED_FAILED_MESSAGE }, { status: 503 });
    await clearTenantImageStyle(g.ctx.tenantId, undefined, { learnedBrandLook: true });
    return NextResponse.json({ ok: true });
  }
  await clearTenantImageStyle(g.ctx.tenantId);
  return NextResponse.json({ ok: true });
}

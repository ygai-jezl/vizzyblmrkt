import { NextResponse } from "next/server";
import { z } from "zod";
import { getLogo } from "@/lib/admin/brandLogos";
import { getBrandAsset } from "@/lib/admin/brandAssets";
import { clearTenantEmailStyleHeaderImage, setTenantEmailStyle } from "@/lib/tenant/control";
import type { TenantContext } from "@/lib/tenant/types";
import {
  EMAIL_HEADER_IMAGE_LIMITS,
  EMAIL_STYLE_LIMITS,
  EmailStyleInputSchema,
  type StoredEmailStyle,
} from "@/lib/types/tenant";
import { cleanCompanyName, isEmailHeaderImage, isEmailLogo } from "@/lib/email/emailStyle";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";
import { isEmailHeaderOptionsEnabled, isEmailThemesEnabled } from "@/lib/email/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save's body: the style, plus the suggestion it applies (its `suggestedAt`) when saved from a Review. */
const SaveSchema = EmailStyleInputSchema.extend({ fromSuggestion: z.string().min(1).max(40).optional() });

/** Whole pixels within 1..max: a fractional or oversize measurement is rounded and clamped, not refused. */
function clampPx(n: unknown, max: number): unknown {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : n;
}

/**
 * Tidy what the page sent (logo and header image sizes, company name) before the strict parse
 * sees it. With the header options or themes off, their keys are dropped, so the setter keeps
 * whatever is stored.
 */
function normalise(body: unknown, on: { headerOptions: boolean; themes: boolean }): unknown {
  if (!body || typeof body !== "object") return body;
  const { logo, companyName, headerImage } = body as { logo?: unknown; companyName?: unknown; headerImage?: unknown };
  const size = logo && typeof logo === "object" ? (logo as { width?: unknown; height?: unknown }) : null;
  const tidy: Record<string, unknown> = {
    ...body,
    logo: size
      ? {
          ...size,
          width: clampPx(size.width, EMAIL_STYLE_LIMITS.logoWidth),
          height: clampPx(size.height, EMAIL_STYLE_LIMITS.logoHeight),
        }
      : logo,
    companyName: typeof companyName === "string" ? cleanCompanyName(companyName) : companyName,
  };
  // Clamped only so the parse passes: the stored size is the row's (see PUT).
  if (headerImage && typeof headerImage === "object") {
    const image = headerImage as { width?: unknown; height?: unknown };
    tidy.headerImage = {
      ...image,
      width: clampPx(image.width, EMAIL_HEADER_IMAGE_LIMITS.width),
      height: clampPx(image.height, EMAIL_HEADER_IMAGE_LIMITS.height),
    };
  }
  if (!on.headerOptions) {
    delete tidy.headerGradientColor;
    delete tidy.headerText;
    delete tidy.headerImage;
  }
  if (!on.themes) delete tidy.theme;
  return tidy;
}

/** What was saved, minus the header options while they're off, so the response is as without them. */
function withoutHeaderOptions(style: StoredEmailStyle | null) {
  if (!style) return style;
  const { headerGradientColor: _gradient, headerText: _text, headerImage: _image, ...rest } = style;
  return rest;
}

/** What was saved, minus the theme while themes are off, so the response is as without it. */
function withoutTheme<T extends { theme?: unknown }>(style: T | null) {
  if (!style) return style;
  const { theme: _theme, ...rest } = style;
  return rest;
}

/**
 * The header image was checked before the write, but a Delete may have removed it in between,
 * after its own clear found nothing to clear. So look again: if the row is gone, take the image
 * back out of the saved style (only if it's still this one), and answer with the style as
 * stored. With the Delete's second clear, a style never keeps pointing at a deleted banner.
 * The Save has already gone through, so a look that fails is logged and the style answered as
 * saved, never a failed Save: only a Delete finishing in that same moment could leave the
 * banner missing, and then the band still shows the header colour and the name as alt text.
 */
async function withoutDeletedHeaderImage(
  ctx: TenantContext,
  image: { id: string; filename: string },
  saved: StoredEmailStyle,
): Promise<StoredEmailStyle> {
  try {
    if ((await getBrandAsset(ctx, image.id))?.filename === image.filename) return saved;
    await clearTenantEmailStyleHeaderImage(ctx.tenantId, image.filename);
  } catch (err) {
    console.warn("[brandKit] email style header image re-check failed:", err);
    return saved;
  }
  const { headerImage: _deleted, ...rest } = saved;
  return rest;
}

/**
 * Save the Email style (Brand › Email style). Admin-only; members can view the page. The
 * logo must be one of this tenant's PNG/JPEG logos, by id and filename. Writes only
 * `tenant.emailStyle`, and, with `fromSuggestion`, clears the suggestion it applies (if it's
 * still the pending one). The header options (gradient, text colour, header image) are taken
 * only while EMAIL_HEADER_OPTIONS_ENABLED is on; off, they're ignored and the saved ones are
 * kept. A header image must be one of this tenant's header images, by id and filename, and
 * is stored with the size read from its file at upload, whatever the body says; it's checked
 * again after the write, in case it was deleted meanwhile. The theme is taken only while
 * EMAIL_THEMES_ENABLED is on, in the same way.
 */
export async function PUT(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  const { ctx } = g;
  const headerOptions = isEmailHeaderOptionsEnabled();
  const themes = isEmailThemesEnabled();

  const parsed = SaveSchema.safeParse(normalise(await req.json().catch(() => null), { headerOptions, themes }));
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
  if (style.logo) {
    const logo = await getLogo(ctx, style.logo.id);
    if (!logo || logo.filename !== style.logo.filename || !isEmailLogo(logo)) {
      return NextResponse.json(
        { error: "invalid_logo", message: "Pick one of your PNG or JPG logos." },
        { status: 400 },
      );
    }
  }
  if (style.headerImage) {
    const row = await getBrandAsset(ctx, style.headerImage.id);
    if (!row || row.filename !== style.headerImage.filename || !isEmailHeaderImage(row)) {
      return NextResponse.json(
        { error: "invalid_header_image", message: "Pick one of your header images." },
        { status: 400 },
      );
    }
    // The size read from the file at upload, so the band's height never rests on a client measurement.
    style.headerImage = { ...style.headerImage, width: row.width, height: row.height };
  }

  const saved = await setTenantEmailStyle(ctx.tenantId, style, undefined, {
    updatedBy: ctx.userId,
    ...(fromSuggestion ? { clearSuggestionAt: fromSuggestion } : {}),
  });
  const emailStyle =
    style.headerImage && saved ? await withoutDeletedHeaderImage(ctx, style.headerImage, saved) : saved;
  const shown = headerOptions ? emailStyle : withoutHeaderOptions(emailStyle);
  return NextResponse.json({ emailStyle: themes ? shown : withoutTheme(shown) });
}

/** "Reset to default": remove the Email style, so emails go back to today's look. A pending suggestion stays. */
export async function DELETE(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  await setTenantEmailStyle(g.ctx.tenantId, null);
  return NextResponse.json({ ok: true });
}

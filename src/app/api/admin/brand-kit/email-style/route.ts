import { NextResponse } from "next/server";
import { z } from "zod";
import { getLogo } from "@/lib/admin/brandLogos";
import { setTenantEmailStyle } from "@/lib/tenant/control";
import { EMAIL_STYLE_LIMITS, EmailStyleInputSchema } from "@/lib/types/tenant";
import { cleanCompanyName, isEmailLogo } from "@/lib/email/emailStyle";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Save's body: the style, plus the suggestion it applies (its `suggestedAt`) when saved from a Review. */
const SaveSchema = EmailStyleInputSchema.extend({ fromSuggestion: z.string().min(1).max(40).optional() });

/** Whole pixels within 1..max: a fractional or oversize measurement is rounded and clamped, not refused. */
function clampPx(n: unknown, max: number): unknown {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : n;
}

/** Tidy what the page sent (logo size, company name) before the strict parse sees it. */
function normalise(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const { logo, companyName } = body as { logo?: unknown; companyName?: unknown };
  const size = logo && typeof logo === "object" ? (logo as { width?: unknown; height?: unknown }) : null;
  return {
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
}

/**
 * Save the Email style (Brand › Email style). Admin-only; members can view the page. The
 * logo must be one of this tenant's PNG/JPEG logos, by id and filename. Writes only
 * `tenant.emailStyle`, and, with `fromSuggestion`, clears the suggestion it applies (if it's
 * still the pending one).
 */
export async function PUT(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  const { ctx } = g;

  const parsed = SaveSchema.safeParse(normalise(await req.json().catch(() => null)));
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

  const emailStyle = await setTenantEmailStyle(ctx.tenantId, style, undefined, {
    updatedBy: ctx.userId,
    ...(fromSuggestion ? { clearSuggestionAt: fromSuggestion } : {}),
  });
  return NextResponse.json({ emailStyle });
}

/** "Reset to default": remove the Email style, so emails go back to today's look. A pending suggestion stays. */
export async function DELETE(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;
  await setTenantEmailStyle(g.ctx.tenantId, null);
  return NextResponse.json({ ok: true });
}

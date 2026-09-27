import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { getLogo } from "@/lib/admin/brandLogos";
import { setTenantEmailStyle } from "@/lib/tenant/control";
import { EMAIL_STYLE_LIMITS, EmailStyleInputSchema } from "@/lib/types/tenant";
import { cleanCompanyName, isEmailLogo } from "@/lib/email/emailStyle";
import { isEmailStyleEnabled } from "@/lib/email/flags";
import type { TenantContext } from "@/lib/tenant/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Origin, flag, sign-in and admin, in that order — shared by Save and Reset. */
async function guard(req: Request): Promise<{ ok: true; ctx: TenantContext } | { ok: false; res: NextResponse }> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, res: blocked };
  if (!isEmailStyleEnabled()) {
    return { ok: false, res: NextResponse.json({ error: "email_style_disabled" }, { status: 503 }) };
  }
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (ctx.role !== "admin") return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, ctx };
}

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
 * `tenant.emailStyle`.
 */
export async function PUT(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.res;
  const { ctx } = g;

  const parsed = EmailStyleInputSchema.safeParse(normalise(await req.json().catch(() => null)));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }
  const style = parsed.data;
  if (style.logo) {
    const logo = await getLogo(ctx, style.logo.id);
    if (!logo || logo.filename !== style.logo.filename || !isEmailLogo(logo)) {
      return NextResponse.json(
        { error: "invalid_logo", message: "Pick one of your PNG or JPG logos." },
        { status: 400 },
      );
    }
  }

  const emailStyle = await setTenantEmailStyle(ctx.tenantId, style, undefined, { updatedBy: ctx.userId });
  return NextResponse.json({ emailStyle });
}

/** "Reset to default": remove the Email style, so emails go back to today's look. */
export async function DELETE(req: Request) {
  const g = await guard(req);
  if (!g.ok) return g.res;
  await setTenantEmailStyle(g.ctx.tenantId, null);
  return NextResponse.json({ ok: true });
}

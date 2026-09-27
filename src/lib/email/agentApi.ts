import { getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { listLogos } from "@/lib/admin/brandLogos";
import { BRAND_KIT_EMAIL_STYLE_ROUTE, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { isEmailLogo, styleFromBrandKit } from "./emailStyle";
import { isEmailStyleEnabled } from "./flags";

/**
 * What Vizzy may READ to talk about and suggest the Email style: the saved style, the
 * pending suggestion (never who asked), what "Use brand kit" would pick, and the logos an
 * email can use. No people or addresses. Auth is the signed canvas capability token (the
 * tenant comes from it), gated by the Email style flag.
 */

export type ApiResult = { status: number; body: unknown };

export function emailStyleAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isEmailStyleEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

/** The tenant's logos as the page lists them: none while Logos is off (emails carry no logo then). Throws if the list fails. */
export async function emailStyleLogos(ctx: TenantContext): Promise<BrandLogo[]> {
  return isBrandKitLogosEnabled() ? listLogos(ctx) : [];
}

export async function agentEmailStyle(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const [tenant, logos] = await Promise.all([
    getTenantById(ctx.tenantId, db).catch(() => null),
    emailStyleLogos(ctx).catch(() => null),
  ]);
  if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
  if (!logos) return { status: 503, body: { error: "logos_unavailable" } };

  const primary = logos.find((l) => l.isPrimary) ?? logos[0];
  const logoRef = (id: string | null | undefined) =>
    id ? { id, title: logos.find((l) => l.id === id)?.title ?? null } : null;
  const saved = tenant.emailStyle;
  const pending = tenant.emailStyleSuggestion;
  const kit = styleFromBrandKit(tenant.brandKit, logos);
  return {
    status: 200,
    body: {
      url: BRAND_KIT_EMAIL_STYLE_ROUTE,
      // Only an admin may suggest (and save); members can still ask what it is.
      canSuggest: ctx.role === "admin",
      // What branded emails wear now; null = today's plain look, with no header band.
      current: saved
        ? {
            logo: logoRef(saved.logo?.id),
            companyName: saved.companyName,
            headerColor: saved.headerColor,
            buttonColor: saved.accentColor,
            updatedAt: saved.updatedAt ?? null,
          }
        : null,
      // Waiting for an admin to Review and Save on the page; sends don't use it.
      pending: pending
        ? {
            logo: logoRef(pending.logoId),
            companyName: pending.companyName,
            headerColor: pending.headerColor,
            buttonColor: pending.accentColor,
            source: pending.source,
            brief: pending.brief,
            notes: pending.notes,
            suggestedAt: pending.suggestedAt,
          }
        : null,
      fromBrandKit: {
        logo: logoRef(kit.logoId),
        companyName: kit.companyName,
        headerColor: kit.headerColor,
        buttonColor: kit.accentColor,
        notes: kit.notes,
      },
      // The logos an email can show (PNG or JPEG); pass an id, "primary" or "none" to suggest one.
      logos: logos.filter(isEmailLogo).map((l) => ({
        id: l.id,
        title: l.title,
        primary: l.id === primary?.id,
        format: l.mimeType === "image/png" ? "png" : "jpeg",
      })),
      note: "companyName null shows the logo alone. A suggestion changes nothing until an admin saves it on the page.",
    },
  };
}

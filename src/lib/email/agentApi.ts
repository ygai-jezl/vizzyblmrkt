import { getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { BrandLogo } from "@/lib/types/brandLogo";
import type { BrandAsset } from "@/lib/types/brandAsset";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { listLogos } from "@/lib/admin/brandLogos";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import { BRAND_KIT_EMAIL_STYLE_ROUTE, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { isEmailHeaderImage, isEmailLogo, styleFromBrandKit } from "./emailStyle";
import { isEmailHeaderOptionsEnabled, isEmailStyleEnabled } from "./flags";

/**
 * What Vizzy may READ to talk about and suggest the Email style: the saved style, the
 * pending suggestion (never who asked), what "Use brand kit" would pick, and the logos an
 * email can use. No people or addresses. Auth is the signed canvas capability token (the
 * tenant comes from it), gated by the Email style flag. The header options (a gradient, the
 * header text colour, and a header image an admin uploaded on the page) are in it only with
 * EMAIL_HEADER_OPTIONS_ENABLED on; off, it's exactly as without them.
 */

export type ApiResult = { status: number; body: unknown };

const NOTE = "companyName null shows the logo alone. A suggestion changes nothing until an admin saves it on the page.";
const OPTIONS_NOTE =
  " headerGradientColor fades the header from headerColor to it, top left to bottom right (null = solid; Outlook and " +
  "Gmail on Android show headerColor alone), and headerText is auto (black or white, whichever reads better), white or black.";
const IMAGE_NOTE =
  " headerImage replaces the logo and name with a banner uploaded on the page (null = the colour header; headerColor " +
  'stays behind it and shows when images are off). Suggest one by its id from headerImages, or "none"; only the page ' +
  "can upload one.";

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

/** A header image an email can use: a PNG/JPEG `header` brand asset, with its size. */
export type EmailHeaderImageRow = BrandAsset & { width: number; height: number };

/**
 * The tenant's header images an email can use, newest first, as the page lists them: none (and
 * nothing read) while the header options are off. Throws if the list fails.
 */
export async function emailHeaderImages(ctx: TenantContext): Promise<EmailHeaderImageRow[]> {
  return isEmailHeaderOptionsEnabled() ? (await listBrandAssets(ctx, "header")).filter(isEmailHeaderImage) : [];
}

export async function agentEmailStyle(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const headerOptions = isEmailHeaderOptionsEnabled();
  const [tenant, logos, images] = await Promise.all([
    getTenantById(ctx.tenantId, db).catch(() => null),
    emailStyleLogos(ctx).catch(() => null),
    emailHeaderImages(ctx).catch(() => null),
  ]);
  if (!tenant) return { status: 404, body: { error: "tenant_not_found" } };
  if (!logos) return { status: 503, body: { error: "logos_unavailable" } };
  if (!images) return { status: 503, body: { error: "header_images_unavailable" } };

  const primary = logos.find((l) => l.isPrimary) ?? logos[0];
  const logoRef = (id: string | null | undefined) =>
    id ? { id, title: logos.find((l) => l.id === id)?.title ?? null } : null;
  const imageRef = (id: string | undefined) =>
    id ? { id, title: images.find((i) => i.id === id)?.title ?? null } : null;
  const saved = tenant.emailStyle;
  const pending = tenant.emailStyleSuggestion;
  const kit = styleFromBrandKit(tenant.brandKit, logos);
  // The keys, with their defaults spelled out (null = solid, "auto", null = the colour header), only
  // while the options are on. A colour 2 equal to the header colour draws solid (as the resolver has
  // it), so it's null too.
  const optionsOf = (
    s: { headerColor: string; headerGradientColor?: string; headerText?: "white" | "black" },
    headerImageId: string | undefined,
  ) =>
    headerOptions
      ? {
          headerGradientColor: s.headerGradientColor && s.headerGradientColor !== s.headerColor ? s.headerGradientColor : null,
          headerText: s.headerText ?? "auto",
          headerImage: imageRef(headerImageId),
        }
      : {};
  return {
    status: 200,
    body: {
      url: BRAND_KIT_EMAIL_STYLE_ROUTE,
      // Only an admin may suggest (and save); members can still ask what it is.
      canSuggest: ctx.role === "admin",
      // Vizzy may suggest a gradient, the header text colour and an uploaded header image too.
      ...(headerOptions ? { headerOptions: true } : {}),
      // What branded emails wear now; null = today's plain look, with no header band.
      current: saved
        ? {
            logo: logoRef(saved.logo?.id),
            companyName: saved.companyName,
            headerColor: saved.headerColor,
            ...optionsOf(saved, saved.headerImage?.id),
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
            ...optionsOf(pending, pending.headerImageId),
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
      // The banners an admin uploaded on the page; pass an id, or "none" for the colour header.
      ...(headerOptions ? { headerImages: images.map((i) => ({ id: i.id, title: i.title })) } : {}),
      note: headerOptions ? NOTE + OPTIONS_NOTE + IMAGE_NOTE : NOTE,
    },
  };
}

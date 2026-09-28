import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { listLogos } from "@/lib/admin/brandLogos";
import { listBrandAssets } from "@/lib/admin/brandAssets";
import { BRAND_KIT_ROUTE, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import {
  isEmailHeaderOptionsEnabled,
  isEmailHeaderOptionsUiEnabled,
  isEmailLayoutStyleEnabled,
  isEmailStyleEnabled,
  isEmailThemesEnabled,
  isEmailWebFontsEnabled,
} from "@/lib/email/flags";
import { isEmailHeaderImage, styleFromBrandKit } from "@/lib/email/emailStyle";
import { emailLinkOrigin } from "@/lib/email/footer";
import { resolveFooterBrand } from "@/lib/email/sender";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { EmailStyleCard } from "@/components/admin/brand-kit/EmailStyleCard";
import { brandFontsToEmail, paletteChips } from "@/components/admin/brand-kit/emailStyleForm";
import type { EmailHeaderImageChoice } from "@/components/admin/brand-kit/headerImage";

export const dynamic = "force-dynamic";

/**
 * Brand › Email style. The logo, optional company name, header colour and button colour
 * that branded emails wear (lifecycle, launch welcome, invite and newsletter emails). Members
 * can view, including a pending Vizzy suggestion; only admins save or dismiss it. Flag-gated
 * (EMAIL_STYLE_ENABLED). The header options (a gradient, the header text colour, and a Header
 * choice of Colour or Image, with the header images uploaded there) show only when
 * EMAIL_HEADER_OPTIONS_ENABLED and its client mirror are both on. The Theme (a look, a heading
 * and a body font, "Use brand fonts") shows only with EMAIL_THEMES_ENABLED, and the preview's
 * "As Apple Mail sees it" / "As Gmail & Outlook.com see it" only with EMAIL_WEB_FONTS_ENABLED too.
 * With EMAIL_LAYOUT_STYLE_ENABLED, the Button colour hint says it colours Create layout buttons too.
 */
export default async function EmailStylePage() {
  const ctx = await requireAdminContext();
  if (!isEmailStyleEnabled()) notFound();

  const tenant = await getTenantById(ctx.tenantId);
  // Emails only carry a logo while Logos is on (resolveEmailStyle drops it otherwise).
  const logosOn = isBrandKitLogosEnabled();
  let logos: BrandLogo[] = [];
  // No list (Logos off, or it failed) isn't "no logos": the card keeps the saved logo as it is.
  let logosUnavailable: "off" | "failed" | false = logosOn ? false : "off";
  if (logosOn) {
    try {
      logos = await listLogos(ctx);
    } catch (err) {
      logosUnavailable = "failed";
      console.error("[email-style] logos failed to load (index building?)", err);
    }
  }
  const choices = logos.map(({ id, filename, mimeType, isPrimary, createdAt, title, byteSize }) => ({
    id,
    filename,
    mimeType,
    isPrimary,
    createdAt,
    title,
    byteSize,
  }));
  const saved = tenant?.emailStyle;
  // Off, the page is exactly as without them: no controls, and Save sends no options (the PUT keeps the stored ones).
  const headerOptions = isEmailHeaderOptionsEnabled() && isEmailHeaderOptionsUiEnabled();
  // The header images an email can use, newest first. No list (it failed) isn't "none": the
  // card locks the Header choice and Save keeps the stored image.
  let headerImages: EmailHeaderImageChoice[] = [];
  let headerImagesUnavailable = false;
  if (headerOptions) {
    try {
      headerImages = (await listBrandAssets(ctx, "header"))
        .filter(isEmailHeaderImage)
        .map(({ id, title, filename, mimeType, byteSize, width, height, createdAt }) => ({
          id,
          title,
          filename,
          mimeType,
          byteSize,
          width,
          height,
          createdAt,
        }));
    } catch (err) {
      headerImagesUnavailable = true;
      console.error("[email-style] header images failed to load", err);
    }
  }
  // Off, the page is exactly as without them: no Theme section, and Save sends no theme (the PUT keeps the stored one).
  const themes = isEmailThemesEnabled();
  const webFonts = themes && isEmailWebFontsEnabled();
  // Vizzy's pending suggestion, for the banner. Who asked stays on the server. Its header
  // options (and header image), and its theme, only come along with them on; off, the banner
  // and Review are as without them.
  const suggestion = tenant?.emailStyleSuggestion;
  const pending = suggestion
    ? {
        logoId: suggestion.logoId,
        companyName: suggestion.companyName,
        headerColor: suggestion.headerColor,
        accentColor: suggestion.accentColor,
        ...(headerOptions && suggestion.headerGradientColor ? { headerGradientColor: suggestion.headerGradientColor } : {}),
        ...(headerOptions && suggestion.headerText ? { headerText: suggestion.headerText } : {}),
        ...(headerOptions && suggestion.headerImageId ? { headerImageId: suggestion.headerImageId } : {}),
        ...(themes && suggestion.theme ? { theme: suggestion.theme } : {}),
        source: suggestion.source,
        brief: suggestion.brief,
        notes: suggestion.notes,
        suggestedAt: suggestion.suggestedAt,
      }
    : null;
  const phase3 = isNavV2Phase3Enabled();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={BRAND_KIT_ROUTE}
          className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <ChevronLeft size={14} /> {phase3 ? "Brand" : "Brand Kit"}
        </Link>
        <h1 className="mt-1 text-lg font-semibold">Email style</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Your logo and colours on branded emails: lifecycle, launch welcome, invite and newsletter emails.
          Letters stay plain.
        </p>
      </div>
      <EmailStyleCard
        initial={
          saved
            ? {
                logo: saved.logo,
                companyName: saved.companyName,
                headerColor: saved.headerColor,
                accentColor: saved.accentColor,
                ...(headerOptions
                  ? {
                      headerGradientColor: saved.headerGradientColor ?? null,
                      headerText: saved.headerText ?? "auto",
                      headerImage: saved.headerImage ?? null,
                    }
                  : {}),
                ...(themes ? { theme: saved.theme ?? null } : {}),
              }
            : null
        }
        pending={pending}
        logos={choices}
        fromBrandKit={styleFromBrandKit(tenant?.brandKit, choices)}
        palette={paletteChips(tenant?.brandKit)}
        fallbackName={resolveFooterBrand(tenant, null)}
        tenantId={ctx.tenantId}
        logoOrigin={logosOn ? emailLinkOrigin() : ""}
        canEdit={ctx.role === "admin"}
        logosUnavailable={logosUnavailable}
        headerOptions={headerOptions}
        headerImages={headerImages}
        headerImagesUnavailable={headerImagesUnavailable}
        headerImageOrigin={headerOptions ? emailLinkOrigin() : ""}
        themes={themes}
        webFonts={webFonts}
        fontOrigin={webFonts ? emailLinkOrigin() : ""}
        fromBrandFonts={themes ? brandFontsToEmail(tenant?.brandTypography, tenant?.brandKit?.fonts) : null}
        layouts={isEmailLayoutStyleEnabled()}
      />
    </div>
  );
}

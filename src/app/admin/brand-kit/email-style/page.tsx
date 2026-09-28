import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { getTenantById } from "@/lib/tenant";
import { listLogos } from "@/lib/admin/brandLogos";
import { BRAND_KIT_ROUTE, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { isEmailHeaderOptionsEnabled, isEmailHeaderOptionsUiEnabled, isEmailStyleEnabled } from "@/lib/email/flags";
import { styleFromBrandKit } from "@/lib/email/emailStyle";
import { emailLinkOrigin } from "@/lib/email/footer";
import { resolveFooterBrand } from "@/lib/email/sender";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { EmailStyleCard } from "@/components/admin/brand-kit/EmailStyleCard";
import { paletteChips } from "@/components/admin/brand-kit/emailStyleForm";

export const dynamic = "force-dynamic";

/**
 * Brand › Email style. The logo, optional company name, header colour and button colour
 * that branded emails wear (lifecycle, launch welcome, invite and newsletter emails). Members
 * can view, including a pending Vizzy suggestion; only admins save or dismiss it. Flag-gated
 * (EMAIL_STYLE_ENABLED). The header options (a gradient, the header text colour) show only
 * when EMAIL_HEADER_OPTIONS_ENABLED and its client mirror are both on.
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
  // Vizzy's pending suggestion, for the banner. Who asked stays on the server.
  const suggestion = tenant?.emailStyleSuggestion;
  const pending = suggestion
    ? {
        logoId: suggestion.logoId,
        companyName: suggestion.companyName,
        headerColor: suggestion.headerColor,
        accentColor: suggestion.accentColor,
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
                  ? { headerGradientColor: saved.headerGradientColor ?? null, headerText: saved.headerText ?? "auto" }
                  : {}),
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
      />
    </div>
  );
}

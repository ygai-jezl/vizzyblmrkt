import { StoredEmailStyleSchema, type Tenant } from "@/lib/types/tenant";
import { brandLogoAbsoluteUrl, emailHeaderImageAbsoluteUrl, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import {
  isEmailHeaderOptionsEnabled,
  isEmailLayoutStyleEnabled,
  isEmailStyleEnabled,
  isEmailThemesEnabled,
  isEmailWebFontsEnabled,
} from "./flags";
import { resolveStoredStyle, safeHeaderImageUrl, safeLogoUrl, type ResolvedEmailStyle } from "./emailStyle";
import { emailLinkOrigin } from "./footer";
import { resolveFooterBrand } from "./sender";

/**
 * The Email style a tenant's sends and previews use, or null for today's look: the flag
 * is off, nothing is saved, the saved value is damaged, or there's no tenant. Server-side
 * (reads env); the renderers get the result as data.
 *
 * The logo is dropped — leaving a name band — when the Logos flag is off, or when there's
 * no origin to build an absolute URL from (an inbox can't load a relative one). The saved
 * header options (gradient, text colour, header image) are ignored while
 * EMAIL_HEADER_OPTIONS_ENABLED is off. The header image doesn't need the Logos flag (its
 * public brand-asset route isn't gated), but with no https origin it's dropped: the colour band.
 * The saved theme is ignored while EMAIL_THEMES_ENABLED is off; with EMAIL_WEB_FONTS_ENABLED
 * on too, a web font's files come from the same https origin (none = its safe fonts only).
 * Create layout buttons follow the style only with EMAIL_LAYOUT_STYLE_ENABLED on.
 */
export function resolveEmailStyle(tenant: Tenant | null | undefined): ResolvedEmailStyle | null {
  if (!isEmailStyleEnabled() || !tenant?.emailStyle) return null;
  const parsed = StoredEmailStyleSchema.safeParse(tenant.emailStyle);
  if (!parsed.success) return null;
  const linkOrigin = emailLinkOrigin();
  const origin = isBrandKitLogosEnabled() ? linkOrigin : "";
  return resolveStoredStyle(parsed.data, {
    logoUrlFor: (logo) =>
      origin ? safeLogoUrl(brandLogoAbsoluteUrl(origin, tenant.id, logo.filename), tenant.id) : null,
    headerImageUrlFor: (image) =>
      linkOrigin
        ? safeHeaderImageUrl(emailHeaderImageAbsoluteUrl(linkOrigin, tenant.id, image.filename), tenant.id)
        : null,
    fallbackName: resolveFooterBrand(tenant, null),
    headerOptions: isEmailHeaderOptionsEnabled(),
    themes: isEmailThemesEnabled(),
    webFonts: isEmailWebFontsEnabled(),
    fontOrigin: linkOrigin,
    layouts: isEmailLayoutStyleEnabled(),
  });
}

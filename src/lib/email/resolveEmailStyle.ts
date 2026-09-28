import { StoredEmailStyleSchema, StoredJourneyStyleSchema, type Tenant } from "@/lib/types/tenant";
import { brandLogoAbsoluteUrl, emailHeaderImageAbsoluteUrl, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import {
  isEmailHeaderOptionsEnabled,
  isEmailJourneyStyleEnabled,
  isEmailLayoutStyleEnabled,
  isEmailStyleEnabled,
  isEmailStyleTransactionalEnabled,
  isEmailThemesEnabled,
  isEmailWebFontsEnabled,
} from "./flags";
import {
  applyJourneyStyle,
  resolveStoredStyle,
  safeHeaderImageUrl,
  safeLogoUrl,
  withoutHeaderImage,
  type ResolvedEmailStyle,
} from "./emailStyle";
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

/**
 * The Email style the sign-up confirmation and offboarding emails wear, or null for today's
 * plain emails (EMAIL_STYLE_TRANSACTIONAL_ENABLED off, or whatever makes resolveEmailStyle
 * null). Always the colour header, never the banner: the confirmation email decides whether a
 * signup counts, and neither should look like a campaign. It's the tenant's style, never a
 * journey's (neither email belongs to one).
 */
export function resolveTransactionalEmailStyle(tenant: Tenant | null | undefined): ResolvedEmailStyle | null {
  return isEmailStyleTransactionalEnabled() ? withoutHeaderImage(resolveEmailStyle(tenant)) : null;
}

/**
 * The Email style one lifecycle journey's sends and previews wear (a product journey, or a launch
 * welcome journey on the new engine), given its live `emailStyle` (`override`, read leniently here:
 * anything unreadable is the brand's style). Null while EMAIL_STYLE_ENABLED is off. While
 * EMAIL_JOURNEY_STYLE_ENABLED is off it's exactly resolveEmailStyle(tenant), whatever is stored, so
 * that flag is a kill switch. On, a journey with its own style draws its colours on the colour
 * header, with the brand's logo, name and theme (applyJourneyStyle); its gradient and header text
 * need EMAIL_HEADER_OPTIONS_ENABLED too.
 */
export function resolveJourneyEmailStyle(
  tenant: Tenant | null | undefined,
  override: unknown,
): ResolvedEmailStyle | null {
  if (!isEmailStyleEnabled()) return null;
  const base = resolveEmailStyle(tenant);
  if (!isEmailJourneyStyleEnabled() || !tenant) return base;
  const parsed = StoredJourneyStyleSchema.safeParse(override);
  return applyJourneyStyle(base, parsed.success ? parsed.data : null, {
    fallbackName: resolveFooterBrand(tenant, null),
    headerOptions: isEmailHeaderOptionsEnabled(),
  });
}

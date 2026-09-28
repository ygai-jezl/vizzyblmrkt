import { StoredEmailStyleSchema, type Tenant } from "@/lib/types/tenant";
import { brandLogoAbsoluteUrl, isBrandKitLogosEnabled } from "@/lib/content/brandKit";
import { isEmailHeaderOptionsEnabled, isEmailStyleEnabled } from "./flags";
import { resolveStoredStyle, safeLogoUrl, type ResolvedEmailStyle } from "./emailStyle";
import { emailLinkOrigin } from "./footer";
import { resolveFooterBrand } from "./sender";

/**
 * The Email style a tenant's sends and previews use, or null for today's look: the flag
 * is off, nothing is saved, the saved value is damaged, or there's no tenant. Server-side
 * (reads env); the renderers get the result as data.
 *
 * The logo is dropped — leaving a name band — when the Logos flag is off, or when there's
 * no origin to build an absolute URL from (an inbox can't load a relative one). The saved
 * header options (gradient, text colour) are ignored while EMAIL_HEADER_OPTIONS_ENABLED is off.
 */
export function resolveEmailStyle(tenant: Tenant | null | undefined): ResolvedEmailStyle | null {
  if (!isEmailStyleEnabled() || !tenant?.emailStyle) return null;
  const parsed = StoredEmailStyleSchema.safeParse(tenant.emailStyle);
  if (!parsed.success) return null;
  const origin = isBrandKitLogosEnabled() ? emailLinkOrigin() : "";
  return resolveStoredStyle(parsed.data, {
    logoUrlFor: (logo) =>
      origin ? safeLogoUrl(brandLogoAbsoluteUrl(origin, tenant.id, logo.filename), tenant.id) : null,
    fallbackName: resolveFooterBrand(tenant, null),
    headerOptions: isEmailHeaderOptionsEnabled(),
  });
}

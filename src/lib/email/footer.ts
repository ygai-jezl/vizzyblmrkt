import type { Tenant } from "@/lib/types/tenant";
import { resolveFooterBrand, type CampaignSenderOverrides } from "@/lib/email/sender";
import type { FooterMergeValues } from "@/lib/email/mergeVars";
import { platformOrigin } from "@/lib/platform/origin";
import { mintUnsubscribeTokenOrNull, type SignUnsubscribeInput } from "@/lib/email/unsubscribeToken";

/**
 * Resolves the concrete values for the mandatory footer's tokens (sender brand,
 * unsubscribe / manage-preferences links, privacy policy) at send time. Threaded
 * into the compiler via MergeContext.footer (journey) or as constants for the
 * MailChimp translation (broadcast). See emailRender.renderFooter + mergeVars.
 */

/** Footer fallback when a tenant hasn't set a Privacy Policy URL yet (the admin
 *  form now requires one, so this only covers legacy tenants). */
export const DEFAULT_PRIVACY_URL = "https://yougrow.ai/privacy";

export function resolvePrivacyUrl(tenant: Tenant | null | undefined): string {
  return tenant?.emailSenderConfig?.privacyPolicyUrl?.trim() || DEFAULT_PRIVACY_URL;
}

/**
 * The two unsubscribe URLs for one recipient, built from a single signed token:
 *  - `pageUrl`: the human-facing hosted preference page (footer's Unsubscribe /
 *    Manage-preferences links open this — a GET).
 *  - `apiUrl`: the one-click endpoint used by the RFC 8058 List-Unsubscribe-Post
 *    header (a machine POST); its GET redirects to the page.
 * Both are "" when the signing key or platform origin is unconfigured (the footer
 * then falls back to the Privacy Policy link and the header is skipped — never a
 * broken href).
 */
export function unsubscribeLinks(input: SignUnsubscribeInput): {
  pageUrl: string;
  apiUrl: string;
} {
  const token = mintUnsubscribeTokenOrNull(input);
  const origin = platformOrigin();
  if (!token || !origin) return { pageUrl: "", apiUrl: "" };
  const q = `u=${encodeURIComponent(token)}`;
  return { pageUrl: `${origin}/unsubscribe?${q}`, apiUrl: `${origin}/api/unsubscribe?${q}` };
}

/** Footer values for a per-recipient JOURNEY (Mandrill) send. Pass the
 *  pre-built unsubscribe URL (also used for the List-Unsubscribe header). */
export function journeyFooterValues(args: {
  tenant: Tenant | null | undefined;
  campaign: CampaignSenderOverrides | null | undefined;
  unsubscribeUrl: string;
}): FooterMergeValues {
  const privacyUrl = resolvePrivacyUrl(args.tenant);
  const link = args.unsubscribeUrl || privacyUrl;
  return {
    brand: resolveFooterBrand(args.tenant, args.campaign),
    unsubscribeUrl: link,
    managePreferencesUrl: link,
    privacyUrl,
  };
}

/** Footer values for a BROADCAST (MailChimp): brand + privacy are constants; the
 *  unsubscribe / manage links become MailChimp native tags in toMailchimpMergeTags. */
export function broadcastFooterValues(
  tenant: Tenant | null | undefined,
  campaign: CampaignSenderOverrides | null | undefined,
): FooterMergeValues {
  return {
    brand: resolveFooterBrand(tenant, campaign),
    unsubscribeUrl: "",
    managePreferencesUrl: "",
    privacyUrl: resolvePrivacyUrl(tenant),
  };
}

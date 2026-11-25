import type { Tenant } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/** What of the brand record the first visit rule reads (Home has the whole record already). */
export type FirstVisitTenant = Pick<Tenant, "businessProfile" | "emailSenderConfig" | "socialConnections" | "gitConnections" | "brandVoice">;

const hasText = (v: string | null | undefined) => !!v?.trim();

/**
 * Setup a person did on the brand, from what Home already read: any sending detail (a domain
 * added, verified or not, a sender name, an address), LinkedIn or X connected, GitHub connected, a
 * brand voice written, or a brand map saved (known only with the setup guide on). Creating a brand
 * fills none of these. A logo isn't counted: it is a count Home reads only with the guide on.
 */
export function didSetupWork(tenant: FirstVisitTenant, setup?: { brandMapSaved?: boolean | null } | null): boolean {
  const voice = tenant.brandVoice;
  const sender = tenant.emailSenderConfig;
  return (
    (sender?.domains?.length ?? 0) > 0 ||
    [sender?.senderName, sender?.fromLocalPart, sender?.fromDomain, sender?.replyTo, sender?.postalAddress, sender?.privacyPolicyUrl].some(hasText) ||
    Object.keys(tenant.socialConnections ?? {}).length > 0 ||
    Object.keys(tenant.gitConnections ?? {}).length > 0 ||
    (!!voice && (hasText(voice.summary) || hasText(voice.guidelines) || (voice.dos?.length ?? 0) > 0 || (voice.donts?.length ?? 0) > 0)) ||
    setup?.brandMapSaved === true
  );
}

/**
 * Whether Home sends this person to the welcome (ONBOARDING_ENABLED, checked by the caller):
 * an admin, of a brand with no profile yet, that has never made anything (launches and programmes,
 * archived ones too, any connection, sandboxes too, and any lifecycle journey), has no sign-ups,
 * and has done no setup (didSetupWork). Anything unknown says no: a failed read of the brand, its
 * records or its sign-ups never sends a busy brand to the welcome. Existing brands always have
 * something, so they start from Settings instead; members never get it.
 *
 * Home only redirects. The welcome marks the profile started when it renders (markWelcomeShown in
 * welcomeShown.ts), so it shows once per brand and a lost redirect comes back on the next visit.
 */
export function shouldWelcome(
  tenant: FirstVisitTenant | null,
  signals: { recordsEver: number | null; signups: number | null; setup?: { brandMapSaved?: boolean | null } | null },
  role: TenantRole | undefined,
): boolean {
  return (
    role === "admin" &&
    !!tenant &&
    !tenant.businessProfile &&
    signals.recordsEver === 0 &&
    signals.signups === 0 &&
    !didSetupWork(tenant, signals.setup)
  );
}

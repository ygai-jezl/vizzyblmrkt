import type { Tenant } from "@/lib/types/tenant";
import type { DeliveryMode, LifecycleJourney, LifecycleSettings } from "@/lib/types/lifecycle";
import type { ConsentBasis, ConsentPolicy } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { registrableDomain } from "@/lib/domains/registrableDomain";
import { normalizeEmail } from "@/lib/waitlist/identifiers";

/**
 * Who a lifecycle email may go to, from which address, in which delivery mode.
 * Pure — the runner, the enrolment path and the admin API share these rules.
 */

const MODE_RANK: Record<DeliveryMode, number> = { test: 0, shadow: 1, live: 2 };

/** The most restrictive of the given modes (test < shadow < live). */
export function lowestMode(...modes: DeliveryMode[]): DeliveryMode {
  return modes.reduce((lo, m) => (MODE_RANK[m] < MODE_RANK[lo] ? m : lo), "live" as DeliveryMode);
}

/** Whether a consent basis lets this connection send marketing-class email (service email needs none). */
export function allowsMarketing(policy: Pick<ConsentPolicy, "marketingBases">, basis: ConsentBasis | null | undefined): boolean {
  return policy.marketingBases.includes(basis ?? "none");
}

/** In test mode only these product users are enrolled and emailed. */
export function isTestRecipient(
  journey: Pick<LifecycleJourney, "testRecipients">,
  user: Pick<ProductUser, "externalUserId" | "email">,
): boolean {
  const { userIds, emails } = journey.testRecipients;
  if (userIds.includes(user.externalUserId)) return true;
  const email = user.email ? normalizeEmail(user.email) : "";
  return Boolean(email) && emails.some((e) => normalizeEmail(e) === email);
}

/** Registrable domains of the tenant's VERIFIED sending domains. */
export function verifiedSendingDomains(tenant: Tenant | null | undefined): Set<string> {
  return new Set(
    (tenant?.emailSenderConfig?.domains ?? [])
      .filter((d) => d.status === "verified")
      .map((d) => registrableDomain(d.domain))
      .filter((d): d is string => Boolean(d)),
  );
}

/**
 * An operator-chosen inbox (shadow inbox, test address) must be the operator's
 * own sign-in address or on one of the tenant's verified sending domains, so the
 * platform can never be pointed at arbitrary people.
 */
export function isOwnOrVerifiedAddress(
  email: string,
  opts: { ownEmail?: string | null; tenant: Tenant | null | undefined },
): boolean {
  const e = email.trim().toLowerCase();
  if (opts.ownEmail && e === opts.ownEmail.trim().toLowerCase()) return true;
  const domain = registrableDomain(e.slice(e.lastIndexOf("@") + 1));
  return Boolean(domain) && verifiedSendingDomains(opts.tenant).has(domain!);
}

export interface LifecycleSender {
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  /** The From address is on a verified domain (required for live mode). */
  verified: boolean;
}

/**
 * The journey's sender, falling back to the tenant's default identity. A From
 * address is only used when its domain is verified; otherwise it's dropped and
 * `verified` is false — live sends are then held, never silently sent from the
 * platform's default address.
 */
export function lifecycleSender(
  tenant: Tenant | null | undefined,
  sender: LifecycleSettings["sender"],
): LifecycleSender {
  const cfg = tenant?.emailSenderConfig;
  const tenantFrom = cfg?.fromLocalPart && cfg?.fromDomain ? `${cfg.fromLocalPart}@${cfg.fromDomain}` : undefined;
  const candidate = sender.fromEmail?.trim() || tenantFrom;
  const verifiedExact = new Set(
    (cfg?.domains ?? []).filter((d) => d.status === "verified").map((d) => d.domain.toLowerCase()),
  );
  const domain = candidate ? candidate.slice(candidate.lastIndexOf("@") + 1).toLowerCase() : "";
  const verified = Boolean(candidate) && verifiedExact.has(domain);
  return {
    fromEmail: verified ? candidate : undefined,
    fromName: sender.fromName?.trim() || cfg?.senderName?.trim() || undefined,
    replyTo: sender.replyTo?.trim() || cfg?.replyTo?.trim() || undefined,
    verified,
  };
}

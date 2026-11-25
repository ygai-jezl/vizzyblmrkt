import { isSelfServeSignupOpen } from "./flags";
import type { TrustedProvider } from "./trust";

/**
 * Admin access allow-list (AUTHORIZATION). Two lists, comma separated, both empty by default so
 * nobody is an admin until a deployment names its own:
 *  - ADMIN_ALLOWED_EMAILS: exact addresses, case-insensitive. Google or password sign-in.
 *  - ADMIN_ALLOWED_DOMAINS: whole domains, matched on Google's hosted-domain (`hd`) claim, falling
 *    back to the email's domain. Google sign-in only (ADR-0014, D3): matching a whole domain stays
 *    a Google Workspace privilege, so a password account needs its exact address on the email list.
 *
 * Pure apart from reading those variables and the self-serve switch, so it's trivially testable.
 *
 * SECURITY PRECONDITION: callers MUST have already AUTHENTICATED the sign-in with judgeSignIn
 * (./trust.ts, which ensureAdminAccess runs first): a Google or password sign-in, a verified email,
 * and no linked sign-in for another address. Given that, `email` is verified and the domain
 * fallback is trustworthy. Do NOT call this on an unverified email: that reintroduces the
 * domain-spoofing bypass this precondition closes.
 */

/**
 * - "allowed": on the email list, or (Google only) in a listed domain
 * - "google_only": a password sign-in whose address is allowed only through the domain list
 * - "self_serve": on no list while self-serve sign-up is open (never today: see flags.ts)
 * - "forbidden": on no list
 *
 * Every answer is a non-empty string, so compare with `=== "allowed"`, never use it as a boolean.
 */
export type AdminListAnswer = "allowed" | "google_only" | "self_serve" | "forbidden";

export function isAllowedAdmin(
  email: string | undefined,
  hostedDomain: string | undefined,
  provider: TrustedProvider,
): AdminListAnswer {
  if (!email) return "forbidden";
  if (isListedAdminEmail(email)) return "allowed";
  const allowedDomains = list(process.env.ADMIN_ALLOWED_DOMAINS);
  const domain = (hostedDomain ?? email.split("@")[1] ?? "").toLowerCase();
  if (domain && allowedDomains.includes(domain)) return provider === "google.com" ? "allowed" : "google_only";
  // The self-serve seam: someone on no list who may create their own brand. Unreachable until
  // self-serve brand creation ships (isSelfServeSignupOpen is false whatever the switch says).
  return isSelfServeSignupOpen() ? "self_serve" : "forbidden";
}

/** The exact address is on ADMIN_ALLOWED_EMAILS (case-insensitive), whatever the sign-in method. */
export function isListedAdminEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  return !!e && list(process.env.ADMIN_ALLOWED_EMAILS).includes(e);
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

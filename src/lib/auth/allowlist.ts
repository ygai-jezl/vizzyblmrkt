/**
 * Admin access allow-list (AUTHORIZATION). Gated by the verified Google Workspace
 * hosted-domain (`hd`) claim, falling back to the email domain, plus an optional
 * explicit email allow-list. Pure (no Next/Firebase imports) so it's trivially
 * testable.
 *
 * SECURITY PRECONDITION: callers MUST have already AUTHENTICATED the identity —
 * i.e. confirmed a verified Google sign-in (see isVerifiedGoogleIdentity in
 * session.ts, which runs before this in ensureAdminAccess). Given that, the
 * `email` here is Google-VERIFIED, so the `email.split("@")[1]` domain fallback
 * is trustworthy (not a self-asserted value). Do NOT call this on an unverified
 * email — that reintroduces the domain-spoofing bypass this precondition closes.
 *
 * Config (env): ADMIN_ALLOWED_DOMAINS (default "yougrow.ai"), ADMIN_ALLOWED_EMAILS.
 */
export function isAllowedAdmin(email?: string, hostedDomain?: string): boolean {
  if (!email) return false;
  const allowedEmails = list(process.env.ADMIN_ALLOWED_EMAILS);
  if (allowedEmails.includes(email.toLowerCase())) return true;
  const allowedDomains = list(process.env.ADMIN_ALLOWED_DOMAINS ?? "yougrow.ai");
  const domain = (hostedDomain ?? email.split("@")[1] ?? "").toLowerCase();
  return !!domain && allowedDomains.includes(domain);
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

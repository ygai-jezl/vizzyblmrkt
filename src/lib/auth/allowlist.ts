/**
 * Admin access allow-list. Gated by the verified Google Workspace hosted-domain
 * (`hd`) claim, falling back to the email domain, plus an optional explicit
 * email allow-list. Pure (no Next/Firebase imports) so it's trivially testable.
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

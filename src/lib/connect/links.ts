import { registrableDomain } from "@/lib/domains/registrableDomain";

/**
 * Link checks against a connection's allowed link domains. Pure and client-safe
 * (no tenant or network imports), so settings forms can validate as you type.
 */

/** True when `url` is https and on one of the allowed registrable domains. */
export function isAllowedLink(url: string, linkDomains: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = registrableDomain(u.hostname);
  if (!host) return false;
  return linkDomains.some((d) => registrableDomain(d) === host);
}

/** The registrable domain of an https URL ("app.acme.co.uk/x" → "acme.co.uk"), or null. */
export function linkDomainOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? registrableDomain(u.hostname) || null : null;
  } catch {
    return null;
  }
}

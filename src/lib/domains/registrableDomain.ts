import { getDomain } from "tldts";

/**
 * Domain helpers for the custom-domain web-routing flow. eTLD+1 ("registrable
 * domain") comparison is done via the public-suffix list (tldts) so that
 * `mail.acme.co.uk` and `acme.co.uk` compare equal but `acme.co.uk` and
 * `evil.com` never do — naive suffix matching would be exploitable.
 */

/** Lowercase + strip scheme/path/port/trailing-dot/whitespace. "" when unusable. */
export function normalizeHost(input: string): string {
  let h = (input ?? "").trim().toLowerCase();
  if (!h) return "";
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
  h = h.replace(/\/.*$/, ""); // path
  h = h.replace(/[?#].*$/, ""); // query/fragment (defensive)
  h = h.replace(/:\d+$/, ""); // :port
  h = h.replace(/\.+$/, ""); // trailing dot(s)
  return h;
}

/** The registrable domain (eTLD+1) of a host, or null for IPs/localhost/invalid. */
export function registrableDomain(host: string): string | null {
  const h = normalizeHost(host);
  if (!h) return null;
  return getDomain(h);
}

/** True when two hosts share the same registrable domain (eTLD+1). */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return ra !== null && ra === rb;
}

/**
 * Consumer/free email providers whose domain can NEVER prove brand ownership
 * (anyone can hold an @gmail.com address). The email-match fast-path must reject
 * these — otherwise an attacker with a free mailbox could claim the provider's
 * own domain. Compared at the registrable-domain level.
 */
const PUBLIC_EMAIL_PROVIDERS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
  "fastmail.com",
  "hey.com",
]);

/** True when `domain` (any host form) is a known public/free email provider. */
export function isPublicEmailProvider(domain: string): boolean {
  const r = registrableDomain(domain);
  return r !== null && PUBLIC_EMAIL_PROVIDERS.has(r);
}

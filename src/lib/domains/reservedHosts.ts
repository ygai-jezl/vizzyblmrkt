import { normalizeHost } from "./registrableDomain";
import { platformHost } from "@/lib/platform/origin";

/**
 * Hosts that can NEVER be claimed as a tenant's custom web-routing domain. The
 * top threat (OWASP A01/A04) is a tenant claiming the platform's own host (or an
 * App Hosting / Cloud Run default host) to intercept default-path traffic for
 * every brand, so those are hard-blocked regardless of any ownership proof.
 */

/** Platform-controlled apex suffixes that route to our infra. */
const RESERVED_SUFFIXES = [
  ".hosted.app",
  ".web.app",
  ".firebaseapp.com",
  ".run.app",
];

const RESERVED_EXACT = new Set(["localhost"]);

/** IPv4 / bracketed-or-bare IPv6 literals — never a routable custom domain. */
function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.includes(":")) return true; // IPv6 (incl. ::1)
  return false;
}

/** Extra platform-owned domains, comma-separated, e.g. "yougrow.ai,vizzybl.app". */
function envReservedDomains(): string[] {
  return (process.env.PLATFORM_RESERVED_DOMAINS ?? "")
    .split(",")
    .map((d) => normalizeHost(d))
    .filter(Boolean);
}

/**
 * True when `host` must not be claimable as a tenant custom domain. Note the
 * platform host itself (PLATFORM_ORIGIN, e.g. yougrow.ai) is reserved here — the
 * dogfood tenant that legitimately uses it was provisioned manually and is
 * grandfathered; no NEW tenant may claim it.
 */
export function isReservedHost(input: string): boolean {
  const host = normalizeHost(input);
  if (!host) return true; // unusable → refuse
  if (RESERVED_EXACT.has(host)) return true;
  if (isIpLiteral(host)) return true;
  if (RESERVED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return true;
  const self = platformHost();
  if (self && (host === self || host.endsWith(`.${self}`))) return true;
  for (const d of envReservedDomains()) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

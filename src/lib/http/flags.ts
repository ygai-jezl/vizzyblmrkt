/**
 * Request handling switches and settings. A switch is off unless its variable is exactly "true".
 */

/**
 * Per-visitor limits key on the address Google's load balancer adds to X-Forwarded-For
 * (TRUSTED_PROXY_HOPS entries from the right), not on the first entry, which a visitor can write.
 * Off: the first valid X-Forwarded-For entry, as before.
 */
export function isTrustedClientIpEnabled(): boolean {
  return process.env.TRUSTED_CLIENT_IP_ENABLED === "true";
}

/** App Hosting's shape: the visitor, then the load balancer, then Google's front end. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 2;

/** The most hops TRUSTED_PROXY_HOPS may name; anything larger is treated as a typo. */
export const MAX_TRUSTED_PROXY_HOPS = 5;

/**
 * How many proxies add themselves to X-Forwarded-For after the visitor's address. A whole
 * number from 0 to 5; empty or anything else means the default, 2.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw || !/^\d{1,2}$/.test(raw)) return DEFAULT_TRUSTED_PROXY_HOPS;
  const hops = Number(raw);
  return hops <= MAX_TRUSTED_PROXY_HOPS ? hops : DEFAULT_TRUSTED_PROXY_HOPS;
}

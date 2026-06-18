/**
 * The platform's own canonical, tenant-NEUTRAL origin — the single host every
 * brand's widget is served from by default (the getwaitlist.com model). Set via
 * NEXT_PUBLIC_PLATFORM_ORIGIN so it's available on both server and client.
 *
 * Today this is `https://yougrow.ai` (which also doubles as the dogfood tenant's
 * brand domain — intentional). It MUST be the host registered on the reCAPTCHA
 * Enterprise key, so every default-path widget passes captcha with zero
 * per-tenant key writes. When unset, callers fall back to the incoming request
 * origin (preserving the pre-platform-host behaviour), so deploys are unaffected
 * until the env var is set.
 */
export function platformOrigin(): string {
  return (process.env.NEXT_PUBLIC_PLATFORM_ORIGIN ?? "").replace(/\/+$/, "");
}

/** Host portion of the platform origin (no scheme), or null when unset. */
export function platformHost(): string | null {
  const origin = platformOrigin();
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `origin` (scheme + host) is the platform's own origin. */
export function isPlatformOrigin(origin: string): boolean {
  const self = platformOrigin();
  return self !== "" && origin.replace(/\/+$/, "").toLowerCase() === self.toLowerCase();
}

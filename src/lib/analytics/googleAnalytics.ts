/**
 * Google Analytics 4 (gtag.js) for the public YouGrow site. Pure + client-safe,
 * so the <GoogleAnalytics> client component and the tests share it.
 *
 * Ships ON in dev (apphosting.yaml, with debug_mode so dev hits land in
 * DebugView and GA's "Developer traffic" filter keeps them out of reports) and
 * OFF in prod (apphosting.prod.yaml) until verified on dev and promoted.
 *
 * Consent Mode v2: storage is denied by default in the EEA, UK and Switzerland
 * (Google then sends cookieless pings only) and analytics-only storage is granted
 * elsewhere. Ad storage is denied everywhere — we don't run Google Ads from here.
 * A consent banner would call gtag('consent', 'update', …) on opt-in.
 */

/** GA4 measurement IDs are `G-` + uppercase alphanumerics. */
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;

export interface GaConfig {
  measurementId: string;
  debugMode: boolean;
}

/**
 * The GA config for this build, or null when GA is off. NEXT_PUBLIC_* are
 * inlined at BUILD, so each must be read by its literal name. The ID is
 * validated because it's interpolated into an inline <script>.
 */
export function gaConfig(): GaConfig | null {
  if (process.env.NEXT_PUBLIC_GA_ENABLED !== "true") return null;
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim() ?? "";
  if (!MEASUREMENT_ID.test(measurementId)) return null;
  return { measurementId, debugMode: process.env.NEXT_PUBLIC_GA_DEBUG_MODE === "true" };
}

/**
 * Only our own public pages are measured. Everything else is out of scope:
 * /embed runs inside customers' sites, /waitlist pages belong to tenants,
 * /unsubscribe links carry tokens, and /admin is the signed-in product.
 */
export function isGaTrackedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/developers" ||
    pathname.startsWith("/developers/")
  );
}

/** EU member states + Iceland, Liechtenstein, Norway (EEA), the UK and Switzerland. */
export const CONSENT_REQUIRED_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH",
];

const ALL_DENIED = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
};

/**
 * The inline bootstrap: consent defaults BEFORE config, as Google requires. The
 * region-specific default wins over the global one for those regions.
 * debug_mode is omitted (not `false`) outside debug — any value enables it.
 */
export function gaBootstrapScript({ measurementId, debugMode }: GaConfig): string {
  if (!MEASUREMENT_ID.test(measurementId)) throw new Error("invalid GA measurement ID");
  return [
    "window.dataLayer = window.dataLayer || [];",
    "function gtag(){dataLayer.push(arguments);}",
    `gtag('consent', 'default', ${JSON.stringify({ ...ALL_DENIED, region: CONSENT_REQUIRED_REGIONS })});`,
    `gtag('consent', 'default', ${JSON.stringify({ ...ALL_DENIED, analytics_storage: "granted" })});`,
    "gtag('js', new Date());",
    `gtag('config', '${measurementId}'${debugMode ? ", { debug_mode: true }" : ""});`,
  ].join("\n");
}

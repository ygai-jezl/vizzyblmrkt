/**
 * Email style flags (logo, company name and colours on branded emails), and the header
 * options on top of it (a gradient header, a chosen header text colour, logo clean-up).
 * Pure + client-safe. Each is ON in dev (apphosting.yaml) and set explicitly in prod
 * (apphosting.prod.yaml). Renderers never read these: they get the style as data.
 */

/**
 * Server flag — sends and previews use a saved Email style; the page, its APIs and
 * Vizzy's tools work. Off: today's emails exactly, page 404, APIs 503. Saved styles
 * are kept, so this is a kill switch.
 */
export function isEmailStyleEnabled(): boolean {
  return process.env.EMAIL_STYLE_ENABLED === "true";
}

/** Client mirror — the Brand › Email style tile only shows when this is on. */
export function isEmailStyleUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EMAIL_STYLE_ENABLED === "true";
}

/**
 * Server flag — header options (needs EMAIL_STYLE_ENABLED). On: sends and previews draw a
 * saved gradient and header text colour, and the Save API takes them. Off: the resolver
 * ignores them, so emails are exactly as without them, and a Save keeps what's stored (a
 * kill switch, like the one above).
 */
export function isEmailHeaderOptionsEnabled(): boolean {
  return process.env.EMAIL_HEADER_OPTIONS_ENABLED === "true";
}

/** Client mirror — the page shows the header options only when this and the server flag are on. */
export function isEmailHeaderOptionsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EMAIL_HEADER_OPTIONS_ENABLED === "true";
}

/**
 * Email style flags (logo, company name and colours on branded emails). Pure +
 * client-safe. ON in dev (apphosting.yaml), OFF in prod (apphosting.prod.yaml)
 * until verified on dev. Renderers never read these: they get the style as data.
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

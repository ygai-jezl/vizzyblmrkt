/**
 * Email style flags (logo, company name and colours on branded emails), the header
 * options on top of it (a gradient header, a chosen header text colour, a header image,
 * logo clean-up), themes (a look and two fonts, with web fonts on their own flag), and
 * Create layout buttons that follow it. Pure + client-safe. Each is ON in dev
 * (apphosting.yaml) and set explicitly in prod (apphosting.prod.yaml). Renderers never
 * read these: they get the style as data.
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
 * saved gradient, header text colour and header image (a banner in place of the logo and
 * name), the Save API takes them, and header images can be uploaded and deleted. Off: the
 * resolver ignores them, so emails are exactly as without them, the header image routes 503,
 * and a Save keeps what's stored (a kill switch, like the one above). Banners in emails
 * already sent keep loading: their public /api/brand-asset/header/… route isn't gated.
 */
export function isEmailHeaderOptionsEnabled(): boolean {
  return process.env.EMAIL_HEADER_OPTIONS_ENABLED === "true";
}

/** Client mirror — the page shows the header options only when this and the server flag are on. */
export function isEmailHeaderOptionsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EMAIL_HEADER_OPTIONS_ENABLED === "true";
}

/**
 * Server flag — themes (needs EMAIL_STYLE_ENABLED). On: sends and previews draw a saved theme
 * (one of four looks, a heading and a body font), and the Save API takes it. Off: the resolver
 * ignores it, so emails are exactly as without it, and a Save keeps what's stored (a kill switch).
 */
export function isEmailThemesEnabled(): boolean {
  return process.env.EMAIL_THEMES_ENABLED === "true";
}

/**
 * Server flag — web fonts (needs EMAIL_THEMES_ENABLED). On: a theme with a web font (Inter,
 * Lora, …) tells the renderers where the font files are (public/email-fonts/), so its emails
 * gain a `<head>` block that loads them in the inboxes that do (Apple Mail, Outlook for Mac and
 * a few others), and Mandrill sends those with inline_css off. Off: every theme draws its safe
 * fonts only, with no head block.
 */
export function isEmailWebFontsEnabled(): boolean {
  return process.env.EMAIL_WEB_FONTS_ENABLED === "true";
}

/**
 * Server flag — layout buttons (needs EMAIL_STYLE_ENABLED). On: a button in a Create email layout
 * takes the Email style's button colour (with a readable label) and, with a theme, its button
 * shape, unless the button is set to its own colour. Off: every button draws as built. The saved
 * colours are never rewritten, so this is a kill switch.
 */
export function isEmailLayoutStyleEnabled(): boolean {
  return process.env.EMAIL_LAYOUT_STYLE_ENABLED === "true";
}

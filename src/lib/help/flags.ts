/**
 * Flags for the help pages and the setup guide. Pure and client-safe (no server
 * imports), so the sidebar, header and drawer (client) and pages (server) share them.
 */

/** The public /help pages, their Markdown copies and /help/llms.txt. Off = /help 404s. */
export function isHelpPagesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_HELP_PAGES_ENABLED === "true";
}

/**
 * The setup guide in the app: Home's "Get ready" stage, what each step needs
 * first, How to links, the How to drawer, Help in the sidebar and in ⌘K. It
 * points at the help pages, so it needs them on too.
 */
export function isSetupGuideEnabled(): boolean {
  return isHelpPagesEnabled() && process.env.NEXT_PUBLIC_SETUP_GUIDE_ENABLED === "true";
}

/**
 * Flags for the "Growth Path" admin navigation (nav v2). Pure + client-safe (no
 * server imports), so the sidebar (client) and pages/layouts (server) share them.
 * Each ships ON in dev (apphosting.yaml) and OFF in prod (apphosting.prod.yaml)
 * until verified on dev and promoted. Off = the admin behaves exactly as before.
 */

/** The new sidebar, header with breadcrumbs, Launches list, and old-route redirects. */
export function isNavV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_NAV_V2_ENABLED === "true";
}

/** The header's System / Light / Dark switch. It lives in the nav v2 header, so it needs that too. */
export function isThemeSwitchEnabled(): boolean {
  return isNavV2Enabled() && process.env.NEXT_PUBLIC_THEME_SWITCH_ENABLED === "true";
}

/**
 * Nav v2 phase 2, "always a next step": the Home growth path and real metrics,
 * the sidebar progress dots, one Review queue for every decision, the Ask Vizzy
 * panel (⌘J), ⌘K search, and the shell palette. Needs nav v2.
 */
export function isNavV2Phase2Enabled(): boolean {
  return isNavV2Enabled() && process.env.NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED === "true";
}

/**
 * Nav v2 phase 3, "one home per noun": Brand, Settings (General · Sending ·
 * Integrations · Billing), Audience across sources, one Journeys list for both
 * engines, launch Emails, the Products setup checklist and environments, and
 * Content's Overview + Programme naming. Needs phase 2.
 */
export function isNavV2Phase3Enabled(): boolean {
  return isNavV2Phase2Enabled() && process.env.NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED === "true";
}

/**
 * Nav v2 phase 4, "close the loop": the launch Overview checklist, the new
 * breadcrumbs and ⌘K items, and the programme in view sent to Vizzy. Needs
 * phase 3. Insights, content authoring and invites each have their own flag too.
 */
export function isNavV2Phase4Enabled(): boolean {
  return isNavV2Phase3Enabled() && process.env.NEXT_PUBLIC_NAV_V2_PHASE4_ENABLED === "true";
}

/** The Insights hub (Overview · Launches · Email · Content · Journeys). Needs phase 4. Off = today's analytics page. */
export function isInsightsHubEnabled(): boolean {
  return isNavV2Phase4Enabled() && process.env.NEXT_PUBLIC_INSIGHTS_HUB_ENABLED === "true";
}

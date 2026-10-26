/**
 * Sign-ups from a brand's own site: a launch's site key, POST /api/v2/signups, the
 * Confirm subscription page, and the "Your own form" panel and help that go with them.
 * Off = none of it exists: the call answers 404, the panel and help are hidden, and
 * confirmation links behave as they always have.
 */
export function isSiteSignupsEnabled(): boolean {
  return process.env.LAUNCH_SITE_SIGNUPS_ENABLED === "true";
}

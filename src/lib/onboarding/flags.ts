/**
 * Switches for getting to know a brand (the welcome, the 4 quick questions and the brand's
 * profile). Server switches: browser code gets them as props from the server.
 *
 * Neither folds in nav v2: the pages that need a nav phase check it themselves, so the help tests
 * can turn these on without turning on the nav switches that change other help pages.
 */

/** The welcome at /admin/welcome, the 4 quick questions and the brand's profile. Off = as before. */
export function isOnboardingEnabled(): boolean {
  return process.env.ONBOARDING_ENABLED === "true";
}

/** Talk with Vizzy by voice on the welcome. Needs ONBOARDING_ENABLED. */
export function isOnboardingVoiceEnabled(): boolean {
  return isOnboardingEnabled() && process.env.ONBOARDING_VOICE_ENABLED === "true";
}

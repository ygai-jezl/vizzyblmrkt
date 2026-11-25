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

/**
 * Vizzy reads the words from calls in chat (needs ONBOARDING_ENABLED): a kept fact's quote when it
 * came from a call, and a call's transcript. Off, Vizzy reads the facts' lines, and quotes and
 * conversations from chats only. What a tool reads is kept with the chat's session in Agent
 * Runtime (one region, which no path deletes), so it outlives a deleted call: turn this on once
 * the privacy policy says so.
 */
export function isCallWordsInChatEnabled(): boolean {
  return isOnboardingEnabled() && process.env.ONBOARDING_CALL_WORDS_IN_CHAT_ENABLED === "true";
}

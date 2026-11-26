import { isOnboardingEnabled } from "@/lib/onboarding/flags";

/**
 * Home's Your next action as a card Vizzy writes (PR B of getting to know you, ADR-0020): 1 to 3
 * steps from the brand's answers, the facts it kept and where it is, each with why. A server
 * switch: browser code gets it as a prop from the server.
 *
 * It needs ONBOARDING_ENABLED, which keeps the profile it reads. Off = Home is exactly as PR A
 * shows it: the steps of the stage that fits the answers (src/lib/onboarding/homeOrder.ts).
 */
export function isNextActionCardEnabled(): boolean {
  return isOnboardingEnabled() && process.env.NEXT_ACTION_CARD_ENABLED === "true";
}

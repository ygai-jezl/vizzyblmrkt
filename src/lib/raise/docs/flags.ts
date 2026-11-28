/**
 * Switches for the Raise kit (Content › Raise kit): decks for investors and packs for lenders.
 * Each is off unless "true": listed "false" in apphosting.yaml and turned on per deployment.
 * Server switches only: pages pass what is on to their client components. Off, nothing reads or
 * writes a deck, no route answers but 503, no page but 404, and search feeds no decks.
 */

/** The store, Content › Raise kit, the studio, Present, Save as PDF, the admin API, the search feeder and the help page. */
export function isRaiseKitEnabled(): boolean {
  return process.env.RAISE_KIT_ENABLED === "true";
}

/** Vizzy drafting and revising decks from chat, and reading them (needs RAISE_KIT_ENABLED). */
export function isVizzyRaiseEnabled(): boolean {
  return isRaiseKitEnabled() && process.env.VIZZY_RAISE_ENABLED === "true";
}

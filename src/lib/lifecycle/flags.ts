/**
 * Flags for connected-product lifecycle journeys. Pure + client-safe (no server
 * imports), so the sidebar (client) and the routes/pages (server) can share them.
 * Each ships ON in dev (apphosting.yaml) and OFF in prod (apphosting.prod.yaml)
 * until the milestone is verified on dev and promoted.
 */

/** Server flag — the Products/Lifecycle admin APIs 503 and pages notFound() when off. */
export function isLifecycleEnabled(): boolean {
  return process.env.LIFECYCLE_ENABLED === "true";
}

/** Client mirror — the sidebar only shows the Lifecycle group when this is on. */
export function isLifecycleUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIFECYCLE_ENABLED === "true";
}

/**
 * The highest delivery mode any lifecycle send may use in this environment:
 * `test` < `shadow` < `live`. Unset or unknown means `test` (the safest), so a
 * misconfigured prod can never send to real users. dev and prod: live (prod
 * since the vizzybl.ai launch, M7).
 */
export function lifecycleModeCeiling(): "test" | "shadow" | "live" {
  const v = process.env.LIFECYCLE_MODE_CEILING;
  return v === "live" || v === "shadow" ? v : "test";
}

/** Server flag — per-person AI lines (prepared ahead, staff-approved). Off: standard emails only. */
export function isLifecycleAiDraftsEnabled(): boolean {
  return process.env.LIFECYCLE_AI_DRAFTS_ENABLED === "true";
}

/** Server flag — Vizzy can draft and edit lifecycle journeys from the chat (drafts only). */
export function isLifecycleChatAuthoringEnabled(): boolean {
  return process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED === "true";
}

/**
 * Server flag — consent decides which marketing someone gets. A marketing email
 * that's due without consent is skipped (off: held until consent arrives, however
 * late); a journey can admit only people with marketing consent; and the
 * "Marketing consent granted" trigger enrols people who opt in later.
 */
export function isLifecycleConsentAtSendEnabled(): boolean {
  return process.env.LIFECYCLE_CONSENT_AT_SEND === "true";
}

/**
 * Server flag — going live reaches recent sign-ups, never late. Enrolment uses the
 * effective mode (the journey's, capped by the ceiling); when a sign-up journey can
 * first email everyone, the tick enrols the people inside its window; and an
 * enrolment held for its mode that never started exits once its window passes.
 */
export function isLifecycleGoLiveSweepEnabled(): boolean {
  return process.env.LIFECYCLE_GO_LIVE_SWEEP === "true";
}

/**
 * Server flag — "Marketing consent granted" is for people who opt in after
 * signing up. An opt-in while a sign-up journey could still take the person (the
 * longest sign-up window, 72 hours without one) is sign-up consent: the sign-up
 * journeys take them and the trigger doesn't fire, even when the product's first
 * write came before its consent step. Off: only a user's first write counts as
 * sign-up consent.
 */
export function isLifecycleOptInAfterSignupEnabled(): boolean {
  return process.env.LIFECYCLE_OPT_IN_AFTER_SIGNUP === "true";
}

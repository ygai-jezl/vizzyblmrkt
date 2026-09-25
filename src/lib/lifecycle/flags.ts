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
 * misconfigured prod can never send to real users. dev: live; prod: test until
 * the vizzybl.ai launch (M7).
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

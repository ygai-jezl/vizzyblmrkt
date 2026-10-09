/**
 * Flags for the person view (Audience → Product users). Server-only: pages pass
 * what's on to their client components. Each ships ON in dev (apphosting.yaml)
 * and OFF in prod (apphosting.prod.yaml) until checked on dev and promoted.
 */

/**
 * The fuller Product users list (stage, current journey, email counts, search and
 * filters) and the page for one person. Needs lifecycle. Off: today's list.
 */
export function isPersonViewEnabled(): boolean {
  return process.env.AUDIENCE_PERSON_VIEW === "true" && process.env.LIFECYCLE_ENABLED === "true";
}

/**
 * Vizzy can read ONE person's situation: their stage, journeys and emails, never
 * their name, address or user id. Needs the person view and chat authoring. Off:
 * Vizzy only ever gets totals, as before.
 */
export function isPersonBriefEnabled(): boolean {
  return (
    isPersonViewEnabled() &&
    process.env.LIFECYCLE_PERSON_BRIEF === "true" &&
    process.env.LIFECYCLE_CHAT_AUTHORING_ENABLED === "true"
  );
}

/**
 * A plan per person: Vizzy drafts it, staff approve it on the person's page, and an
 * approved plan steers that person's AI line (still through Approvals). Needs the brief.
 */
export function isPersonPlansEnabled(): boolean {
  return isPersonBriefEnabled() && process.env.LIFECYCLE_PERSON_PLANS === "true";
}

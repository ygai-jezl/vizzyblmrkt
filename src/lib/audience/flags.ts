/**
 * Flags for the person view (Audience → Product users). Server-only: pages pass
 * what's on to their client components. Each is off unless "true": listed
 * "false" in apphosting.yaml and turned on per deployment.
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

/**
 * One person record per brand per address (the contact), linked to their sign-ups on
 * every launch and their user record in every product, rebuilt on every write and
 * swept on the lifecycle tick. Off: contacts come from sign-ups only, as before.
 */
export function isPersonLinksEnabled(): boolean {
  return process.env.AUDIENCE_PERSON_LINKS_ENABLED === "true";
}

/**
 * One People list across every source and one page per person, with whole-person
 * erase and export, stage clocks per product and Vizzy's audience counts. Needs the
 * person links. Off: the Signups and Product users tabs, as before.
 */
export function isOneViewEnabled(): boolean {
  return isPersonLinksEnabled() && process.env.AUDIENCE_ONE_VIEW_ENABLED === "true";
}

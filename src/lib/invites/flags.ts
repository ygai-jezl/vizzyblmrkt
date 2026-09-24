import { isNavV2Phase4Enabled } from "@/lib/nav/flags";

/**
 * "Invite your waitlist" (nav v2 phase 4). Pure + client-safe.
 *
 * Server: the invite APIs, sending (invite jobs are held while off), attribution
 * on ingest and Vizzy-drafted waves. Invite links (/invite/…) keep working either
 * way, so links already in inboxes never break.
 */
export function isInvitesEnabled(): boolean {
  return process.env.INVITES_ENABLED === "true";
}

/** The invite UI: header button, invites page, funnel strips, checklist step, Setup step, ⌘K. Needs phase 4. */
export function isInvitesUiEnabled(): boolean {
  return isNavV2Phase4Enabled() && process.env.NEXT_PUBLIC_INVITES_ENABLED === "true";
}

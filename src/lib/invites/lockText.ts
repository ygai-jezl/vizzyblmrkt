/**
 * Why inviting is locked, and what the locked button says (the visible reason,
 * not just a tooltip). Its own tiny module so client components can show the
 * text without bundling the link checks (and their public-suffix list).
 */

export type InviteLockReason =
  | "launch_archived"
  | "no_product"
  | "staging_only"
  | "no_signup_url"
  | "links_unconfigured";

export const INVITE_LOCK_TEXT: Record<InviteLockReason, string> = {
  launch_archived: "This launch is archived.",
  no_product: "Connect your product first.",
  staging_only: "Connect your production app — invites go to production, not staging.",
  no_signup_url: "Add your app's sign-up link in Products › Settings.",
  links_unconfigured: "Invite links aren't set up yet.",
};

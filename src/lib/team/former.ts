/**
 * What someone no longer on the team is called wherever history or a value names who did
 * something. Pure, so client components can show it; src/lib/team/names.ts looks names up.
 */
export const FORMER_TEAM_MEMBER = "Former team member";

/**
 * What a team member is called where their name can't be shown: someone with no display name when
 * addresses are left out (what Vizzy reads), or an old record that kept an address instead of a
 * user id. Never the address itself.
 */
export const A_TEAM_MEMBER = "A team member";

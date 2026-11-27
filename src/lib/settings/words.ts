/**
 * Settings › History's fixed words that the server says and the help page quotes (ADR-0023). Pure,
 * with no imports, so the How to drawer can load the help page in the browser.
 */

/** The first version of a catalog saved before every version was kept. */
export const BEFORE_HISTORY_TEXT = "As it was when history began. Older versions were not kept.";

/** What a restore never undoes, whatever the kind. */
export const NEVER_UNDONE = "Emails sent, payments, people already in a journey, erased values";

/** Why restoring a team view from History is refused, and what the restore answers (team_views_full). */
export const TEAM_VIEWS_FULL_TEXT = "Restoring it would put more than 50 team views in use. Archive one you no longer use first.";

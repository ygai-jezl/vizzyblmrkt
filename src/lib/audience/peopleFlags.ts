import { isOneViewEnabled } from "./flags";
import { isOntologyPersonIdsEnabled } from "@/lib/ontology/flags";

/**
 * Switches for piece B's People features that write person rows. Each needs the one People
 * list and, by decision 25, the person on every row (ONTOLOGY_PERSON_IDS_ENABLED), so a field
 * change is always filed under the person it is about. Kept apart from ./flags.ts because
 * src/lib/ontology/flags.ts imports that file. Server only, each off unless "true": listed
 * "false" in apphosting.yaml and turned on per deployment.
 */

/**
 * Fields on people and companies (AUDIENCE_FIELDS_ENABLED): the brand's own field lists, kept
 * in Settings › Data model with every change versioned, and values set on a person's page or a
 * company's. Off: the routes don't exist and the screens hide them. Stored values stay, and
 * export and erase cover them whatever this says.
 */
export function isFieldsEnabled(): boolean {
  return isOneViewEnabled() && isOntologyPersonIdsEnabled() && process.env.AUDIENCE_FIELDS_ENABLED === "true";
}

/**
 * Filtering People by fields and by product group (AUDIENCE_FIELD_FILTERS_ENABLED, needs fields):
 * a pill for each select, multi select, status and checkbox field, and "Everyone in this group"
 * from a person's page, through the existing `memberOf` index. Off: the list as before. The field
 * tags are written with the values whatever this says; they are derived and harmless.
 */
export function isFieldFiltersEnabled(): boolean {
  return isFieldsEnabled() && process.env.AUDIENCE_FIELD_FILTERS_ENABLED === "true";
}

/**
 * New person (AUDIENCE_ADD_PERSON_ENABLED): an admin adds someone by hand from the People list or
 * ⌘K, with how they agreed to marketing email. Off: the form, the ⌘K entry and the routes don't
 * exist. Never a reason to drop anyone: the rule that keeps people added by hand keys on their
 * `addedBy` and has no switch, and export and erase cover them whatever this says.
 */
export function isAddPersonEnabled(): boolean {
  return isOneViewEnabled() && isOntologyPersonIdsEnabled() && process.env.AUDIENCE_ADD_PERSON_ENABLED === "true";
}

/**
 * The timeline on a person's page (AUDIENCE_TIMELINE_ENABLED): their stage, product, launch and
 * quiet moves, recorded as record.field_changed on `sys.` ids after each sync, beside field
 * changes, consent, sign-ups, launch emails and voice chats. It gates the recording too, so
 * nothing is written until it is on and history starts that day. Off: no moves are recorded and
 * the section is hidden; stored events stay, and export and erase cover them whatever this says.
 */
export function isTimelineEnabled(): boolean {
  return isOneViewEnabled() && isOntologyPersonIdsEnabled() && process.env.AUDIENCE_TIMELINE_ENABLED === "true";
}

/**
 * Vizzy reads fields and suggests edits (AUDIENCE_VIZZY_FIELDS_ENABLED, needs fields): on any
 * person's page Vizzy is told who is open, reads the field list and that person's select, multi
 * select, status, checkbox, number, currency and date values (never text, email, phone, link or
 * team member ones), and suggests changes that an admin confirms on the page or from Review. It
 * doesn't need the lifecycle person brief. Off: Vizzy isn't told who is open unless the brief is
 * on, its field routes answer unavailable, and suggestions are hidden. Open suggestions stay, and
 * export and erase cover them whatever this says. Off in production until the DPA line.
 */
export function isVizzyFieldsEnabled(): boolean {
  return isFieldsEnabled() && process.env.AUDIENCE_VIZZY_FIELDS_ENABLED === "true";
}

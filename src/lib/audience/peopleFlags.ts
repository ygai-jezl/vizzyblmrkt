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

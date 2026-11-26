import { isFieldsEnabled } from "@/lib/audience/peopleFlags";
import { isPlansEnabled } from "@/lib/plans/flags";

/**
 * Settings history (piece O part 2, ADR-0021). Server switches, read when a page or route runs,
 * so flipping one needs no new build. Each is off unless "true": listed "false" in apphosting.yaml
 * and turned on per deployment.
 */

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to the brand's fields, journeys,
 * product catalogs and shared connections in one list, a preview before a restore, restoring an
 * older version as a new one (a journey into its draft only), JSON export, and Vizzy's read of the
 * same list. Off: the tab, its routes and Vizzy's route don't exist, and Data model and the Catalog
 * tab work as before.
 */
export function isSettingsHistoryEnabled(): boolean {
  return process.env.SETTINGS_HISTORY_ENABLED === "true";
}

/**
 * An owner erases the values of an archived field (SETTINGS_ERASE_ENABLED, needs Settings ›
 * History, fields and PLANS_ENABLED): an owner of the brand's organisation with a real admin row
 * for the brand, 30 days or more after the field was last archived, after a count and with the
 * field's name typed. Off: no Erase values, and a running erase waits at its cursor, still marked,
 * until it is on again. Kept off on self-hosted copies.
 */
export function isSettingsEraseEnabled(): boolean {
  return isSettingsHistoryEnabled() && isFieldsEnabled() && isPlansEnabled() && process.env.SETTINGS_ERASE_ENABLED === "true";
}

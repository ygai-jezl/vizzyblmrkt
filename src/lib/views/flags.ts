import { isFieldsEnabled } from "@/lib/audience/peopleFlags";

/**
 * Views on People (piece C, CRM_VIEWS_ENABLED): filters, columns, sort and saved views on the People
 * list, read in memory up to 5,000 people a view, and Vizzy reading saved views' counts (decision 6:
 * the same switch). Needs fields (AUDIENCE_FIELDS_ENABLED, which needs the one People list and the
 * person ids); the screen also needs nav phase 3, as the People list does. Server only: the page
 * passes it down. Off: the routes answer 404, the Views menu and Add filter hide, People works as
 * before, saved views stay stored, and Vizzy's tool says views are off.
 */
export function isViewsEnabled(): boolean {
  return isFieldsEnabled() && process.env.CRM_VIEWS_ENABLED === "true";
}

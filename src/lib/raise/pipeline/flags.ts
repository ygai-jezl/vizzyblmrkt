import { isFieldsEnabled } from "@/lib/audience/peopleFlags";

/**
 * Switches for the investor and funding board (S2a). Server only: pages pass what is on to their
 * client components. Each is off unless exactly "true", listed "false" in apphosting.yaml and turned
 * on per deployment. Off: the routes answer 404 (Vizzy's 503 `unavailable`), the tab, the setup box,
 * the Review section and the tick lane are gone, and stored fields, values and follow-ups stay.
 */

/**
 * The investor and funding board (RAISE_PIPELINE_ENABLED): Set up for raising or funding, the board on
 * People, the Passed reasons and Vizzy's get_raise_pipeline. Needs fields (AUDIENCE_FIELDS_ENABLED).
 */
export function isRaisePipelineEnabled(): boolean {
  return isFieldsEnabled() && process.env.RAISE_PIPELINE_ENABLED === "true";
}

/** Follow-ups from the board (RAISE_FOLLOWUPS_ENABLED): the tick lane and its Review kind. Needs the board. */
export function isRaiseFollowupsEnabled(): boolean {
  return isRaisePipelineEnabled() && process.env.RAISE_FOLLOWUPS_ENABLED === "true";
}

/**
 * Agent record (ADR-0026): what Vizzy, research and the autopilot draft for a brand is recorded as
 * agent actions, from saved to kept or dismissed; a daily catch-up closes what moved on another
 * way; Review lists the drafts it missed (Vizzy's email and image style, the notes Vizzy
 * suggested); and Vizzy reads the record with get_drafts. A server switch, RUNTIME.
 *
 * Off: nothing new is recorded, the catch-up doesn't run, Review is as before and the tool says
 * the record is off. Records written while it was on still close when a person decides (closing
 * runs whatever this says), and the rest expire.
 */
export function isAgentRecordEnabled(): boolean {
  return process.env.AGENT_RECORD_ENABLED === "true";
}

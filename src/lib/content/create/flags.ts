/**
 * Flags for the Create pillar's intake wizard. Server-side, read at runtime: pages pass
 * what they decide to the browser as props.
 */

/**
 * "Suggest an angle": a new workflow's Spark (its angle / thesis) suggested from what the
 * brand has already said (the brand map and its knowledge). Off: the Spark field is exactly
 * as before.
 */
export function isSuggestAngleEnabled(): boolean {
  return process.env.CREATE_SUGGEST_ANGLE_ENABLED === "true";
}

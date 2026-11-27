/**
 * A brand's industry, as the counts across brands split organisations by it (learning loops step
 * 5, owner decision 5 in the plan for steps 4 and 5). Nothing writes an industry yet, so every
 * brand is "unknown" and every organisation count sits under Unknown. The onboarding follow up
 * changes only this function; new brands starting from their industry's defaults is step 9.
 * Pure.
 */

/** The industry every brand has until one is written. */
export const UNKNOWN_INDUSTRY = "unknown" as const;

/** An industry as a counter key: lower case letters, digits and underscores. */
export type Industry = typeof UNKNOWN_INDUSTRY;

/** The brand's industry for the counts across brands: "unknown" until onboarding writes one. */
export function industryOf(_brand: { id: string }): Industry {
  return UNKNOWN_INDUSTRY;
}

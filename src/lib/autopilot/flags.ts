/**
 * Next article autopilot (src/lib/autopilot, src/lib/nextUp).
 *
 * - BRAND_MAP_NEXT_UP_ENABLED: Next up (the three best next questions), find and sort what buyers
 *   ask, and Vizzy's get_next_up. Per brand: the next_up feature (src/lib/plans/brandAccess.ts).
 * - CREATE_RESEARCH_CONTEXT_ENABLED: blog research and the writer read the context pack, in every
 *   run, manual ones too (needs BRAND_CONTEXT_ENABLED).
 * - CREATE_ARTICLE_AUTOPILOT_ENABLED (needs Next up): the scheduled run, its settings and Review
 *   rows. Draft runs per brand: the article_autopilot feature.
 * - CREATE_AUTOPILOT_LEARNING_ENABLED (needs Next up): the Learned list feeds picks and the judge.
 */
export function isNextUpEnabled(): boolean {
  return process.env.BRAND_MAP_NEXT_UP_ENABLED === "true";
}

export function isResearchContextEnabled(): boolean {
  return process.env.CREATE_RESEARCH_CONTEXT_ENABLED === "true";
}

export function isAutopilotEnabled(): boolean {
  return isNextUpEnabled() && process.env.CREATE_ARTICLE_AUTOPILOT_ENABLED === "true";
}

export function isAutopilotLearningEnabled(): boolean {
  return isNextUpEnabled() && process.env.CREATE_AUTOPILOT_LEARNING_ENABLED === "true";
}

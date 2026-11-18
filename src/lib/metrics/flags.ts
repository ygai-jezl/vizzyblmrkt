/**
 * Vizzy reads email and post numbers (get_email_results, get_post_results through
 * /api/agent/results/*), each with its meaning. Aggregates only, read only. Off: the routes
 * answer unavailable and Vizzy says so.
 */
export function isResultsChatEnabled(): boolean {
  return process.env.RESULTS_CHAT_ENABLED === "true";
}

/**
 * Server flag — API v2 (/api/v2/users…): the routes 404 when off. On in dev
 * (apphosting.yaml), off in prod until verified on dev and flipped with a
 * chore(prod) change. v1 (/api/v1/events) is removed, so with this off an
 * environment has no ingest API at all.
 */
export function isApiV2Enabled(): boolean {
  return process.env.API_V2_ENABLED === "true";
}

/**
 * Server flag — tell the product (an `email.suppressed` webhook) when YouGrow stops
 * emailing one of its users because the address hard-bounced or they marked an
 * email as spam.
 */
export function isSuppressionWebhookEnabled(): boolean {
  return process.env.CONNECT_SUPPRESSION_WEBHOOK_ENABLED === "true";
}

/**
 * Server flag — a write that leaves the user's state as it was (a daily re-sync
 * resending the same values) leaves no row in the Events tab, which counts them
 * instead. The profile still records the write, so out-of-order writes stay safe.
 */
export function isQuietUnchangedWritesEnabled(): boolean {
  return process.env.CONNECT_QUIET_UNCHANGED_WRITES === "true";
}

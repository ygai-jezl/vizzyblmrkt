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
 * Server flag — `entities`: the things a person has several of (workspaces,
 * brands, projects), sent with their state, and journeys that say which of them
 * each email is about. Off: `entities` in a write is left out (and listed in
 * `ignoredFields`), and journeys are about the person only.
 */
/**
 * Server flag — a write that leaves the user's state as it was (a daily re-sync
 * resending the same values) leaves no row in the Events tab, which counts them
 * instead. The profile still records the write, so out-of-order writes stay safe.
 */
export function isEntitiesEnabled(): boolean {
  return process.env.CONNECT_ENTITIES_ENABLED === "true";
}

export function isQuietUnchangedWritesEnabled(): boolean {
  return process.env.CONNECT_QUIET_UNCHANGED_WRITES === "true";
}

/**
 * Server flag — catalog history on the Catalog tab: the last saved versions of a
 * product's catalog, with what changed, who saved it, and Restore. Versions are
 * recorded either way; off hides them and refuses a restore.
 */
export function isCatalogHistoryEnabled(): boolean {
  return process.env.CATALOG_HISTORY_ENABLED === "true";
}

/**
 * Server flag — a fact can be a date (when someone was last active, when a trial
 * ends): the catalog marks it `date`, the product sends it as text, and journeys
 * read it as whole days from now ("Days since", "Days until"). Off: the catalog
 * refuses the type, so nothing downstream ever sees one.
 */
export function isDateFactsEnabled(): boolean {
  return process.env.CONNECT_DATE_FACTS === "true";
}

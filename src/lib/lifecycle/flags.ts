/**
 * Flags for connected-product lifecycle journeys. Pure + client-safe (no server
 * imports), so the sidebar (client) and the routes/pages (server) can share them.
 * Each ships ON in dev (apphosting.yaml) and OFF in prod (apphosting.prod.yaml)
 * until the milestone is verified on dev and promoted.
 */

/** Server flag — the Products/Lifecycle admin APIs 503 and pages notFound() when off. */
export function isLifecycleEnabled(): boolean {
  return process.env.LIFECYCLE_ENABLED === "true";
}

/** Client mirror — the sidebar only shows the Lifecycle group when this is on. */
export function isLifecycleUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIFECYCLE_ENABLED === "true";
}

/** Server flag — the public ingest API (/api/v1/events) 503s when off. */
export function isLifecycleIngestEnabled(): boolean {
  return process.env.LIFECYCLE_INGEST_ENABLED === "true";
}

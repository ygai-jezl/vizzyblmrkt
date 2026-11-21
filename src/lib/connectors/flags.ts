/**
 * Connected data switches (Connectors 1, ADR-0011). Each is on only when it is exactly "true".
 * With CONNECTORS_ENABLED off every connector route answers 404, nothing calls a provider, and
 * sealed tokens stay sealed in data_connections, working again when it is turned back on.
 */

/** The connector core: the routes, the connection records and every call to a provider. */
export function isConnectorsEnabled(): boolean {
  return process.env.CONNECTORS_ENABLED === "true";
}

/**
 * The Browse, Listing and Connected views (built into the page, so it needs a new build to
 * change). Needs CONNECTORS_ENABLED for anything behind them to answer.
 */
export function isConnectorsScreenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CONNECTORS_ENABLED === "true";
}

/** Cloudflare in the catalogue, with an API token. Needs CONNECTORS_ENABLED. */
export function isCloudflareConnectorEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_CLOUDFLARE_ENABLED === "true";
}

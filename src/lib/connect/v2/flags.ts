/**
 * Server flag — API v2 (/api/v2/users…): the routes 404 when off. On in dev
 * (apphosting.yaml), off in prod until verified on dev and flipped with a
 * chore(prod) change. v1 (/api/v1/events) is removed, so with this off an
 * environment has no ingest API at all.
 */
export function isApiV2Enabled(): boolean {
  return process.env.API_V2_ENABLED === "true";
}

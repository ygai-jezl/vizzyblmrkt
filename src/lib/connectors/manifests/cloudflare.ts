import type { ConnectorManifestInput } from "../manifest";

/**
 * Cloudflare, with an API token (Connectors 1a). Read only: daily totals for one zone, read live
 * when someone asks. Collecting them every day is Connectors 2.
 *
 * Cloudflare's GraphQL Analytics API answers HTTP 200 even when a query fails, with the reason in
 * an `errors` array, so the handlers (src/lib/connectors/handlers/cloudflare.ts) read that array.
 * The token is checked with a zone query rather than user/tokens/verify, which may refuse account
 * tokens and doesn't prove the token can read this zone. Requests and page views come from the
 * daily dataset (httpRequests1dGroups); visits only from the sampled one
 * (httpRequestsAdaptiveGroups, sum.visits), which keeps about 31 days on every plan.
 * Docs: developers.cloudflare.com/analytics/graphql-api.
 */
export const cloudflareManifest = {
  schema: 1,
  id: "cloudflare",
  name: "Cloudflare",
  summary: "Requests, page views and visits for your site, read from Cloudflare when you ask.",
  category: "analytics",
  publisher: "yougrow",
  switch: "CONNECTOR_CLOUDFLARE_ENABLED",
  connect: [
    {
      method: "token_fields",
      fields: [
        {
          key: "zoneId",
          label: "Zone ID",
          secret: false,
          help: "On your site's Overview page in Cloudflare, in the API box on the right.",
          pattern: "^[0-9a-f]{32}$",
          minLength: 32,
          maxLength: 32,
        },
        {
          key: "token",
          label: "API token",
          secret: true,
          help: "A token that can only read analytics. YouGrow seals it and never shows it again.",
          pattern: "^[A-Za-z0-9_-]+$",
          minLength: 20,
          maxLength: 200,
        },
      ],
      account: "zoneId",
      auth: { field: "token", scheme: "Bearer" },
      permissions: ["Zone, Analytics, Read"],
      tokenLink:
        "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=YouGrow%20analytics%20read",
      steps: [
        "In Cloudflare, open My Profile, then API Tokens, or use the link here, which fills in the form for you.",
        "Give the token one permission: Zone, Analytics, Read.",
        "Under Zone Resources, include only the site you want to connect.",
        "Create the token and copy it. Cloudflare shows it only once.",
        "Paste the token and your site's Zone ID here, then press Connect.",
      ],
    },
  ],
  api: {
    hosts: ["api.cloudflare.com"],
    // Cloudflare allows 300 GraphQL queries every 5 minutes per user; stay well under it.
    limits: { connection: { perMinute: 10, perHour: 120 }, brand: { perMinute: 20, perHour: 300 } },
    timeoutMs: 10_000,
    maxBytes: 512 * 1024,
  },
  verify: { method: "POST", url: "https://api.cloudflare.com/client/v4/graphql", hook: "cloudflare.zoneProbe" },
  shares: [
    {
      what: "Daily totals for the zone",
      detail: "requests, page views and visits",
      direction: "read",
      where: "Read live when you or Vizzy ask. Nothing is stored.",
      needs: ["Zone, Analytics, Read"],
    },
    {
      what: "Anything else",
      direction: "never",
      where: "Nothing is ever written to Cloudflare.",
    },
  ],
  produces: [
    {
      stream: "zone_daily",
      description: "Requests, page views and visits for one zone, a row per day (UTC).",
      shape: "numbers",
      keys: ["day"],
      measures: ["cfRequests", "cfPageViews", "cfVisits"],
      joins: { day: "day" },
      lagDays: 1,
      personal: false,
      liveBy: ["day"],
    },
  ],
  uses: ["vizzy.read"],
  hooks: { live: "cloudflare.zoneDaily" },
  disconnect: "Disconnecting deletes the token YouGrow keeps. Cloudflare has no way for us to cancel it, so delete it in Cloudflare too.",
} satisfies ConnectorManifestInput;

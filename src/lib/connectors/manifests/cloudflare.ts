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
 *
 * Connecting is token first (owner, 22 Nov, as the approved Listing): Check lists the zones the
 * token can see (GET /zones, which needs Zone Read) and the admin picks one; a token without Zone
 * Read falls back to a typed Zone ID. Nothing is saved until Connect, which runs the zone probe on
 * the picked zone. The link fills in Zone Read (key zone), Zone Analytics Read (key analytics) and
 * Account Analytics Read (key account_analytics), from
 * developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template. Account Analytics
 * Read is asked for now (owner, 22 Nov, as the approved Listing) so later features don't need a new
 * token; nothing reads with it today, and its shares line says so.
 */
export const cloudflareManifest = {
  schema: 1,
  id: "cloudflare",
  name: "Cloudflare",
  summary: "Requests, page views and visits for your site, read from Cloudflare when you ask.",
  category: "traffic",
  publisher: "yougrow",
  switch: "CONNECTOR_CLOUDFLARE_ENABLED",
  connect: [
    {
      method: "token_fields",
      // The token first: Check lists the zones it can see, and the zone is picked from them.
      fields: [
        {
          key: "token",
          label: "API token",
          secret: true,
          help: "A token that can only read. YouGrow seals it and never shows it again.",
          pattern: "^[A-Za-z0-9_-]+$",
          minLength: 20,
          maxLength: 200,
        },
        {
          key: "zoneId",
          label: "Zone ID",
          secret: false,
          help: "Only when the token can't list your zones: on your site's Overview page in Cloudflare, in the API box on the right.",
          pattern: "^[0-9a-f]{32}$",
          minLength: 32,
          maxLength: 32,
        },
      ],
      account: "zoneId",
      auth: { field: "token", scheme: "Bearer" },
      permissions: ["Zone Read", "Zone Analytics Read", "Account Analytics Read"],
      tokenLink:
        "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=YouGrow%20analytics%20read",
      steps: [
        "In Cloudflare, open My Profile, then API Tokens, or use the link here, which fills in the form for you.",
        "Give the token three permissions: Zone Read, so YouGrow can list your zones; Zone Analytics Read, so it can read their numbers; and Account Analytics Read, asked for now so later features don't need a new token. Nothing reads with it today.",
        "Under Account Resources, include only the account your site is in. Under Zone Resources, include only the site you want to connect.",
        "Create the token and copy it. Cloudflare shows it only once.",
        "Paste the token here and press Check. Pick your site's zone from the list, then press Connect. Nothing is saved before that.",
      ],
      pick: {
        label: "Zone",
        cantList: "This token can't list your zones (that needs Zone Read), so type your site's Zone ID instead.",
      },
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
      needs: ["Zone Analytics Read"],
    },
    {
      what: "Your zones",
      detail: "their names",
      direction: "read",
      where: "Listed when you press Check, so you can pick one. Not stored.",
      needs: ["Zone Read"],
    },
    {
      what: "Your account's analytics",
      direction: "read",
      where: "Asked for now so later features don't need a new token. Nothing is read with it today.",
      needs: ["Account Analytics Read"],
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
  hooks: { live: "cloudflare.zoneDaily", accounts: "cloudflare.zones" },
  disconnect: "Disconnecting deletes the token YouGrow keeps. Cloudflare has no way for us to cancel it, so delete it in Cloudflare too.",
} satisfies ConnectorManifestInput;

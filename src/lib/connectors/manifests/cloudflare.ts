import type { ConnectorManifestInput } from "../manifest";

/**
 * Cloudflare, with an API token (Connectors 1a). Read only: daily totals for one zone, read live
 * when someone asks, and collected once a day two UTC days later (Connectors 2, ADR-0012), the
 * zone's totals only, kept 90 days.
 *
 * Cloudflare's GraphQL Analytics API answers HTTP 200 even when a query fails, with the reason in
 * an `errors` array, so the handlers (src/lib/connectors/handlers/cloudflare.ts) read that array.
 * The token is checked with a zone query rather than user/tokens/verify, which may refuse account
 * tokens and doesn't prove the token can read this zone. Requests, page views and visits come
 * from end users in the sampled dataset (httpRequestsAdaptiveGroups), which keeps about 31 days on
 * every plan; older days and unique visitors come from the daily dataset (httpRequests1dGroups),
 * and each answer carries the period's totals the dashboard shows (unique visitors always).
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
  // One word, so its tile can't take two first letters: CF, as the approved screens.
  initials: "CF",
  // The cloud from Cloudflare's press kit logo, colours unchanged (public/marks/NOTICE.md).
  icon: { light: "/marks/connectors/cloudflare/icon.png", owner: "Cloudflare, Inc." },
  home: "https://dash.cloudflare.com/",
  summary: "Requests, page views, visits and unique visitors for your site, read from Cloudflare when you ask.",
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
          // Where to find it, whichever way it came to be typed: the screen says why (pick below).
          help: "Find it on your site's Overview page in Cloudflare, in the API box on the right.",
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
      organisationSteps: [
        "In Cloudflare, open My Profile, then API Tokens, or use the link here, which fills in the form for you.",
        "Give the token three permissions: Zone Read, so YouGrow can list your zones; Zone Analytics Read, so it can read their numbers; and Account Analytics Read, asked for now so later features don't need a new token. Nothing reads with it today.",
        "Under Account Resources, include the accounts your brands' sites are in. Under Zone Resources, include every zone your brands use, and only those.",
        "Create the token and copy it. Cloudflare shows it only once.",
        "Paste the token here and press Connect for the organisation. YouGrow lists the zones it reaches, and you give each brand its zone on Settings › Organisation.",
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
    limits: {
      connection: { perMinute: 10, perHour: 120 },
      brand: { perMinute: 20, perHour: 300 },
      // One token serves several brands' zones; Cloudflare counts per token, and a 429 blocks five minutes.
      source: { perMinute: 40, perHour: 600, holds: "connection", holdMinutes: 5 },
    },
    timeoutMs: 10_000,
    maxBytes: 512 * 1024,
  },
  verify: { method: "POST", url: "https://api.cloudflare.com/client/v4/graphql", hook: "cloudflare.zoneProbe" },
  shares: [
    {
      what: "Daily totals for the zone",
      detail: "requests, page views, visits and unique visitors",
      direction: "read",
      where: "Read live when you or Vizzy ask.",
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
      description: "Requests, page views, visits and unique visitors for one zone, a row per day (UTC).",
      shape: "numbers",
      keys: ["day"],
      measures: ["cfRequests", "cfPageViews", "cfVisits", "cfUniqueVisitors"],
      joins: { day: "day" },
      lagDays: 1,
      timeZone: "UTC",
      days: "Days are whole days in UTC, ending yesterday. Set Cloudflare's dashboard to UTC to compare them with its Traffic tab.",
      personal: false,
      liveBy: ["day"],
      collect: {
        by: ["day"],
        rowsPerDay: 500,
        keepDays: 90,
        where: "Collected once a day and kept 90 days in your brand's region; Disconnect deletes them.",
        lag: "Each day is collected 2 days later.",
        keeps: "Each day keeps the zone's totals. Visits by people reach back about 31 days, and older days count all traffic.",
      },
    },
  ],
  uses: ["vizzy.read", "signals.bots"],
  hooks: { live: "cloudflare.zoneDaily", accounts: "cloudflare.zones", collect: "cloudflare.collectDays" },
  disconnect: "Disconnecting deletes the token YouGrow keeps. Cloudflare has no way for us to cancel it, so delete it in Cloudflare too.",
} satisfies ConnectorManifestInput;

import type { ConnectorManifestInput } from "../manifest";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/**
 * Google Search Console, by signing in with Google (Connectors 1b) or by sharing access (1c). Read
 * only: search clicks, impressions, click rate and position for one site, read live when someone
 * asks. Collecting them every day is Connectors 2.
 *
 * - One scope, webmasters.readonly, which Google's console classes as non sensitive.
 * - Sign in gives a token for every site the Google account can see, so an admin then picks one
 *   from sites.list, with unverified sites left out (src/lib/connectors/handlers/searchConsole.ts).
 * - Share access: the admin adds the connection's own Google address as a Restricted user of the
 *   site, and the same hooks read with a 300 second token for that address. Google documents
 *   service accounts as Search Console users only for the Indexing API; the dev check proves it.
 * - Search analytics: POST .../sites/{site}/searchAnalytics/query, grouped by date, page or
 *   query, web results only, the same days and data as Search Console's Performance report:
 *   dataState all (fresh days included), ending on its last complete Pacific day, which a small
 *   date probe finds (metadata.first_incomplete_date). A day's numbers are final about 3 days
 *   later; settledOnly reads final numbers only (dataState final), for Connectors 2. Page rows
 *   keep their host apart and add together only addresses for the same host and path. Dates are
 *   Pacific time. Docs: developers.google.com/webmaster-tools/v1.
 * - Google's docs write these paths under www.googleapis.com/webmasters/v3; the same paths answer
 *   on the API's own host, searchconsole.googleapis.com, the only host this connector may call
 *   besides Google's token endpoint.
 * - Quotas: 1,200 queries a minute per site and per user; the limits here stay far below.
 */
export const searchConsoleManifest = {
  schema: 1,
  id: "search-console",
  name: "Google Search Console",
  // Google's product icon from gstatic.com (public/marks/NOTICE.md).
  icon: { light: "/marks/connectors/search-console/icon.png", owner: "Google LLC" },
  home: "https://search.google.com/search-console",
  summary: "Clicks, impressions and positions in Google Search for your site, read from Search Console when you ask.",
  category: "search",
  publisher: "yougrow",
  switch: "CONNECTOR_SEARCH_CONSOLE_ENABLED",
  connect: [
    { method: "oauth_pkce", client: "google", scopes: [SCOPE] },
    {
      method: "share_access",
      google: "search-console",
      role: "Restricted",
      scopes: [SCOPE],
      steps: [
        "In Search Console, open your site, then Settings, then Users and permissions.",
        "Press Add user, paste the address YouGrow shows, choose Restricted, then press Add.",
        "Back in YouGrow, press Check access, then pick the site.",
      ],
    },
  ],
  api: {
    hosts: ["searchconsole.googleapis.com", "oauth2.googleapis.com"],
    limits: { connection: { perMinute: 20, perHour: 300 }, brand: { perMinute: 40, perHour: 600 } },
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  },
  verify: { method: "GET", url: "https://searchconsole.googleapis.com/webmasters/v3/sites", hook: "searchConsole.siteCheck" },
  shares: [
    {
      what: "Search numbers for the site you pick",
      detail: "clicks, impressions, click rate and position, by day, page or search",
      direction: "read",
      where: "Read live when you or Vizzy ask. Nothing is stored.",
      needs: [SCOPE],
    },
    {
      what: "The sites your Google account, or the address you share with, can see in Search Console",
      direction: "read",
      where: "Listed once so you can pick one. Sites you haven't verified are left out.",
      needs: [SCOPE],
    },
    {
      what: "Anything else",
      direction: "never",
      where: "Nothing is ever written to Google, and your Google password never reaches YouGrow.",
    },
  ],
  produces: [
    {
      stream: "search_performance",
      description: "Clicks, impressions, click rate and average position in Google Search, a row per day, page or search.",
      shape: "numbers",
      keys: ["day", "page", "query", "host"],
      measures: ["searchClicks", "searchImpressions", "searchCtr", "searchPosition"],
      joins: { day: "day", page: "page", query: "topic" },
      lagDays: 3,
      timeZone: "America/Los_Angeles",
      days: "The last 7, 28 or 90 days are the same days as Search Console's own report: complete days in Pacific time, ending on its last complete day, including days that aren't final yet.",
      personal: false,
      liveBy: ["day", "page", "topic"],
      liveFilters: ["page"],
    },
  ],
  uses: ["vizzy.read"],
  hooks: { live: "searchConsole.searchAnalytics", accounts: "searchConsole.sites" },
  disconnect: "Disconnecting deletes the sign in YouGrow keeps. To end access at Google too, remove YouGrow from your Google account's third party connections.",
} satisfies ConnectorManifestInput;

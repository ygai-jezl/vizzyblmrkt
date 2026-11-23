import type { ConnectorManifestInput } from "../manifest";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/**
 * Google Analytics 4 (Connectors 1c), by signing in with Google or by sharing access. Read only:
 * sessions, active users, views and key events for one property, read live when someone asks.
 * Collecting them every day is Connectors 2.
 *
 * - One scope, analytics.readonly, which Google's console classes as sensitive: Sign in goes on in
 *   production only after Google's sensitive scope review, so it has a switch of its own,
 *   CONNECTOR_GA4_SIGNIN_ENABLED, off until then. Share access needs no review.
 * - Share access: the admin adds the connection's own Google address to the property as a Viewer
 *   (Property access management), as Google documents for service accounts.
 * - The picker lists the properties the sign in or address can see through the Admin API's
 *   accountSummaries.list (developers.google.com/analytics/devguides/config/admin/v1).
 * - Live reads: the Data API's properties.runReport (developers.google.com/analytics/devguides/
 *   reporting/data/v1) with totals and returnPropertyQuota, by date, by page (unifiedPagePathScreen,
 *   as the Pages and screens report) or by landing page (landingPage, as the Landing page report),
 *   at most 93 days and 100 rows. A named period goes to Google as its relative dates (28daysAgo
 *   to yesterday), so Google works the days out in the property's time zone, which each answer
 *   names; there is no fixed timeZone here. A day's numbers settle within about 2 days. Each
 *   request spends a few of the property's tokens (200,000 a day for a standard property); the
 *   limits here stay far below.
 * - Hosts: analyticsdata.googleapis.com, analyticsadmin.googleapis.com and Google's token endpoint.
 */
export const ga4Manifest = {
  schema: 1,
  id: "google-analytics",
  name: "Google Analytics 4",
  summary: "Sessions, users, views and key events for your site, read from Google Analytics 4 when you ask.",
  category: "analytics",
  publisher: "yougrow",
  switch: "CONNECTOR_GA4_ENABLED",
  connect: [
    { method: "oauth_pkce", client: "google", scopes: [SCOPE], switch: "CONNECTOR_GA4_SIGNIN_ENABLED" },
    {
      method: "share_access",
      google: "ga4",
      role: "Viewer",
      scopes: [SCOPE],
      steps: [
        "In Google Analytics, open Admin, pick the property, then open Property access management.",
        "Press Add, then Add users. Paste the address YouGrow shows, choose the Viewer role, then press Add.",
        "Back in YouGrow, press Check access, then pick the property.",
      ],
    },
  ],
  api: {
    hosts: ["analyticsdata.googleapis.com", "analyticsadmin.googleapis.com", "oauth2.googleapis.com"],
    limits: { connection: { perMinute: 10, perHour: 120 }, brand: { perMinute: 20, perHour: 240 } },
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  },
  verify: { method: "GET", url: "https://analyticsadmin.googleapis.com/v1beta/accountSummaries", hook: "googleAnalytics.propertyCheck" },
  shares: [
    {
      what: "Traffic numbers for the property you pick",
      detail: "sessions, active users, views and key events, by day, page or landing page",
      direction: "read",
      where: "Read live when you or Vizzy ask. Nothing is stored.",
      needs: [SCOPE],
    },
    {
      what: "The Google Analytics properties your Google account, or the address you share with, can see",
      direction: "read",
      where: "Listed once so you can pick one.",
      needs: [SCOPE],
    },
    {
      what: "Anything else",
      direction: "never",
      where: "Nothing is ever changed in Google Analytics, nothing about a single visitor is read, and your Google password never reaches YouGrow.",
    },
  ],
  produces: [
    {
      stream: "site_traffic",
      description: "Sessions, active users, views and key events from Google Analytics, a row per day, page or landing page.",
      shape: "numbers",
      keys: ["day", "page", "landing"],
      measures: ["ga4Sessions", "ga4ActiveUsers", "ga4Views", "ga4KeyEvents"],
      joins: { day: "day", page: "page", landing: "page" },
      lagDays: 2,
      days: "The last 7, 28 or 90 days end yesterday in the property's own time zone, as Google Analytics reports do. Pages match its Pages and screens report, and landing pages its Landing page report.",
      personal: false,
      liveBy: ["day", "page", "landing"],
      liveFilters: ["page"],
    },
  ],
  uses: ["vizzy.read"],
  hooks: { live: "googleAnalytics.runReport", accounts: "googleAnalytics.properties" },
  disconnect: "Disconnecting deletes the sign in YouGrow keeps. To end access at Google too, remove YouGrow from your Google account's third party connections.",
} satisfies ConnectorManifestInput;

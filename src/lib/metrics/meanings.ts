/**
 * What each number YouGrow gives an agent means: its name, definition, what one count is of
 * (grain), its unit, where it comes from and what to bear in mind. Every number a results tool
 * returns has an entry here (a test checks), so Vizzy and later agents read figures the same way
 * people do. The seed of the semantic layer. Plain words, no dashes (house style).
 */

export interface Meaning {
  name: string;
  definition: string;
  grain: string;
  unit: "count" | "ratio" | "percent" | "date" | "rank";
  source: string;
  caveat?: string;
}

export const MEANINGS = {
  sends: {
    name: "Sends",
    definition: "Emails handed to the email provider for delivery.",
    grain: "one email to one person",
    unit: "count",
    source: "the app's own send records",
  },
  delivered: {
    name: "Delivered",
    definition: "Emails the receiving server accepted: sends less bounces and rejections.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's events",
  },
  people: {
    name: "People reached",
    definition: "Different people sent at least one email in this group.",
    grain: "one person",
    unit: "count",
    source: "the app's own send records",
  },
  deliveryRate: {
    name: "Delivery rate",
    definition: "Emails delivered divided by sends.",
    grain: "a group of emails",
    unit: "ratio",
    source: "the email provider's events",
  },
  uniqueOpens: {
    name: "Unique opens",
    definition: "Emails opened at least once.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's open events",
    caveat: "Some mail apps open every email on the reader's behalf (privacy protection), so opens run high.",
  },
  uniqueClicks: {
    name: "Unique clicks",
    definition: "Emails with at least one link clicked.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's click events",
  },
  openRate: {
    name: "Open rate",
    definition: "Unique opens divided by emails delivered (by sends where delivery isn't known).",
    grain: "a group of emails",
    unit: "ratio",
    source: "unique opens and sends",
    caveat: "Inflated by automatic opens; compare emails with each other, not with other tools.",
  },
  clickRate: {
    name: "Click rate",
    definition: "Unique clicks divided by emails delivered (by sends where delivery isn't known).",
    grain: "a group of emails",
    unit: "ratio",
    source: "unique clicks and sends",
  },
  totalOpens: {
    name: "Total opens",
    definition: "Every time an email was opened, counting repeat opens.",
    grain: "one open",
    unit: "count",
    source: "the email's send record",
    caveat: "Counted only for emails whose events arrived after full detail was turned on.",
  },
  totalClicks: {
    name: "Total clicks",
    definition: "Every link click in the emails, counting repeat clicks.",
    grain: "one click",
    unit: "count",
    source: "the email's send record",
    caveat: "Counted only for emails whose events arrived after full detail was turned on.",
  },
  hardBounces: {
    name: "Hard bounces",
    definition: "Emails that could never be delivered: the address doesn't exist or refuses mail. The address is then suppressed.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's bounce events",
  },
  softBounces: {
    name: "Soft bounces",
    definition: "Emails refused for a passing reason, such as a full mailbox.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's bounce events",
  },
  deferrals: {
    name: "Deferrals",
    definition: "Times delivery was put off by the receiving server and tried again later.",
    grain: "one delivery attempt",
    unit: "count",
    source: "the email's send record",
  },
  complaints: {
    name: "Spam complaints",
    definition: "People who marked the email as spam. The address is then suppressed.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's spam events",
  },
  unsubscribes: {
    name: "Unsubscribes",
    definition: "People who unsubscribed from this email.",
    grain: "one email to one person",
    unit: "count",
    source: "the email provider's unsubscribe events",
  },
  impressions: {
    name: "Impressions",
    definition: "Times the post was shown on screen.",
    grain: "one post",
    unit: "count",
    source: "the social platform's post statistics",
  },
  likes: { name: "Likes", definition: "Likes or reactions on the post.", grain: "one post", unit: "count", source: "the social platform's post statistics" },
  comments: { name: "Comments", definition: "Comments or replies on the post.", grain: "one post", unit: "count", source: "the social platform's post statistics" },
  shares: {
    name: "Shares",
    definition: "Times the post was shared on: reposts plus quotes on X, shares on LinkedIn.",
    grain: "one post",
    unit: "count",
    source: "the social platform's post statistics",
  },
  reposts: { name: "Reposts", definition: "Reposts of an X post, without a comment.", grain: "one post", unit: "count", source: "X post statistics" },
  quotes: { name: "Quotes", definition: "Reposts of an X post with a comment.", grain: "one post", unit: "count", source: "X post statistics" },
  bookmarks: { name: "Bookmarks", definition: "Times an X post was saved.", grain: "one post", unit: "count", source: "X post statistics" },
  clicks: { name: "Clicks", definition: "Clicks on a LinkedIn post's content or link.", grain: "one post", unit: "count", source: "LinkedIn post statistics" },
  engagementRate: {
    name: "Engagement rate",
    definition: "Weighted actions (likes, comments, shares, clicks) divided by impressions.",
    grain: "one post",
    unit: "ratio",
    source: "the post's settled numbers, 7 days after publishing",
    caveat: "Comments and shares count more than likes. Only posts 7 days old or more have it.",
  },
  linkedinEngagement: {
    name: "LinkedIn engagement",
    definition: "LinkedIn's own engagement rate for the post.",
    grain: "one post",
    unit: "ratio",
    source: "LinkedIn post statistics",
  },
  publishedAt: { name: "Published", definition: "When the post went out.", grain: "one post", unit: "date", source: "the post's publish record" },
  posts: { name: "Posts", definition: "Posts published in the period with numbers read.", grain: "one post", unit: "count", source: "the post statistics records" },
  googlePosition: {
    name: "Google position",
    definition: "Where the brand's own page ranks in Google's results for the question, 1 being the top. Null when none of its pages is in the top 10.",
    grain: "one question in one market, on the day it was looked up",
    unit: "rank",
    source: "Google results, through DataForSEO",
    caveat: "One look on one day in one country and language. Results move, so read it as a sign, not a measure.",
  },
  peopleAlsoAsk: {
    name: "People also ask",
    definition: "How many People also ask questions Google showed for the question.",
    grain: "one question in one market",
    unit: "count",
    source: "Google results, through DataForSEO",
  },
  aiOverviewSources: {
    name: "AI Overview sources",
    definition: "How many pages Google's AI Overview cited for the question. 0 when Google showed no AI Overview.",
    grain: "one question in one market",
    unit: "count",
    source: "Google results, through DataForSEO",
  },
  // Connected data (src/lib/connectors). Namespaced by source, because plain clicks and impressions
  // already mean LinkedIn and X post numbers above.
  cfRequests: {
    name: "Cloudflare requests",
    definition:
      "Requests from end users that Cloudflare answered for the site in the day: pages, images, scripts and API calls, from browsers, apps and bots that reach the site directly, not Cloudflare's own subrequests.",
    grain: "one Cloudflare zone on one day (UTC)",
    unit: "count",
    source: "Cloudflare analytics, end user requests (requestSource eyeball), as the dashboard's Traffic tab shows",
    caveat:
      "Counts every file a page loads and every bot, so it runs far above visits and page views. For days further back than Cloudflare keeps end user numbers, it counts all traffic instead, and the answer's notes name those days.",
  },
  cfPageViews: {
    name: "Cloudflare page views",
    definition: "Successful responses to end users with a web page (HTML), rather than a file such as an image or a script.",
    grain: "one Cloudflare zone on one day (UTC)",
    unit: "count",
    source: "Cloudflare analytics, end user requests (requestSource eyeball), as the dashboard's Traffic tab shows",
    caveat:
      "Includes bots that fetch pages, so it runs above what an analytics tag counts. The dashboard shows page views on Pro plans and above. For days further back than Cloudflare keeps end user numbers, it counts all traffic instead.",
  },
  cfVisits: {
    name: "Cloudflare visits",
    definition: "Page views by end users that arrived from another site or a direct link: roughly the start of a visit.",
    grain: "one Cloudflare zone on one day (UTC)",
    unit: "count",
    source: "Cloudflare analytics, sampled end user requests (requestSource eyeball)",
    caveat:
      "Cloudflare samples busy sites, so this is an estimate. It only goes back as far as Cloudflare keeps end user numbers, at least a month, and the dashboard shows visits on Pro plans and above.",
  },
  cfUniqueVisitors: {
    name: "Cloudflare unique visitors",
    definition: "Different IP addresses that sent the site requests in the day, people and bots alike, as the Free plan's dashboard shows.",
    grain: "one Cloudflare zone on one day (UTC)",
    unit: "count",
    source: "Cloudflare analytics, daily zone totals",
    caveat:
      "Counts addresses, not people: several people behind one address count once, and one person on two networks counts twice. Visitors of different days can't be added up into a longer period: the answer's totals give the period's own figure, as the dashboard shows it.",
  },
  // How a connector read its provider's rows, never a number of the provider's own.
  merged: {
    name: "Addresses added together",
    definition: "How many of the provider's rows for the same page on the same host this row adds up, because their addresses differ only by a query string, a fragment or http and https.",
    grain: "one row of a connected read: a page, or a day or search for one page, on one host",
    unit: "count",
    source: "YouGrow's reading of the provider's rows",
    caveat: "Shown only when more than 1. The provider's own report lists those addresses one by one, so its rows for this page add up to this row.",
  },
  // Google Search Console's own numbers for the site, never DataForSEO's googlePosition above.
  searchClicks: {
    name: "Search clicks",
    definition: "Clicks from Google Search results through to the site.",
    grain: "one Search Console site on one day (Pacific time), or one page on one host, one search, or the whole site, over the days read; a read for one page gives a row per host",
    unit: "count",
    source: "Google Search Console, web search results",
    caveat: "Google leaves out rare searches to protect privacy, so clicks by search add up to less than the site's total.",
  },
  searchImpressions: {
    name: "Search impressions",
    definition: "Times a link to the site was shown in Google Search results.",
    grain: "one Search Console site on one day (Pacific time), or one page on one host, one search, or the whole site, over the days read; a read for one page gives a row per host",
    unit: "count",
    source: "Google Search Console, web search results",
    caveat: "By site, one search counts once however many of its pages showed; by page, each page counts.",
  },
  searchCtr: {
    name: "Search click rate",
    definition: "Search clicks divided by search impressions, from 0 to 1.",
    grain: "one Search Console site on one day (Pacific time), or one page on one host, one search, or the whole site, over the days read; a read for one page gives a row per host",
    unit: "ratio",
    source: "Google Search Console, web search results",
  },
  searchPosition: {
    name: "Average search position",
    definition: "The average of the site's highest place in Google Search results, 1 being the top.",
    grain: "one Search Console site on one day (Pacific time), or one page on one host, one search, or the whole site, over the days read; a read for one page gives a row per host",
    unit: "rank",
    source: "Google Search Console, web search results",
    caveat: "An average over every search that showed the site, so it moves with which searches showed it, not only with rank.",
  },
  // Google Analytics 4's own numbers for one property, read live through its Data API.
  ga4Sessions: {
    name: "Analytics sessions",
    definition: "Visits that began on the site or app, as Google Analytics counts them (its session_start event).",
    grain: "one Google Analytics property on one day (the property's time zone), or one landing page over the days read",
    unit: "count",
    source: "Google Analytics 4, Data API",
    caveat: "By landing page, each visit counts once, on the page where it began, as the Landing page report shows. Pages and screens rows, and a read by day for one page, don't have sessions: read one page's sessions by landing page.",
  },
  ga4ActiveUsers: {
    name: "Analytics active users",
    definition: "Different people who were active on the site or app, as Google Analytics tells them apart (by browser or device).",
    grain: "one Google Analytics property, or one page, on one day (the property's time zone), or one page or landing page over the days read",
    unit: "count",
    source: "Google Analytics 4, Data API",
    caveat:
      "An estimate, and one person on two devices counts twice. Users of different days or pages can't be added up: the answer's totals count each person once for the whole period.",
  },
  ga4Views: {
    name: "Analytics views",
    definition: "Web pages and app screens viewed, each repeat view counted.",
    grain: "one Google Analytics property, or one page, on one day (the property's time zone), or one page over the days read",
    unit: "count",
    source: "Google Analytics 4, Data API",
    caveat: "Counts only what the Analytics tag saw, so it runs below Cloudflare page views, which include bots and visitors who block the tag.",
  },
  ga4KeyEvents: {
    name: "Analytics key events",
    definition: "Times something the property marks as a key event happened, such as a sign up or a purchase.",
    grain: "one Google Analytics property, or one page, on one day (the property's time zone), or one page or landing page over the days read",
    unit: "count",
    source: "Google Analytics 4, Data API",
    caveat: "Which events count is set in the property, and marking a new one counts only from then on.",
  },
  // How YouGrow kept a connected source's numbers (Connectors 2, collected numbers), never a number
  // of the provider's own.
  rowsDropped: {
    name: "Rows left out",
    definition:
      "Rows of collected numbers this answer doesn't list: those past the number of rows asked for, and those the collected days didn't keep, as each day keeps only its top 500 rows of each grouping.",
    grain: "one answer from collected numbers",
    unit: "count",
    source: "YouGrow's collected numbers",
    caveat:
      "The rows listed are the top ones, so never say the others had none. When a tool listed more rows than YouGrow fetched for a day, more were left out than this counts.",
  },
  // What collected numbers suggest (Connectors 2 group 4): Search Console's searches mapped to the
  // brand map, never a number of Google's own.
  nearbySearches: {
    name: "Nearby searches",
    definition: "Different searches, among the site's top 100 in Search Console over the days read, whose nearest decided brand map subject is this one.",
    grain: "one brand map subject over the days read (Pacific time)",
    unit: "count",
    source: "YouGrow's reading of Google Search Console's searches against the brand map",
    caveat: "Matched by meaning, so a search can sit near a subject without asking its exact question. Only the top 100 searches are matched.",
  },
  lagDays: {
    name: "Days to settle",
    definition: "How many days after a day the tool usually takes to finish that day's numbers.",
    grain: "one stream of a connected tool",
    unit: "count",
    source: "the connector's manifest",
    caveat: "A usual delay, not a promise: the answer's period says which days are collected and how far they are final.",
  },
  usedThisMonth: {
    name: "Used this month",
    definition: "How much of a paid resource or costly feature the brand used since the 1st of the month: web searches for research, AI model tokens, images, Google lookups, competitor articles read or autopilot drafts.",
    grain: "one brand (or, under organisation, all its brands) in one calendar month, UTC; by feature or by model where listed",
    unit: "count",
    source: "the usage meter, and each feature's own records for the older counters",
    caveat: "AI model use counts tokens, not calls, and leaves out the Memory Bank's own model and the browser voice chat.",
  },
  monthlyLimit: {
    name: "Monthly limit",
    definition: "The most the brand may use in a calendar month, from its own limit, its plan or this copy of YouGrow; null means no limit.",
    grain: "one brand in one calendar month",
    unit: "count",
    source: "the brand's plan and settings (src/lib/plans/limits.ts)",
  },
  leftThisMonth: {
    name: "Left this month",
    definition: "Monthly limit less what was used this month; null when there is no limit.",
    grain: "one brand in one calendar month",
    unit: "count",
    source: "worked out from the two numbers above",
    caveat: "Calls made at the same moment can go a little past a limit.",
  },
} as const satisfies Record<string, Meaning>;

export type MeaningKey = keyof typeof MEANINGS;

/** The meanings of the given keys, for a response. */
export function meaningsOf(keys: Iterable<string>): Partial<Record<MeaningKey, Meaning>> {
  const out: Partial<Record<MeaningKey, Meaning>> = {};
  for (const k of keys) if (k in MEANINGS) out[k as MeaningKey] = MEANINGS[k as MeaningKey];
  return out;
}

/** Every number key in a response (nested), for meaningsOf and the contract test. */
export function numberKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) numberKeys(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number") out.add(k);
      else numberKeys(v, out);
    }
  }
  return out;
}

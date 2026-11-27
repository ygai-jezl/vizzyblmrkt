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
  /** score: a number on a scale of its own, such as sentiment from -100 to +100; it never adds up. */
  unit: "count" | "ratio" | "percent" | "date" | "rank" | "score";
  source: string;
  caveat?: string;
  /**
   * Which way is better, for the learning loops (src/lib/loops/registry.ts). Set on every
   * meaning a loop names as its check, guard or result.
   */
  better?: "higher" | "lower";
  /**
   * What kind of number it is, for the learning loops: taste (what people did with what YouGrow
   * made), effort (the work it took), use (whether it was used at all) or result (what it led to).
   * A loop's guard never shares its check's family.
   */
  family?: "taste" | "effort" | "use" | "result";
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
    better: "higher",
    family: "result",
  },
  clickRate: {
    name: "Click rate",
    definition: "Unique clicks divided by emails delivered (by sends where delivery isn't known).",
    grain: "a group of emails",
    unit: "ratio",
    source: "unique clicks and sends",
    better: "higher",
    family: "result",
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
    better: "higher",
    family: "result",
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
    better: "higher",
    family: "result",
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
  // AI answers (signals.ai_answers, ADR-0019): how a brand shows up in the answers of AI engines
  // such as ChatGPT, Claude, Gemini and Perplexity, as an AI answers tool that asks them a brand's
  // monitored prompts reports it. Namespaced, because plain mentions and citations mean other things.
  aiShareOfVoice: {
    name: "AI share of voice",
    definition: "Of all the times the AI answers to the brand's monitored prompts named a brand in its category, the share that named this brand, from 0 to 100.",
    grain: "one brand on one day (UTC), across the monitored prompts and AI engines its tool asked that day",
    unit: "percent",
    source: "An AI answers tool connected through its MCP server, from the AI answers it collected that day",
    caveat: "Moves with which prompts are monitored and which engines answered that day, so compare days with the same prompts. A share for a longer period is never the days added up.",
    better: "higher",
    family: "result",
  },
  aiMentions: {
    name: "AI mentions",
    definition: "Times the AI answers to the brand's monitored prompts named the brand in the day.",
    grain: "one brand on one day (UTC), across the monitored prompts and AI engines its tool asked that day",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, from the AI answers it collected that day",
    caveat: "More monitored prompts or engines mean more answers to be named in, so a rise can come from asking more.",
  },
  aiRank: {
    name: "AI rank",
    definition: "Where the brand stood among the brands the AI answers named, 1 being named most.",
    grain: "one brand on one day (UTC), across the monitored prompts and AI engines its tool asked that day",
    unit: "rank",
    source: "An AI answers tool connected through its MCP server, from the AI answers it collected that day",
    caveat: "Empty on a day the answers didn't name the brand. A brand can rank 2 with a small share when one other brand is named far more.",
  },
  aiSentiment: {
    name: "AI sentiment",
    definition: "How favourably the AI answers spoke of the brand, from -100 (all negative) to +100 (all positive).",
    grain: "one brand on one day (UTC), across the answers that named it",
    unit: "score",
    source: "An AI answers tool connected through its MCP server, scored from the answers' words",
    caveat: "Scored by a model reading the answers, so treat small moves as noise. Empty on a day the answers didn't name the brand.",
  },
  promptEngines: {
    name: "Prompt engines",
    definition: "Different AI engines, such as ChatGPT, Claude and Perplexity, whose answers to one monitored prompt its tool has collected.",
    grain: "one monitored prompt, over everything its tool has collected for it",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, the engines it asked the prompt",
    caveat: "Counts the engines the tool asks, which the brand's plan with it may limit, not every engine that exists.",
  },
  promptBrandMentions: {
    name: "Prompt brand mentions",
    definition: "Times the AI answers to one monitored prompt named the brand, across every engine and every time it was asked.",
    grain: "one monitored prompt, over everything its tool has collected for it",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, the prompt's own totals",
    caveat: "A total since the prompt was first monitored, not for the days asked, so a prompt monitored longer has had more chances.",
  },
  promptCitations: {
    name: "Prompt citations",
    definition: "Links the AI answers to one monitored prompt gave as their sources, to any site, across every engine and every time it was asked.",
    grain: "one monitored prompt, over everything its tool has collected for it",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, the prompt's own totals",
    caveat: "Counts every site cited, the brand's own and everyone else's: a prompt with many citations is one whose answers lean on sources.",
  },
  promptCompetitors: {
    name: "Prompt competitors",
    definition: "Different competitor brands the AI answers to one monitored prompt named.",
    grain: "one monitored prompt, over everything its tool has collected for it",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, the prompt's own totals",
  },
  aiCitations: {
    name: "AI citations of a page",
    definition: "Times AI answers gave this page, or the page asked about, as a source: for one prompt in a read by prompt, or across every monitored prompt in a read by page.",
    grain: "one page, or one page in one monitored prompt's answers, over everything its tool has collected",
    unit: "count",
    source: "An AI answers tool connected through its MCP server, from the citations in the answers it collected",
    caveat: "Only the answers to the brand's monitored prompts count, and the tool keeps only the top pages of each prompt, so the long tail is cut.",
  },
  aiCitationShare: {
    name: "AI citation share",
    definition: "This page's share of every citation in the AI answers to the brand's monitored prompts, from 0 to 1.",
    grain: "one page, over everything its tool has collected",
    unit: "ratio",
    source: "An AI answers tool connected through its MCP server, from the citations in the answers it collected",
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
    definition: "How much of a paid resource or costly feature the brand used since the 1st of the month, such as web searches for research, AI model tokens, images, Google lookups, competitor articles read or autopilot drafts. Each row says what it counts.",
    grain: "one brand (or, under organisation, all its brands) in one calendar month, UTC; by feature or by model where listed",
    unit: "count",
    source: "the usage meter, and each feature's own records for the older counters",
    caveat: "AI model use counts tokens, not calls, and leaves out the Memory Bank's own model and the voice chat on waitlist pages.",
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
  articlesDue: {
    name: "Articles due a refresh",
    definition: "Live blog articles past their refresh clock, or with a strong reason to look again: falling Google clicks, a dead link or an old figure.",
    grain: "one live blog article",
    unit: "count",
    source: "the freshness watch, which looks at each live article once a day",
    caveat: "As of the watch's last look (lookedAt), not this moment.",
  },
  articlesReviewSoon: {
    name: "Articles to review soon",
    definition: "Live blog articles within 5 days of their refresh clock, or with a weaker reason to look again, such as being just off page one or an old source.",
    grain: "one live blog article",
    unit: "count",
    source: "the freshness watch, which looks at each live article once a day",
  },
  articlesFresh: {
    name: "Fresh articles",
    definition: "Live blog articles with no reason to look again yet.",
    grain: "one live blog article",
    unit: "count",
    source: "the freshness watch, which looks at each live article once a day",
  },
  clockDays: {
    name: "Refresh clock",
    definition: "Days a live article goes, from when it went live, was last updated or was last checked, before it is due a refresh: 20, 30 or 45.",
    grain: "one live blog article (or, under byClock, one clock)",
    unit: "count",
    source: "the brand's refresh clock setting; in the clock test each new live article gets one of the three at random",
  },
  liveArticles: {
    name: "Live articles on this clock",
    definition: "Live blog articles that have this refresh clock.",
    grain: "one live blog article",
    unit: "count",
    source: "the freshness watch",
  },
  refreshes: {
    name: "Refresh reviews",
    definition: "Refresh reviews decided on this clock: changes applied, nothing worth changing, or every change dismissed.",
    grain: "one refresh review of a live blog article",
    unit: "count",
    source: "the brand's refresh records, one per review",
    caveat: "Reviews stopped or failed are left out.",
  },
  nothingShare: {
    name: "Share that changed nothing",
    definition: "Of the refresh reviews on this clock, the share that changed nothing: the review found nothing worth changing, or a person dismissed every change.",
    grain: "one clock",
    unit: "ratio",
    source: "the brand's refresh records",
    caveat: "A high share means the clock is probably too short: articles are reviewed before there is much to change.",
  },
  proposedAvg: {
    name: "Changes proposed, on average",
    definition: "How many changes a refresh review on this clock proposed, on average.",
    grain: "one refresh review",
    unit: "count",
    source: "the brand's refresh records",
  },
  acceptedAvg: {
    name: "Changes accepted, on average",
    definition: "How many proposed changes a person applied, on average per refresh review on this clock.",
    grain: "one refresh review",
    unit: "count",
    source: "the brand's refresh records",
  },
  costCentsAvg: {
    name: "Cost of a review, on average",
    definition: "What a refresh review on this clock cost Google on average, in US cents: its web searches and model use.",
    grain: "one refresh review",
    unit: "count",
    source: "the usage meter's counts for each review, at Google's list prices from January 2027",
    caveat: "An estimate. Prices are list prices; the brand's own bill may differ.",
  },
  clickLift: {
    name: "Click change after a refresh",
    definition: "Google clicks on the article's page in the 28 days after a refresh against the 28 days before, beside the same change for the brand's articles left alone: 0.12 means 12% better than those. The mean over the clock's refreshes; clickLiftRange gives its 95% range.",
    grain: "one clock, from its refreshes with results",
    unit: "ratio",
    source: "Search Console's daily page numbers, kept 90 days",
    caveat: "Shown only once the clock has 8 refreshes with results. A range that crosses 0 says the clock may make no difference.",
  },
  resultsNeeded: {
    name: "Results still needed",
    definition: "How many more refreshes with 28 days of Search Console results this clock needs before its click change shows.",
    grain: "one clock",
    unit: "count",
    source: "the brand's refresh records",
  },
  withResults: {
    name: "Refreshes with results",
    definition: "Applied refreshes on this clock that have their 28 days of Search Console results.",
    grain: "one refresh review",
    unit: "count",
    source: "the brand's refresh records",
  },
  clicksPerDollar: {
    name: "Clicks gained per dollar",
    definition: "Google clicks a refresh on this clock gained (clicks before times the click change), per dollar its review cost, on average.",
    grain: "one clock",
    unit: "ratio",
    source: "the brand's refresh records and Search Console",
    caveat: "Only once the clock has 8 refreshes with results; the readout suggests the clock with the most.",
  },
  draftWordsChanged: {
    name: "Words changed from the AI draft",
    definition: "How many words a person changed in a piece before approving it, against the copy the writer made: for each run of change, the larger of the words taken out and put in.",
    grain: "one approval of one piece of copy",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
    caveat: "Edits made in the brand's own site or CMS after copying are not seen. Edits Vizzy made in Edit mode count as the person's.",
    better: "lower",
    family: "taste",
  },
  draftWordsChangedShare: {
    name: "Share of the AI draft changed",
    definition: "Words a person changed before approving a piece, over the words in the AI draft, from 0 to 1.",
    grain: "one approval of one piece of copy",
    unit: "ratio",
    source: "the piece's AI original, kept beside the copy a person edits",
    caveat: "A section a person added counts its words as changed, so a short draft with a long addition reads as 1.",
    better: "lower",
    family: "taste",
  },
  draftSectionsAdded: {
    name: "Sections added to the AI draft",
    definition: "Section headings in the approved article that the AI draft didn't have.",
    grain: "one approval of one article",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
    caveat: "A renamed heading counts as one section cut and one added.",
  },
  draftSectionsCut: {
    name: "Sections cut from the AI draft",
    definition: "Section headings in the AI draft that the approved article doesn't have.",
    grain: "one approval of one article",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
    caveat: "A renamed heading counts as one section cut and one added.",
  },
  draftFiguresChanged: {
    name: "Figures changed from the AI draft",
    definition: "Figures (amounts, percentages, counts from 10 up) added or taken out between the AI draft and the approved copy.",
    grain: "one approval of one piece of copy",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
  },
  draftLinksChanged: {
    name: "Links changed from the AI draft",
    definition: "Links added or taken out between the AI draft and the approved copy.",
    grain: "one approval of one piece of copy",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
  },
  draftRegenerations: {
    name: "Times written again",
    definition: "How many times a piece was written again (Regenerate, or a refresh applied) before this approval.",
    grain: "one approval of one piece of copy",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
    better: "lower",
    family: "effort",
  },
  draftMinutesToApprove: {
    name: "Minutes to approve",
    definition: "Minutes from the AI draft being written to a person approving the piece.",
    grain: "one approval of one piece of copy",
    unit: "count",
    source: "the piece's AI original, kept beside the copy a person edits",
    caveat: "Time waiting counts the same as time editing.",
  },
  repeatSimilarity: {
    name: "Closeness in meaning",
    definition: "How close two questions are in meaning, from 0 to 1: a brand map question and what a live article answers, or the main questions of two live articles. 0.95 or more is the same question reworded; 0.88 or more is close.",
    grain: "one question against one article",
    unit: "ratio",
    source: "both texts embedded with Vertex AI's text embedding model",
    caveat: "A score, not a judgement: a person can Unlink a match or write it anyway.",
  },
  questionsLeftOut: {
    name: "Questions left out",
    definition: "Brand map questions Next up didn't offer because an article being written already covers them.",
    grain: "one Next up pick for one brand",
    unit: "count",
    source: "Next up, matching questions by meaning against the brand's articles",
  },
  questionsLinkedByMeaning: {
    name: "Questions linked by meaning",
    definition: "Brand map questions Next up found a live article already answers, linked so they count as answered.",
    grain: "one Next up pick for one brand",
    unit: "count",
    source: "Next up, matching questions by meaning against the brand's articles",
    caveat: "A person can Unlink one on the brand map.",
  },
  focusQuestions: {
    name: "Questions in a focus situation",
    definition: "The decided brand map questions people in this focus buying situation ask.",
    grain: "one buying situation in the brand strategy",
    unit: "count",
    source: "the brand map's buying situation, counted again when its questions change",
  },
  focusLiveArticles: {
    name: "Answered by a live article",
    definition: "Of the questions in this focus situation, how many a live article of the brand's answers.",
    grain: "one buying situation in the brand strategy",
    unit: "count",
    source: "the brand map's buying situation and the brand's pages",
    caveat: "Counted when the situation was last opened or its questions changed, so it can trail an article that just went live.",
  },
  theirArticles: {
    name: "Their articles on a focus situation",
    definition: "Articles the brand's watched competitors published on this focus buying situation in the last 90 days.",
    grain: "one focus buying situation in the brand strategy",
    unit: "count",
    source: "the weekly strategy check, from the competitors' articles YouGrow read in full",
    caveat: "Counted when the check last looked, about once a week, from the articles read so far.",
  },
  theirNewArticles: {
    name: "Their new articles since",
    definition: "Of their articles on this focus buying situation, the ones published on or after the day the check counts from: the approval, a dismissal, or a row that closed itself.",
    grain: "one focus buying situation in the brand strategy",
    unit: "count",
    source: "the weekly strategy check, from the competitors' articles YouGrow read in full",
    caveat: "An article with no publish date never counts as new.",
  },
  competitorArticles: {
    name: "One competitor's articles on it",
    definition: "Articles one watched competitor published on this focus buying situation in the last 90 days.",
    grain: "one competitor on one focus buying situation",
    unit: "count",
    source: "the weekly strategy check, from the competitors' articles YouGrow read in full",
  },
  namingArticles: {
    name: "Their articles naming it",
    definition: "Articles the watched competitors published in the last 90 days that name this alternative on the brand map, which the brand doesn't watch.",
    grain: "one alternative on the brand map",
    unit: "count",
    source: "the weekly strategy check, from the competitors' articles YouGrow read in full",
    caveat: "Counts only articles read from their own pages, and only names already on the brand map.",
  },
  foundTimes: {
    name: "Times the finder named it",
    definition: "How many of the competitor finder's answers named this competitor: up to 3 from a full run, 1 from a quick one, 0 for one the gap search, the brand's watch list or a person added.",
    grain: "one competitor in the brand strategy",
    unit: "count",
    source: "the competitor finder's search-grounded answers",
    caveat: "Counted from the latest run only.",
  },
  slotCount: {
    name: "Slots",
    definition: "The articles the content plan holds: each one or more decided brand map questions that ask the same thing, merged by meaning.",
    grain: "one content plan, or one pillar in it",
    unit: "count",
    source: "the brand's content plan, made from its brand map when a person last pressed Make the plan",
  },
  liveSlots: {
    name: "Slots answered live",
    definition: "Of the slots, how many a live article of the brand's already answers.",
    grain: "one content plan, or one pillar in it",
    unit: "count",
    source: "the brand's pages and the links Next up keeps, when the plan was made",
    caveat: "Counted when the plan was made, so it can trail an article that went live since.",
  },
  openSlots: {
    name: "Slots to write",
    definition: "Of the slots, how many no article answers or is being written for, not counting tool pages and videos.",
    grain: "one content plan, or one pillar in it",
    unit: "count",
    source: "the brand's pages, when the plan was made",
    caveat: "Counted when the plan was made.",
  },
  questionsInPlan: {
    name: "Questions read",
    definition: "The decided brand map questions the plan was made from.",
    grain: "one content plan",
    unit: "count",
    source: "the brand map, when the plan was made",
  },
  questionsInSlot: {
    name: "Questions in the slot",
    definition: "The decided brand map questions merged into this one article.",
    grain: "one slot of the content plan",
    unit: "count",
    source: "the content plan, grouped by meaning and checked against Google's results where the brand looks them up",
  },
  roadmapSharePercent: {
    name: "Share of Next up from the plan",
    definition: "Of Next up's picks, the share that come from the plan's roadmap; the rest are free for new questions and news.",
    grain: "one content plan",
    unit: "percent",
    source: "the content plan's rules",
  },
  articlesPerWeek: {
    name: "Roadmap entries a week",
    definition: "How many entries each week of the roadmap holds: the autopilot's articles a week when the plan was made.",
    grain: "one content plan",
    unit: "count",
    source: "the brand's autopilot settings",
  },
  refreshSharePercent: {
    name: "Share that fixes a live article",
    definition: "Of the roadmap's entries, the share kept for refreshing or combining live articles.",
    grain: "one content plan",
    unit: "percent",
    source: "the brand's refresh share of Next up",
  },
  targetPercent: {
    name: "Funnel target",
    definition: "The share of the roadmap's new articles meant for this stage of the buying journey (learn, consider or choose).",
    grain: "one stage of one content plan",
    unit: "percent",
    source: "the content plan's funnel mix",
  },
  questionsPercent: {
    name: "Questions at this stage",
    definition: "The share of the brand's decided questions at this stage of the buying journey, from their intents.",
    grain: "one stage of one content plan",
    unit: "percent",
    source: "the brand map, when the plan was made",
  },
  roadmapPercent: {
    name: "Roadmap at this stage",
    definition: "The share of the roadmap's new articles at this stage of the buying journey, to set against the funnel target.",
    grain: "one stage of one content plan",
    unit: "percent",
    source: "the content plan's roadmap",
  },
  fitScore: {
    name: "Fit",
    definition: "A score from 0 to 100: the share of the slot's questions on the approved brand strategy's focus situations.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "the content plan and the approved brand strategy",
  },
  demandScore: {
    name: "Demand",
    definition: "A score from 0 to 100: Search Console impressions for the slot's questions against the brand's busiest slot, or how many People also ask questions Google showed for it.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "Search Console where it is connected and shared, and Google's results the brand looked up",
  },
  gapScore: {
    name: "Gap",
    definition: "A score from 0 to 100: competitors wrote on it in the last 90 days and nothing live of the brand's answers it. 0 when a live article answers it.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "competitor articles and the brand's pages",
  },
  depthScore: {
    name: "Depth",
    definition: "A score from 0 to 100: the share of its pillar's slots already answered live, so it fills a pillar the brand has started.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "the content plan",
  },
  balanceScore: {
    name: "Stage balance",
    definition: "A score from 0 to 100: higher when the brand's live articles are short of this stage against the funnel mix.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "the content plan's funnel mix and the brand's live articles",
  },
  slotScore: {
    name: "Slot score",
    definition: "A score from 0 to 100 weighing fit most, then demand, gap, stage balance and depth: how the roadmap orders slots within a pillar.",
    grain: "one slot of the content plan",
    unit: "percent",
    source: "the content plan, worked out in code",
  },
  changesProposed: {
    name: "Changes proposed",
    definition: "The changes a refresh review proposes for a person to apply, each tied to what it found.",
    grain: "one proposed change to a live blog article",
    unit: "count",
    source: "the article's refresh review",
  },
  reviewsLeftThisMonth: {
    name: "Refresh reviews left this month",
    definition: "How many more refresh reviews the brand may start this calendar month.",
    grain: "one refresh review",
    unit: "count",
    source: "the brand's plan or grant, and its refresh records this month",
  },
  viewPeople: {
    name: "People in a view",
    definition: "People in the brand's People list who match a saved view's filters now.",
    grain: "one person",
    unit: "count",
    source: "the brand's People list, checked when asked (get_view_counts)",
    caveat:
      "A view reads at most 5,000 people, the most recently active of the group it starts from (Everyone when it has none): when `capped` is true there are at least this many.",
  },
  // The investor and funding board on People (RAISE_PIPELINE_ENABLED), for Vizzy's get_raise_pipeline.
  pipelinePeople: {
    name: "People on the board",
    definition: "People with a Stage now: everyone on the brand's investor or funding board.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
  },
  stagePeople: {
    name: "People in a stage",
    definition: "People in one stage of the board now.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
  },
  passedPeople: {
    name: "People who passed",
    definition: "People in Passed now.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
  },
  reasonPasses: {
    name: "Passes for a reason",
    definition: "People in Passed with this Pass reason.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
    caveat: "Reads the 500 most recently active people in each stage: when capped is true there are at least this many.",
  },
  noReasonPasses: {
    name: "Passes with no reason",
    definition: "People in Passed with no reason, or No reason given.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
    caveat: "Reads the 500 most recently active people in each stage: when capped is true there are at least this many.",
  },
  quietPeople: {
    name: "Quiet people",
    definition: "People in a stage in play whose Last touch is 14 or more days ago, in the brand's time zone.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
    caveat: "Reads the 500 most recently active people in each stage: when capped is true there are at least this many.",
  },
  nextStepPastPeople: {
    name: "Past their next step",
    definition: "People not yet in Money in, Funds in or Passed whose Next step date is before today, in the brand's time zone.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
    caveat: "Reads the 500 most recently active people in each stage: when capped is true there are at least this many.",
  },
  overduePeople: {
    name: "Overdue people",
    definition: "People quiet for 14 days or past their next step date, each counted once.",
    grain: "one person",
    unit: "count",
    source: "the brand's People fields, checked when asked (get_raise_pipeline)",
    caveat: "Reads the 500 most recently active people in each stage: when capped is true there are at least this many.",
  },
  openFollowUps: {
    name: "Open follow-ups",
    definition: "Follow-ups from the board in Review that nobody has decided yet.",
    grain: "one follow-up",
    unit: "count",
    source: "the brand's follow-ups in Review, checked when asked (get_raise_pipeline)",
  },
  quietAfterDays: {
    name: "Days before a follow-up",
    definition: "The days without a touch before a follow-up comes up: YouGrow's rule.",
    grain: "a day",
    unit: "count",
    source: "YouGrow's follow-up rule, the same for every brand for now",
  },
  // What people did with what YouGrow made, for the learning loops (ADR-0017). No tool returns
  // these yet: the loops count them once they stamp what YouGrow makes.
  editShare: {
    name: "Edit share",
    definition: "Of the things YouGrow made, the share a person changed before using them.",
    grain: "one kind of thing YouGrow made, in one place, over a period",
    unit: "ratio",
    source: "YouGrow's own counts of what people did with what it made",
    caveat: "Nothing counts it yet. A small edit and a rewrite count the same.",
    better: "lower",
    family: "taste",
  },
  keptShare: {
    name: "Kept share",
    definition: "Of the things YouGrow made, the share used with no change at all.",
    grain: "one kind of thing YouGrow made, in one place, over a period",
    unit: "ratio",
    source: "YouGrow's own counts of what people did with what it made",
    caveat: "Nothing counts it yet. Kept is not the same as good: something kept unread still counts.",
    better: "higher",
    family: "taste",
  },
  declineShare: {
    name: "Declined share",
    definition: "Of the suggestions YouGrow made, the share a person dismissed or declined.",
    grain: "one kind of suggestion, in one place, over a period",
    unit: "ratio",
    source: "YouGrow's own counts of decisions in Review and where the suggestion was shown",
    caveat: "Nothing counts it yet.",
    better: "lower",
    family: "taste",
  },
  likedShare: {
    name: "Liked share",
    definition: "Of the images YouGrow made that a person voted on, the share voted up.",
    grain: "one image style, in one place, over a period",
    unit: "ratio",
    source: "the thumbs and ratings people give images in the brand kit",
    caveat: "Nothing counts it yet. Only images someone voted on count, so a few votes can swing it.",
    better: "higher",
    family: "taste",
  },
  unusedShare: {
    name: "Unused share",
    definition: "Of the things YouGrow made, the share still not used 14 days after they were made.",
    grain: "one kind of thing YouGrow made, in one place, over a period",
    unit: "ratio",
    source: "YouGrow's own counts of what people did with what it made",
    caveat: "Nothing counts it yet. Known only 14 days after each thing is made.",
    better: "lower",
    family: "use",
  },
  remadeShare: {
    name: "Remade share",
    definition: "Of the things YouGrow made, the share a person asked it to make again.",
    grain: "one kind of thing YouGrow made, in one place, over a period",
    unit: "ratio",
    source: "YouGrow's own counts of what people did with what it made",
    caveat: "Nothing counts it yet.",
    better: "lower",
    family: "use",
  },
} as const satisfies Record<string, Meaning>;

export type MeaningKey = keyof typeof MEANINGS;

/**
 * A meaning as an answer gives it: everything but better and family, which only the learning
 * loops read for now, so answers stay as they were until a loop's numbers reach an agent.
 */
export function shownMeaning(m: Meaning): Meaning {
  const { better, family, ...shown } = m;
  return shown;
}

/** The meanings of the given keys, for a response. */
export function meaningsOf(keys: Iterable<string>): Partial<Record<MeaningKey, Meaning>> {
  const out: Partial<Record<MeaningKey, Meaning>> = {};
  for (const k of keys) if (k in MEANINGS) out[k as MeaningKey] = shownMeaning(MEANINGS[k as MeaningKey]);
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

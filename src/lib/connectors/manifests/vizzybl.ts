import type { ConnectorManifestInput } from "../manifest";

/**
 * Vizzybl, an AI answers tool (ADR-0019): how a brand shows up in the answers of AI engines
 * (ChatGPT, Claude, Gemini, Perplexity, Grok, Copilot, Google AI Overviews and AI Mode), read from
 * Vizzybl's own remote MCP server with an API key. The first data only connector: this file is the
 * whole connector, and the one MCP engine (src/lib/connectors/mcp) runs it.
 *
 * - One key reads one Vizzybl brand, so the key names its account: the verify tool, get_brand,
 *   gives the brand's main domain (kept as the connection's account) and name (its label).
 * - Reads only. YouGrow never runs an audit, adds a prompt or scrapes one (run_audit,
 *   create_prompts, scrape_prompt): those spend the brand's Vizzybl credits. Its steps ask for read
 *   scopes only, and write scopes are never covered by read:*.
 * - The tools' names and arguments are the server's own (get_visibility_history: startDate,
 *   endDate, limit, cursor; list_prompts: status, limit; find_prompts_citing: url or domain;
 *   get_citation_stats: startDate, endDate). Each answers with the JSON of the public API's data,
 *   and a list with its pagination, so rows sit under `data` (vizzybl.ai/api/v1 reference).
 * - Limits: Vizzybl allows about 60 calls a minute and 1,000 an hour per key, and about 20 a minute
 *   and 400 an hour for its citation tools. Safe fetch counts every request: a read is three
 *   (initialize, initialized, the tool call), a check four (tools/list too), and a server that
 *   names a session adds a fifth to close it (Vizzybl's names none). Sized on the most, five, the
 *   limits below keep tool calls under the citation tools' rate: at least 11 a minute and 220 an
 *   hour, at most 18 and 366 when no session is named.
 * - The check:instance allow entry for this file says why it names vizzybl.ai: it is this vendor
 *   connector's own API host (decision 12).
 */
const SERVER = "https://mcp.vizzybl.ai/v1/mcp";

// Typed rather than `satisfies`: its streams' keys differ, which a literal type can't hold in one list.
export const vizzyblManifest: ConnectorManifestInput = {
  schema: 1,
  id: "vizzybl",
  name: "Vizzybl",
  // One word, so its tile can't take two first letters.
  initials: "VZ",
  // A plain letter V on Vizzybl's indigo, drawn for YouGrow (public/marks/NOTICE.md).
  icon: { light: "/marks/connectors/vizzybl/icon.svg", owner: "Vizzybl" },
  home: "https://vizzybl.ai/",
  summary: "How your brand shows up in AI answers: your share of voice each day, your monitored prompts and the pages AI answers cite.",
  category: "search",
  publisher: "yougrow",
  switch: "CONNECTOR_VIZZYBL_ENABLED",
  connect: [
    {
      method: "mcp",
      url: SERVER,
      auth: {
        kind: "bearer",
        field: {
          key: "apiKey",
          label: "API key",
          secret: true,
          help: "A key with read scopes only. YouGrow seals it and never shows it again.",
          pattern: "^vzbl_live_[A-Za-z0-9_-]+$",
          minLength: 20,
          maxLength: 200,
        },
      },
      verify: { tool: "get_brand", account: "primaryDomain", label: "brandName" },
      permissions: ["read:brand", "read:visibility", "read:prompts", "read:citations"],
      steps: [
        "In Vizzybl, open Settings, then API Keys. API keys come with Vizzybl's Ultra and Enterprise plans.",
        "Make a key with the scope read:*, or with read:brand, read:visibility, read:prompts and read:citations. Leave every write scope off.",
        "Copy the key. It starts with vzbl_live_, and Vizzybl shows it only once.",
        "Paste the key here and press Connect. YouGrow checks it with Vizzybl and reads which brand it belongs to. Nothing is saved before that.",
      ],
    },
  ],
  api: {
    hosts: ["mcp.vizzybl.ai"],
    // Requests, not tool calls: 3 to 5 each (see above), so 11 to 18 tool calls a minute and 220 to 366 an hour.
    limits: {
      connection: { perMinute: 55, perHour: 1100 },
      brand: { perMinute: 55, perHour: 1100 },
    },
    timeoutMs: 20_000,
    maxBytes: 512 * 1024,
  },
  verify: { method: "POST", url: SERVER, hook: "mcp.verify" },
  shares: [
    {
      what: "Your brand",
      detail: "its name and main domain",
      direction: "read",
      where: "Read when you connect and each time the connection is checked, to name the brand this key reads. Its domain and name label the connection.",
      needs: ["read:brand"],
    },
    {
      what: "Your AI share of voice each day",
      detail: "share of voice, mentions, rank and sentiment",
      direction: "read",
      where: "Read live when you or Vizzy ask.",
      needs: ["read:visibility"],
    },
    {
      what: "Your monitored prompts",
      detail: "each prompt's words, the AI engines asked and its totals",
      direction: "read",
      where: "Read live when you, Vizzy or Next up ask.",
      needs: ["read:prompts"],
    },
    {
      what: "The pages AI answers cite",
      detail: "the most cited pages, and the prompts that cite one of your pages",
      direction: "read",
      where: "Read live when you or Vizzy ask.",
      needs: ["read:citations"],
    },
    {
      what: "Audits and prompt scrapes",
      direction: "never",
      where: "YouGrow never runs an audit, adds a prompt or scrapes one, so it spends none of your Vizzybl credits.",
    },
    {
      what: "Anything else",
      direction: "never",
      where: "Nothing is ever written to Vizzybl.",
    },
  ],
  produces: [
    {
      stream: "ai_visibility",
      description: "Your AI share of voice, mentions, rank and sentiment, a row per day (UTC).",
      shape: "numbers",
      keys: ["day"],
      measures: ["aiShareOfVoice", "aiMentions", "aiRank", "aiSentiment"],
      joins: { day: "day" },
      lagDays: 1,
      timeZone: "UTC",
      days: "Days are whole days in UTC, ending yesterday, as Vizzybl's daily history keeps them.",
      personal: false,
      liveBy: ["day"],
      collect: {
        by: ["day"],
        rowsPerDay: 500,
        keepDays: 90,
        where: "Collected once a day and kept 90 days in your brand's region; Disconnect deletes them.",
        lag: "Each day is collected the next day and read again for 2 more days, in case Vizzybl is still working it out.",
        keeps: "Each day keeps your share of voice, mentions, rank and sentiment.",
      },
      mcp: {
        tool: "get_visibility_history",
        fill: { startDate: "from", endDate: "to", limit: "limit" },
        rows: "data",
        more: "pagination.hasMore",
        keys: { day: "date" },
        measures: { aiShareOfVoice: "shareOfVoice", aiMentions: "mentions", aiRank: "rank", aiSentiment: "sentimentScore" },
      },
    },
    {
      stream: "monitored_prompts",
      description: "Each prompt Vizzybl monitors: its words, the AI engines asked, and how often their answers named you and competitors.",
      shape: "numbers",
      keys: ["prompt", "engines"],
      measures: ["promptEngines", "promptBrandMentions", "promptCompetitors", "promptCitations"],
      joins: { prompt: "topic" },
      lagDays: 1,
      timeZone: "UTC",
      days: "Each prompt's numbers are Vizzybl's totals since it was first monitored, whatever days are asked.",
      personal: false,
      liveBy: ["topic"],
      mcp: {
        tool: "list_prompts",
        args: { status: "monitored" },
        fill: { limit: "limit" },
        rows: "data",
        more: "pagination.hasMore",
        keys: { prompt: "text", engines: "metrics.platformsScraped" },
        measures: {
          promptEngines: "metrics.platformsScraped",
          promptBrandMentions: "metrics.totalBrandMentions",
          promptCompetitors: "metrics.competitorCount",
          promptCitations: "metrics.totalCitations",
        },
      },
    },
    {
      stream: "prompts_citing_page",
      description: "The monitored prompts whose AI answers cite one page of yours, how often, and by which engines.",
      shape: "numbers",
      keys: ["prompt", "engines"],
      measures: ["aiCitations"],
      joins: { prompt: "topic" },
      lagDays: 1,
      timeZone: "UTC",
      days: "Counts every answer Vizzybl kept for each prompt, whatever days are asked. Read for one page at a time, on your brand's main domain.",
      personal: false,
      liveBy: ["topic"],
      liveFilters: ["page"],
      mcp: {
        tool: "find_prompts_citing",
        fill: { url: "pageUrl", limit: "limit" },
        rows: "data",
        more: "pagination.hasMore",
        keys: { prompt: "prompt", engines: "engines" },
        measures: { aiCitations: "citationCount" },
      },
    },
    {
      stream: "cited_pages",
      description: "The pages AI answers cite most for your monitored prompts, yours and others', with their share of every citation.",
      shape: "numbers",
      // page is your own page's path, empty for another site's; url is every page's full address.
      keys: ["page", "url", "domain"],
      measures: ["aiCitations", "aiCitationShare"],
      joins: { page: "page" },
      lagDays: 1,
      timeZone: "UTC",
      days: "Vizzybl adds up the citations in the answers it kept for the days asked.",
      personal: false,
      liveBy: ["page"],
      mcp: {
        tool: "get_citation_stats",
        fill: { startDate: "from", endDate: "to" },
        rows: "mostCitedUrls",
        keys: { page: "url", url: "url", domain: "domain" },
        measures: { aiCitations: "count", aiCitationShare: "citationShare" },
      },
    },
  ],
  uses: ["vizzy.read", "signals.ai_answers"],
  hooks: { live: "mcp.live", collect: "mcp.collect" },
  disconnect: "Disconnecting deletes the key YouGrow keeps. Vizzybl has no way for us to cancel it, so delete it in Vizzybl too, under Settings, API Keys.",
};

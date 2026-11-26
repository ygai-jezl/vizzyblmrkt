import { isPlansEnabled } from "@/lib/plans/flags";

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

/**
 * The MCP way to connect (ADR-0019): a connector whose manifest connects to its vendor's own MCP
 * server, with a pasted key, run by the one MCP engine. Needs CONNECTORS_ENABLED. Off, no MCP
 * connector is offered, whatever its own switch says, and nothing calls an MCP server.
 */
export function isMcpConnectorsEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_MCP_ENABLED === "true";
}

/**
 * Vizzybl, an AI answers tool, read from its own MCP server with an API key (ADR-0019). Needs
 * CONNECTORS_ENABLED here, and CONNECTOR_MCP_ENABLED before its way to connect is ready, so it is
 * listed only with both.
 */
export function isVizzyblConnectorEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_VIZZYBL_ENABLED === "true";
}

/**
 * Google Search Console in the catalogue (Connectors 1b). Needs CONNECTORS_ENABLED, and a Google
 * sign in client (CONNECTOR_GOOGLE_CLIENT_ID and its secret) before Sign in with Google is offered.
 */
export function isSearchConsoleConnectorEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_SEARCH_CONSOLE_ENABLED === "true";
}

/**
 * Google Analytics 4 in the catalogue (Connectors 1c). Needs CONNECTORS_ENABLED, and the identities
 * project (CONNECTORS_IDENTITIES_PROJECT) or, with CONNECTOR_GA4_SIGNIN_ENABLED, a Google sign in
 * client, for one way to connect.
 */
export function isGa4ConnectorEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_GA4_ENABLED === "true";
}

/**
 * Google Analytics 4 by Sign in with Google (needs CONNECTOR_GA4_ENABLED and the Google client).
 * Its scope, analytics.readonly, is one Google treats as sensitive: until Google has reviewed the
 * app, its sign in screen warns that the app isn't verified and the app is capped at 100 users,
 * so Sign in stays off while GA4 by share access goes on.
 */
export function isGa4SignInEnabled(): boolean {
  return process.env.CONNECTOR_GA4_SIGNIN_ENABLED === "true";
}

/**
 * Vizzy reading connected data: the routes under /api/agent/connectors that its list_connections
 * and read_connected_live tools call. Needs CONNECTORS_ENABLED; off, they answer 503 as the results
 * routes do. Vizzy still reads only connections an admin let it read.
 */
export function isConnectorsChatEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTORS_CHAT_ENABLED === "true";
}

/**
 * Disconnect, and the operator purge, also revoke a Google sign in at Google. Off: they delete the
 * tokens YouGrow keeps and leave the grant at Google. Its own switch because Google's revoke ends
 * every grant that Google account gave this copy's app, so it can cut off another brand that the
 * same Google account connected (the problem ADR-0006 found with X).
 */
export function isGoogleRevokeEnabled(): boolean {
  return process.env.CONNECTOR_GOOGLE_REVOKE_ENABLED === "true";
}

/**
 * Collected numbers (Connectors 2, ADR-0012): every connected Search Console site, Google
 * Analytics property and Cloudflare zone collected once a day into metric snapshots, kept 90 days;
 * the Review row for a data source that needs someone, and the Connected view's Collected column.
 * Needs CONNECTORS_ENABLED. Off, nothing new is collected and those screens look as before; what
 * was collected leaves through its time to live. Erasing never depends on it: Disconnect, Change
 * property, the purge and the lane's erase retries run whenever CONNECTORS_ENABLED is on.
 */
export function isConnectorsCollectEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTORS_COLLECT_ENABLED === "true";
}

/**
 * Search Console searches in brand search (Connectors 2, ADR-0013): each Search Console
 * connection's top 200 searches over 28 days, with their numbers, as one research source, found
 * only by viewers who may read that connection. Needs collected numbers (CONNECTORS_COLLECT_ENABLED);
 * the index itself needs SEARCH_INDEX_ENABLED and the brand's brand_search access. Off, the feeder
 * lists none, so the next sweep removes them, and searches hide them at once. Removing them on
 * Disconnect, Change property and the purge never depends on it.
 */
export function isConnectorsSearchTextEnabled(): boolean {
  return isConnectorsCollectEnabled() && process.env.CONNECTORS_SEARCH_TEXT_ENABLED === "true";
}

/**
 * Vizzy reading collected numbers: POST /api/agent/connectors/numbers, which its
 * get_connected_numbers tool calls (Connectors 2, ADR-0012). No switch of its own: it needs Vizzy
 * reading connected data (CONNECTORS_CHAT_ENABLED) and collected numbers (CONNECTORS_COLLECT_ENABLED),
 * and answers 503 while either is off, as the results routes do.
 */
export function isConnectorsNumbersEnabled(): boolean {
  return isConnectorsChatEnabled() && isConnectorsCollectEnabled();
}

/**
 * What collected numbers suggest (Connectors 2 group 4, ADR-0012): rising searches, pages losing
 * clicks and brand map questions just off Google's first page, from Search Console's final days,
 * as proposed brand map questions, Review suggestions with Plan an article and Dismiss, Search
 * Console lines in Next up and the context pack, and Vizzy's get_number_suggestions. Only
 * connections both members and Vizzy may read feed it. Needs collected numbers
 * (CONNECTORS_COLLECT_ENABLED) and the agent action indexes READY; never BRAND_SIGNALS_ENABLED
 * (decision 36). Off, detection stops and every one of those hides; open suggestions still expire
 * within 30 days, as the lane's housekeeping runs whenever CONNECTORS_ENABLED is on.
 */
export function isConnectorSignalsEnabled(): boolean {
  return isConnectorsCollectEnabled() && process.env.CONNECTOR_SIGNALS_ENABLED === "true";
}

/**
 * Next up reads AI answers (signals.ai_answers, ADR-0019): a candidate question close in wording
 * to a prompt an AI answers tool monitors gets a line saying how many engines answer it and how
 * often the brand and its competitors are named, from connections both members and Vizzy may
 * read. Needs CONNECTORS_ENABLED; it reads a kind of data, so it needs no vendor's switch of its
 * own beyond the connector's. Off, Next up says nothing about AI answers.
 */
export function isAiAnswersPlanningEnabled(): boolean {
  return isConnectorsEnabled() && process.env.CONNECTOR_AI_ANSWERS_ENABLED === "true";
}

/**
 * Organisations share connections (Connectors 3, ADR-0015): an organisation's owners connect once
 * and give each of its brands one part (a site, a property or a zone). Needs CONNECTORS_ENABLED
 * and PLANS_ENABLED (organisations count only with plans on). Off, the Shared connections section
 * is hidden and every part reads nothing, live or collected, and the lane skips parts quietly;
 * nothing is ended for it. Housekeeping for brands that left, the repairs of half done gives and
 * take backs, and the organisation purge run whatever it says.
 */
export function isConnectorsSharingEnabled(): boolean {
  return isConnectorsEnabled() && isPlansEnabled() && process.env.CONNECTORS_SHARING_ENABLED === "true";
}

import { collectDays as cloudflareCollect, zoneDaily, zoneProbe, zones } from "./cloudflare";
import { collectDays as googleAnalyticsCollect, properties, propertyCheck, runReport } from "./googleAnalytics";
import { collectDays as searchConsoleCollect, searchAnalytics, siteCheck, sites } from "./searchConsole";
import { mcpCollect, mcpLive, mcpVerify } from "../mcp/hooks";
import { MCP_HOOKS } from "../manifest";
import type { AccountsHook, CollectHook, LiveHook, VerifyHook } from "./types";

/**
 * Connector code by hook id: the only code a connector adds beside its manifest. A manifest names
 * these ids; src/lib/connectors/handlers/handlers.test.ts checks every id it names is here. An MCP
 * connector adds none: it names the one MCP engine's hooks (ADR-0019).
 */
export const VERIFY_HOOKS: Readonly<Record<string, VerifyHook>> = {
  "cloudflare.zoneProbe": zoneProbe,
  "searchConsole.siteCheck": siteCheck,
  "googleAnalytics.propertyCheck": propertyCheck,
  [MCP_HOOKS.verify]: mcpVerify,
};

export const LIVE_HOOKS: Readonly<Record<string, LiveHook>> = {
  "cloudflare.zoneDaily": zoneDaily,
  "searchConsole.searchAnalytics": searchAnalytics,
  "googleAnalytics.runReport": runReport,
  [MCP_HOOKS.live]: mcpLive,
};

/** What a signed in connection, or a pasted token before it is saved, can see, for the picker. */
export const ACCOUNT_HOOKS: Readonly<Record<string, AccountsHook>> = {
  "cloudflare.zones": zones,
  "searchConsole.sites": sites,
  "googleAnalytics.properties": properties,
};

/** Each connector's daily collect (Connectors 2, ADR-0012): the days it keeps, read as a system job. */
export const COLLECT_HOOKS: Readonly<Record<string, CollectHook>> = {
  "cloudflare.collectDays": cloudflareCollect,
  "searchConsole.collectDays": searchConsoleCollect,
  "googleAnalytics.collectDays": googleAnalyticsCollect,
  [MCP_HOOKS.collect]: mcpCollect,
};

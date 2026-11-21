import { zoneDaily, zoneProbe } from "./cloudflare";
import { properties, propertyCheck, runReport } from "./googleAnalytics";
import { searchAnalytics, siteCheck, sites } from "./searchConsole";
import type { AccountsHook, LiveHook, VerifyHook } from "./types";

/**
 * Connector code by hook id: the only code a connector adds beside its manifest. A manifest names
 * these ids; src/lib/connectors/handlers/handlers.test.ts checks every id it names is here.
 */
export const VERIFY_HOOKS: Readonly<Record<string, VerifyHook>> = {
  "cloudflare.zoneProbe": zoneProbe,
  "searchConsole.siteCheck": siteCheck,
  "googleAnalytics.propertyCheck": propertyCheck,
};

export const LIVE_HOOKS: Readonly<Record<string, LiveHook>> = {
  "cloudflare.zoneDaily": zoneDaily,
  "searchConsole.searchAnalytics": searchAnalytics,
  "googleAnalytics.runReport": runReport,
};

/** What a signed in connection can see, for the picker. */
export const ACCOUNT_HOOKS: Readonly<Record<string, AccountsHook>> = {
  "searchConsole.sites": sites,
  "googleAnalytics.properties": properties,
};

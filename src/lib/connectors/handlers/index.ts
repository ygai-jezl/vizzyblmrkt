import { zoneDaily, zoneProbe } from "./cloudflare";
import type { LiveHook, VerifyHook } from "./types";

/**
 * Connector code by hook id: the only code a connector adds beside its manifest. A manifest names
 * these ids; src/lib/connectors/handlers/handlers.test.ts checks every id it names is here.
 */
export const VERIFY_HOOKS: Readonly<Record<string, VerifyHook>> = {
  "cloudflare.zoneProbe": zoneProbe,
};

export const LIVE_HOOKS: Readonly<Record<string, LiveHook>> = {
  "cloudflare.zoneDaily": zoneDaily,
};

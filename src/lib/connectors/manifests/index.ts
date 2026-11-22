import { cloudflareManifest } from "./cloudflare";
import { ga4Manifest } from "./ga4";
import { searchConsoleManifest } from "./searchConsole";

/**
 * Every manifest in the repo, as written. Pure data with no imports beyond types, so the browser
 * can read it (the breadcrumbs name a connector's Listing page from it). The registry
 * (src/lib/connectors/registry.ts) parses them and decides which are offered.
 */
export const MANIFESTS = [cloudflareManifest, searchConsoleManifest, ga4Manifest] as const;

/** A connector's name by id, whatever its switch says, or null for an id no manifest has. */
export function connectorName(id: string): string | null {
  return MANIFESTS.find((m) => m.id === id)?.name ?? null;
}

import { cloudflareManifest } from "./cloudflare";
import { ga4Manifest } from "./ga4";
import { searchConsoleManifest } from "./searchConsole";
import { vizzyblManifest } from "./vizzybl";

/**
 * Every manifest in the repo, as written, in the order Browse and the help page list them (as the
 * approved Browse screen does: Search Console, Google Analytics 4, then Cloudflare; then the data
 * only connectors that read an MCP server, ADR-0019). Pure data with
 * no imports beyond types, so the browser can read it (the breadcrumbs name a connector's Listing
 * page from it). The registry (src/lib/connectors/registry.ts) parses them and decides which are
 * offered.
 */
export const MANIFESTS = [searchConsoleManifest, ga4Manifest, cloudflareManifest, vizzyblManifest] as const;

/** A connector's name by id, whatever its switch says, or null for an id no manifest has. */
export function connectorName(id: string): string | null {
  return MANIFESTS.find((m) => m.id === id)?.name ?? null;
}

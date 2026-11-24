import { parseManifest, type ConnectorManifest } from "./manifest";
import { MANIFESTS } from "./manifests";

/**
 * Every connector this build knows, parsed, whatever its switch says. Pure (no provider, store or
 * Google client), so the help page can read it in the browser as well as on the server. Which ones
 * are offered right now is the registry's question (src/lib/connectors/registry.ts).
 */
const CATALOG: readonly ConnectorManifest[] = MANIFESTS.map(parseManifest);

/** Every parsed manifest, whatever its switch says (for tests, help and scripts). */
export function allConnectors(): readonly ConnectorManifest[] {
  return CATALOG;
}

/** A known connector by id, whatever its switch says (the purge and reseal scripts use it). */
export function knownConnector(id: string): ConnectorManifest | null {
  return CATALOG.find((m) => m.id === id) ?? null;
}

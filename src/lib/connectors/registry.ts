import { isCloudflareConnectorEnabled, isSearchConsoleConnectorEnabled } from "./flags";
import { isGoogleSignInConfigured } from "./google";
import { parseManifest, type ConnectMethod, type ConnectMethodName, type ConnectorManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { searchConsoleManifest } from "./manifests/searchConsole";

/**
 * The connectors this copy knows, and which of them it offers right now. Business logic never
 * names a vendor: it asks here.
 *
 * - Every manifest is parsed when this module loads, so a bad one fails at once.
 * - A connector is offered only while its own switch is on (each needs CONNECTORS_ENABLED) and
 *   at least one of its sign-in methods is ready on this copy: Sign in with Google needs the
 *   connectors' Google client (CONNECTOR_GOOGLE_CLIENT_ID and its secret).
 * - A sign-in method is offered only once its piece builds it: token_fields (Connectors 1a),
 *   oauth_pkce (1b), share_access with 1c. A manifest listing an unbuilt method is refused.
 * - A stream marked personal is refused until the data processing agreement covers connected
 *   data (the DPA line).
 */

/** Every manifest in the repo, as written. */
export const MANIFESTS: readonly unknown[] = [cloudflareManifest, searchConsoleManifest];

/** The sign-in methods built so far. */
export const BUILT_METHODS: readonly ConnectMethodName[] = ["token_fields", "oauth_pkce"];

/** False until the data processing agreement covers personal data from a connector. */
export const PERSONAL_STREAMS_ALLOWED = false;

/** Each manifest's switch, read through src/lib/connectors/flags.ts. */
export const CONNECTOR_SWITCHES: Readonly<Record<string, () => boolean>> = {
  CONNECTOR_CLOUDFLARE_ENABLED: isCloudflareConnectorEnabled,
  CONNECTOR_SEARCH_CONSOLE_ENABLED: isSearchConsoleConnectorEnabled,
};

/** Whether this copy has what a sign-in method needs: Sign in with Google needs its client. */
function methodReady(c: ConnectMethod): boolean {
  if (!BUILT_METHODS.includes(c.method)) return false;
  if (c.method === "oauth_pkce") return c.client === "google" && isGoogleSignInConfigured();
  return true;
}

/** The sign-in methods a connector can use on this copy right now, in the manifest's order. */
export function readyMethods(m: ConnectorManifest): ConnectMethodName[] {
  return m.connect.filter(methodReady).map((c) => c.method);
}

/** Why a parsed manifest can't be offered, or [] when it can. */
export function refusals(m: ConnectorManifest): string[] {
  const out: string[] = [];
  for (const c of m.connect) if (!BUILT_METHODS.includes(c.method)) out.push(`${m.id}: the ${c.method} sign-in is not built yet`);
  if (!PERSONAL_STREAMS_ALLOWED) for (const p of m.produces) if (p.personal) out.push(`${m.id}: ${p.stream} is personal, which waits for the data processing agreement`);
  if (!CONNECTOR_SWITCHES[m.switch]) out.push(`${m.id}: no switch reads ${m.switch}`);
  return out;
}

const CATALOG: readonly ConnectorManifest[] = MANIFESTS.map(parseManifest);

/** Every parsed manifest, whatever its switch says (for tests, help and scripts). */
export function allConnectors(): readonly ConnectorManifest[] {
  return CATALOG;
}

/** A known connector by id, whatever its switch says (the purge and reseal scripts use it). */
export function knownConnector(id: string): ConnectorManifest | null {
  return CATALOG.find((m) => m.id === id) ?? null;
}

/** The connectors offered now: switch on, every method built, one ready, no personal stream. */
export function listConnectors(): ConnectorManifest[] {
  return CATALOG.filter((m) => refusals(m).length === 0 && CONNECTOR_SWITCHES[m.switch]!() && readyMethods(m).length > 0);
}

/** An offered connector by id, or null when it is unknown, switched off or refused. */
export function getConnector(id: string): ConnectorManifest | null {
  return listConnectors().find((m) => m.id === id) ?? null;
}

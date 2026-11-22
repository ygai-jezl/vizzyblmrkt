import { parseManifest, type ConnectMethodName } from "@/lib/connectors/manifest";
import { cloudflareManifest } from "@/lib/connectors/manifests/cloudflare";
import { ga4Manifest } from "@/lib/connectors/manifests/ga4";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { listingOf, type ConnectionView, type ConnectorListing } from "@/lib/connectors/service";

/**
 * Made-up data for the Connections screen tests: the real manifests as Browse and Listing get
 * them, and connections for the made-up brand Acme. Nothing here reaches a provider.
 */

const MANIFESTS = { cloudflare: cloudflareManifest, "search-console": searchConsoleManifest, "google-analytics": ga4Manifest } as const;

/** A connector as the list route answers it, with the sign-in methods ready on this copy. */
export function listingFor(id: keyof typeof MANIFESTS, ready: ConnectMethodName[]): ConnectorListing {
  return { ...listingOf(parseManifest(MANIFESTS[id])), ready };
}

export const NOW = new Date("2026-11-21T10:00:00.000Z");

/** A connection as an admin sees it; `member: true` drops the details, as the route does. */
export function connectionView(over: Omit<Partial<ConnectionView>, "details"> & { member?: boolean; details?: Partial<NonNullable<ConnectionView["details"]>> } = {}): ConnectionView {
  const { member, details, ...rest } = over;
  const base: ConnectionView = {
    id: "dcn_aaaaaaaaaaaaaaaaaaaa",
    connectorId: "cloudflare",
    connectorName: "Cloudflare",
    connectorOn: true,
    label: "Cloudflare",
    status: "connected",
    health: { state: "ok", lastOkAt: "2026-11-21T09:00:00.000Z", lastCheckedAt: "2026-11-21T09:00:00.000Z", message: null, pausedUntil: null },
    needsAccount: false,
    canReadLive: true,
    details: {
      method: "token_fields",
      account: "0123456789abcdef0123456789abcdef",
      ownerUid: "usr_alex",
      grants: [],
      recent: [{ at: "2026-11-20T09:00:00.000Z", kind: "connected", by: "usr_alex", code: null }],
      secrets: [{ slot: "token", sealedAt: "2026-11-20T09:00:00.000Z" }],
      serviceAccount: null,
      pausedAt: null,
      pausedBy: null,
      createdAt: "2026-11-20T09:00:00.000Z",
      updatedAt: "2026-11-20T09:00:00.000Z",
      disconnectedAt: null,
      ...details,
    },
    ...rest,
  };
  if (member) delete base.details;
  return base;
}

/** Text as a reader sees it: tags dropped, entities read back. */
export const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

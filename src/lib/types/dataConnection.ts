import { z } from "zod";
import { EncryptedBlobSchema } from "./productConnection";

/**
 * Connected data (Connectors 1, ADR-0011). One record per connection in the brand's regional
 * `data_connections`, written only through src/lib/tenant/dataConnections.ts, and each change in
 * `data_connection_activity`, kept 90 days by a time to live on `ttlAt`.
 *
 * Named `data_connection` (ids `dcn_`) because "connection" already means a connected product
 * (`product_connections`, `pcn_`) and a Review kind. People read "Connected data".
 */

export const DATA_CONNECTION_ID_RE = /^dcn_[a-z2-7]{20}$/;

export const DATA_CONNECTION_METHODS = ["token_fields", "oauth_pkce", "share_access"] as const;
export type DataConnectionMethod = (typeof DATA_CONNECTION_METHODS)[number];

/**
 * - ok: the last call worked;
 * - check: the last call failed for a reason that may pass (the provider was down or busy);
 * - broken: the provider turned the connection down, so it needs reconnecting;
 * - paused: an admin paused it, or YouGrow did after a provider's rate limit or repeated failures.
 */
export const HEALTH_STATES = ["ok", "check", "broken", "paused"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const ACTIVITY_KINDS = ["connected", "verified", "failed", "paused", "resumed", "grants_changed", "disconnected", "purged"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Who may read a connection beyond its admins. "manage" is never a grant: it is the admin role. */
export const GRANT_TARGETS = ["members", "agent:vizzy"] as const;
export type GrantTarget = (typeof GRANT_TARGETS)[number];

export const ConnectionGrantSchema = z.object({ to: z.enum(GRANT_TARGETS), can: z.literal("read") }).strict();
export type ConnectionGrant = z.infer<typeof ConnectionGrantSchema>;

export const SealedSecretSchema = z.object({
  blob: EncryptedBlobSchema,
  /** The short id of the vault root that sealed it (src/lib/connectors/vault.ts). */
  encKeyId: z.string(),
  sealedAt: z.string(),
});

export const ConnectionHealthSchema = z.object({
  state: z.enum(HEALTH_STATES),
  lastOkAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  /** A code from src/lib/connectors/messages.ts, never a provider's own words. */
  lastErrorCode: z.string().nullable(),
  /** Failures in a row since the last call that worked. */
  failures: z.number().int().min(0),
  /** Calls stop until then: after a provider's rate limit or repeated failures. */
  pausedUntil: z.string().nullable(),
});
export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>;

/** One change, as kept on the record's recent list and in the activity log. No secrets. */
export const ActivityEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  /** A team member's user id, "system", an agent ("agent:vizzy") or an operator label. */
  by: z.string(),
  code: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

export const DataConnectionSchema = z.object({
  id: z.string().regex(DATA_CONNECTION_ID_RE),
  tenantId: z.string(),
  connectorId: z.string(),
  method: z.enum(DATA_CONNECTION_METHODS),
  label: z.string(),
  /** What was connected, not secret: a zone id, a site. */
  account: z.string(),
  /** The admin who connected. Kept for the record; gives no extra rights. */
  ownerUid: z.string(),
  grants: z.array(ConnectionGrantSchema),
  /** Sealed secrets by slot ("token"). Emptied on disconnect and purge. */
  secrets: z.record(z.string(), SealedSecretSchema),
  health: ConnectionHealthSchema,
  /** Set while an admin has paused it. */
  pausedAt: z.string().nullable(),
  pausedBy: z.string().nullable(),
  /** The last 20 changes, newest first. */
  recent: z.array(ActivityEntrySchema),
  status: z.enum(["connected", "disconnected"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  disconnectedAt: z.string().nullable(),
});
export type DataConnection = z.infer<typeof DataConnectionSchema>;

/** A row of the activity log. Written, never queried by the app; deleted 90 days on. */
export interface DataConnectionActivity extends ActivityEntry {
  id: string;
  tenantId: string;
  connectionId: string;
  connectorId: string;
  /** The time to live: a Date, so Firestore's TTL policy deletes the row. */
  ttlAt: Date;
}

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

/**
 * - account_picked: an admin picked which site or property a signed in or shared connection reads;
 * - shared: an admin started share access, and YouGrow made the connection's Google address;
 * - access_checked: an admin pressed Check access on a shared connection (code ok, or why not);
 * - read: Vizzy read the connection live (kept in the log, not on the record's recent list);
 * - cleanup_failed: deleting a shared connection's Google address failed; the purge tries again;
 * - collected: the daily collect landed days (Connectors 2; in the log only, never on the recent
 *   list, so an older build that doesn't know the kind can still read the record);
 * - erased: what came from the connection was erased, after Disconnect, Change property (the old
 *   site's) or the purge (Connectors 2; in the log only, as collected).
 */
export const ACTIVITY_KINDS = [
  "connected",
  "verified",
  "failed",
  "paused",
  "resumed",
  "grants_changed",
  "account_picked",
  "shared",
  "access_checked",
  "read",
  "collected",
  "erased",
  "disconnected",
  "cleanup_failed",
  "purged",
] as const;
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

/**
 * Who is refreshing a signed in connection's access token right now (src/lib/connectors/
 * tokenKeeper.ts). A caller takes the lease for about 30 seconds before it spends the refresh
 * token, so two callers never refresh at once; a lease whose holder died runs out by itself.
 */
export const RefreshLeaseSchema = z.object({
  leaseId: z.string().nullable(),
  leaseUntil: z.string().nullable(),
});
export type RefreshLease = z.infer<typeof RefreshLeaseSchema>;

/**
 * A shared connection's Google address (Connectors 1c): a service account in the identities
 * project made for this one connection. Not a secret: the admin pastes the email into their
 * property. deletedAt is set once Disconnect or the purge deleted it at Google.
 */
export const ServiceAccountSchema = z.object({
  email: z.string(),
  uniqueId: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type ConnectionServiceAccount = z.infer<typeof ServiceAccountSchema>;

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
  /** When the failures in a row began; unset once a call works (Connectors 2: "lost access on 19 Nov"). */
  since: z.string().nullable().optional(),
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

/**
 * The daily collect's state (Connectors 2, ADR-0012), on the connection, written by the collector
 * under its lease and by the actions that start or end collecting. Optional: an older build's
 * parse drops it, and a connection without one is collected from the start.
 * - gen: the generation every snapshot id carries; Change property bumps it.
 * - nextAt: when the lane looks at it next. lastDay, finalThrough and backfilledTo: the cursor, in
 *   the provider's zone; filled once its keep window (or the provider's reach, reachFrom) is full.
 * - leaseId, leaseUntil: a run holding it, for 60 seconds at most.
 * - holdUntil, holdReason: the collector holding itself back (a quota, low tokens, no data, a day
 *   of failed tries), never the connection's health, so live reads go on.
 * - failedSince: when collecting first failed in a row; cleared by a run that works.
 * - erasePending: collected rows still to erase: "all" after Disconnect, or the old generations
 *   after Change property. The lane retries it whenever CONNECTORS_ENABLED is on.
 * - kept: the newest day's busiest grouping, how many rows the provider listed and how many were kept.
 * - probes: Search Console's probes on its current Pacific day (at most 6).
 * - strikes: quota answers and failed tries on the provider's current day.
 * - rolledOn: the day the rolled docs were last written.
 */
export const CollectStateSchema = z.object({
  gen: z.number().int().min(0).default(0),
  nextAt: z.string().nullable().default(null),
  lastDay: z.string().nullable().default(null),
  finalThrough: z.string().nullable().default(null),
  backfilledTo: z.string().nullable().default(null),
  filled: z.boolean().default(false),
  reachFrom: z.string().nullable().default(null),
  leaseId: z.string().nullable().default(null),
  leaseUntil: z.string().nullable().default(null),
  holdUntil: z.string().nullable().default(null),
  holdReason: z.string().nullable().default(null),
  failedSince: z.string().nullable().default(null),
  erasePending: z.union([z.literal("all"), z.array(z.number().int().min(0)).max(100)]).nullable().default(null),
  kept: z.object({ day: z.string(), by: z.string(), seen: z.number().int().min(0), rows: z.number().int().min(0), more: z.boolean() }).nullable().default(null),
  probes: z.object({ day: z.string(), count: z.number().int().min(0) }).nullable().default(null),
  strikes: z.object({ day: z.string(), quota: z.number().int().min(0), errors: z.number().int().min(0) }).nullable().default(null),
  timeZone: z.string().nullable().default(null),
  rolledOn: z.string().nullable().default(null),
  /** The UTC day its numbers were last looked at for suggestions (CONNECTOR_SIGNALS_ENABLED), once a day. */
  detectedOn: z.string().nullable().default(null),
});
export type CollectState = z.infer<typeof CollectStateSchema>;

/** A connection's collect state as it starts: generation 0, due now. */
export function freshCollect(nextAt: string | null = null, gen = 0): CollectState {
  return CollectStateSchema.parse({ gen, nextAt });
}

export const DataConnectionSchema = z.object({
  id: z.string().regex(DATA_CONNECTION_ID_RE),
  tenantId: z.string(),
  connectorId: z.string(),
  method: z.enum(DATA_CONNECTION_METHODS),
  label: z.string(),
  /**
   * What was connected, not secret: a zone id, a site. Empty after a sign in until an admin picks
   * which site or property it reads; nothing is read until then.
   */
  account: z.string(),
  /** The admin who connected. Kept for the record; gives no extra rights. */
  ownerUid: z.string(),
  grants: z.array(ConnectionGrantSchema),
  /**
   * Sealed secrets by slot: "token" for a pasted token, "access" and "refresh" for a sign in;
   * none for share access, whose tokens are never stored. Emptied on disconnect and purge.
   */
  secrets: z.record(z.string(), SealedSecretSchema),
  /** A sign in's access token expiry (canonical ISO). Unset for a pasted token. */
  tokenExpiresAt: z.string().nullable().optional(),
  /** A sign in's refresh lease. Unset for a pasted token. */
  refresh: RefreshLeaseSchema.optional(),
  /** A shared connection's Google address. Unset for the other methods. It holds no secret. */
  serviceAccount: ServiceAccountSchema.nullable().optional(),
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
  /** The daily collect's state (Connectors 2). */
  collect: CollectStateSchema.optional(),
});
export type DataConnection = z.infer<typeof DataConnectionSchema>;

/**
 * What a live read asked for and the days it read, kept on its activity row so a number that
 * doesn't match the provider's report can be checked later. Never a number read, nor a page.
 */
export interface ReadActivityDetail {
  stream: string;
  /** The grouping: day, page, topic or landing. */
  by: string;
  /** The days read, in the provider's time zone. */
  from: string;
  to: string;
  timeZone: string | null;
  limit: number;
  /** The named period asked for, or null for explicit days. */
  period: string | null;
  /** Whether the read was filtered to one page (which page is never kept). */
  pageFilter: boolean;
}

/** A row of the activity log. Written, never queried by the app; deleted 90 days on. */
export interface DataConnectionActivity extends ActivityEntry {
  id: string;
  tenantId: string;
  connectionId: string;
  connectorId: string;
  /** On a live read's row: what was asked and the days read. */
  read?: ReadActivityDetail;
  /** The time to live: a Date, so Firestore's TTL policy deletes the row. */
  ttlAt: Date;
}

/** A sign in state's id: the SHA-256, in hex, of the nonce kept in the browser's cookie. */
export const DATA_CONNECTION_STATE_ID_RE = /^[0-9a-f]{64}$/;

/**
 * A sign in with Google under way (Connectors 1b), one per attempt, in the brand's regional
 * `data_connection_states`, written only through src/lib/tenant/dataConnectionStates.ts. Valid
 * for 10 minutes, claimed once (usedAt set in a transaction), then deleted. `ttlAt` is a Date so
 * Firestore's TTL policy removes any record an abandoned sign in leaves behind.
 */
export interface DataConnectionState {
  id: string;
  tenantId: string;
  connectorId: string;
  /** The admin who started it: only they can finish it. */
  uid: string;
  /** The connection being signed in again, or null for a new one. */
  connectionId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  ttlAt: Date;
}

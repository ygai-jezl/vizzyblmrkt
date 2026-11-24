import { z } from "zod";
import {
  ConnectionHealthSchema,
  DATA_CONNECTION_ID_RE,
  DATA_CONNECTION_METHODS,
  ORGANISATION_CONNECTION_ID_RE,
  RefreshLeaseSchema,
  SealedSecretSchema,
  ServiceAccountSchema,
} from "./dataConnection";
import { Region } from "./tenant";

export { ORGANISATION_CONNECTION_ID_RE } from "./dataConnection";

/**
 * An organisation's connection (Connectors 3, ADR-0014): one sign in, one Google address or one
 * pasted token, connected once for an organisation, whose owners give each of its brands one part
 * of it (a site, a property or a zone). Kept in `organisation_connections` in the regional database
 * of the brand it was connected from, and never moved, even when that brand leaves; its parts can go
 * to the organisation's brands in any region. Written only through
 * src/lib/tenant/organisationConnections.ts, with each change in `organisation_connection_activity`,
 * kept 90 days by a time to live on `ttlAt`.
 *
 * Each part is an ordinary brand record (`data_connections`, `dcn_`) in that brand's own region,
 * with `account` set to the part and a `source` naming this record. Everything a brand collects
 * stays in its region. This record names what the sign in reads for each brand, never what was
 * collected.
 *
 * Its secrets are sealed with `${organisationId}:${id}:${slot}` bound in, so a blob never opens as a
 * brand's (brand ids start `ten_`, organisation ids `org_`).
 */

/** The most parts one organisation connection gives out, one per brand. */
export const MAX_PARTS = 50;

/**
 * - pending: a give or a change under way across two databases (step one done); reads nothing;
 * - active: the brand reads it;
 * - ending: a take back under way (step one done); reads nothing.
 * Only active reads. Housekeeping finishes or undoes the other two on positive evidence only.
 */
export const PART_STATES = ["pending", "active", "ending"] as const;
export type PartState = (typeof PART_STATES)[number];

export const ConnectionPartSchema = z
  .object({
    /** The brand given it. */
    tenantId: z.string().min(1).max(128),
    /** The brand's region (from its registry record), so a repair knows which database holds its record. */
    region: Region,
    /** The part: a site, a property or a zone, as the brand record's `account`. */
    account: z.string().min(1).max(2000),
    /** The brand record's id, made before step one. */
    useId: z.string().regex(DATA_CONNECTION_ID_RE),
    state: z.enum(PART_STATES),
    stateSince: z.string(),
    /** The part it had while a change is pending, so a repair can put it back. */
    was: z.string().min(1).max(2000).nullable(),
    /** Who gave it, by user id, and when. */
    givenBy: z.string().min(1).max(200),
    givenAt: z.string(),
    /** Who ended it, while it is ending. */
    endedBy: z.string().max(200).nullable(),
  })
  .strict();
export type ConnectionPart = z.infer<typeof ConnectionPartSchema>;

/**
 * - connected: an owner connected it for the organisation;
 * - signed_in_again: an owner signed in with Google again, in place;
 * - verified, failed: a call's outcome on the sign in itself (a part's own failures stay on its brand);
 * - paused, resumed: an owner's pause;
 * - held: a provider's quota answer held collection for every part;
 * - part_given, part_changed, part_ended, part_repaired: a part given, changed, ended or repaired by housekeeping;
 * - disconnected, cleanup_failed, purged: as a brand's connection.
 */
export const ORGANISATION_ACTIVITY_KINDS = [
  "connected",
  "signed_in_again",
  "verified",
  "failed",
  "paused",
  "resumed",
  "held",
  "part_given",
  "part_changed",
  "part_ended",
  "part_repaired",
  "disconnected",
  "cleanup_failed",
  "purged",
] as const;
export type OrganisationActivityKind = (typeof ORGANISATION_ACTIVITY_KINDS)[number];

/** One change, as kept on the record's recent list and in the activity log. Ids and codes only, no secret. */
export const OrganisationActivityEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(ORGANISATION_ACTIVITY_KINDS),
  /** A user id, "system", or an operator label. */
  by: z.string(),
  code: z.string().nullable(),
  /** The brand a part change is about. */
  tenantId: z.string().nullable().optional(),
});
export type OrganisationActivityEntry = z.infer<typeof OrganisationActivityEntrySchema>;

/**
 * Collection held for every part: Search Console and Cloudflare count their quota per user (or per
 * token), so one brand's quota answer stops collection for all of them until then. Live reads never
 * wait on it. A GA4 hold stays on the brand's own record (GA4 counts per property).
 */
export const CollectHoldSchema = z.object({ until: z.string(), reason: z.string().max(40) }).strict();
export type CollectHold = z.infer<typeof CollectHoldSchema>;

export const OrganisationConnectionSchema = z.object({
  id: z.string().regex(ORGANISATION_CONNECTION_ID_RE),
  organisationId: z.string().min(1).max(160),
  /** The region it is kept in: the region of the brand it was connected from. Never changes. */
  region: Region,
  connectorId: z.string(),
  method: z.enum(DATA_CONNECTION_METHODS),
  label: z.string(),
  /** The owner who connected it, by user id. */
  createdBy: z.string(),
  /** The owner who signed in with Google: only they see its list and give its parts (pick 6). Null for the other methods. */
  signerUid: z.string().nullable(),
  /** The brand it was connected from, whose region it is kept in. */
  connectedFromTenantId: z.string(),
  /** Sealed with the organisation bound in. Emptied on disconnect and purge. */
  secrets: z.record(z.string(), SealedSecretSchema),
  tokenExpiresAt: z.string().nullable().optional(),
  refresh: RefreshLeaseSchema.optional(),
  /** Its own Google address, made for the organisation (share access). */
  serviceAccount: ServiceAccountSchema.nullable().optional(),
  /** Failures of the sign in itself only. */
  health: ConnectionHealthSchema,
  pausedAt: z.string().nullable(),
  pausedBy: z.string().nullable(),
  status: z.enum(["connected", "disconnected"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  disconnectedAt: z.string().nullable(),
  /** The last 20 changes, newest first. */
  recent: z.array(OrganisationActivityEntrySchema),
  collectHold: CollectHoldSchema.nullable().default(null),
  /** The parts given out, one per brand, a part at most once. */
  parts: z.array(ConnectionPartSchema).max(MAX_PARTS),
});
export type OrganisationConnection = z.infer<typeof OrganisationConnectionSchema>;

/** A row of the activity log. Written, never queried by the app; deleted 90 days on. */
export interface OrganisationConnectionActivity extends OrganisationActivityEntry {
  id: string;
  organisationId: string;
  connectionId: string;
  connectorId: string;
  /** The time to live: a Date, so Firestore's TTL policy deletes the row. */
  ttlAt: Date;
}

/** The part a brand holds on a connection, whatever its state. */
export function partOf(conn: Pick<OrganisationConnection, "parts">, tenantId: string): ConnectionPart | null {
  return conn.parts.find((p) => p.tenantId === tenantId) ?? null;
}

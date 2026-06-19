import { getDb, isAlreadyExists } from "./firestore";
import type { FirestoreLike } from "./types";
import { gcsAuditSink, type AuditObjectSink } from "./auditSink";
import type { Region } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * Append-only audit trail, written to TWO stores:
 *
 *  1. The WORM object store (GCS bucket with a locked retention policy) — the
 *     tamper-resistant SYSTEM-OF-RECORD. The runtime service account can append
 *     but can never read, overwrite, or delete a record (see auditSink.ts). This
 *     is what makes the trail resistant to tampering by the very operators it
 *     describes.
 *  2. The flat control-plane `audit_events` Firestore collection in the (default)
 *     database — a convenient, queryable OPERATIONAL INDEX for the in-app/admin
 *     view. DELIBERATELY separate from the regional data plane it describes, so
 *     purging a tenant's regional data can never cascade into its audit trail.
 *
 * COMPLIANCE NOTES (apply to BOTH stores):
 *  - PII-free by construction. We record WHO / WHEN / WHAT / HOW-MANY, never the
 *    erased end-user data, so the trail is compatible with GDPR erasure and the
 *    tenant's data-residency boundary (deleted signup PII does not reappear here,
 *    in this region or any other). `campaignName`/`actorEmail` are operational
 *    metadata about the launch and the operator, already held in the control
 *    plane (`tenants`, `tenant_users`) — not waitlist-member PII.
 *  - Append-only: both writers ONLY ever create, with a deterministic id/path so
 *    a retry is an idempotent no-op rather than a duplicate. Nothing in the app
 *    updates or deletes a record. The Firestore copy alone is NOT tamper-proof
 *    (the admin SDK bypasses Security Rules and Firestore IAM can't be scoped per
 *    collection) — that is exactly why the GCS WORM store is the authoritative
 *    record; the Firestore copy is a best-effort index.
 */

/** Per-collection counts of documents purged. Counts only — never the PII. */
export interface LaunchDeletionCounts {
  campaigns: number;
  signups: number;
  broadcasts: number;
  journeys: number;
  emailJobs: number;
}

/** Immutable record of a single launch-deletion attempt (success or failure). */
export interface LaunchDeletionAudit {
  action: "launch.delete";
  // WHO — the authenticated actor, from the verified session/ID-token context.
  actorUid?: string;
  actorEmail?: string;
  actorRole?: TenantRole;
  // WHERE — the tenant and residency region of the purged data.
  tenantId: string;
  region: Region;
  // WHAT — the launch. `campaignName` is operational metadata, not member PII.
  campaignId: string;
  campaignName: string;
  // OUTCOME. "initiated" is written BEFORE the purge (durable intent, zero counts
  // yet); "completed"/"failed" after. A "failed" row carries whatever was purged
  // before the error plus the error message, so even a partial deletion — or a
  // process that dies mid-purge — is fully traceable.
  status: "initiated" | "completed" | "failed";
  deleted: LaunchDeletionCounts;
  reason?: string;
  // On a "failed" row: a human-readable message plus a structured code (e.g. the
  // Firestore gRPC code) so a post-incident audit can tell a PERMISSION_DENIED
  // from a transient error. Both are non-PII.
  error?: string;
  errorCode?: string;
  // WHEN — ISO-8601 UTC.
  createdAt: string;
}

/**
 * Stable id for an audit entry, used as BOTH the Firestore doc id and the GCS
 * object name so the two stores cross-reference. Derived from the entry itself
 * (`tenant_campaign_createdAt_status`), so re-deriving it for the SAME entry —
 * e.g. an internal retry that reuses the already-captured `createdAt` — yields
 * the same key, making the write idempotent. Two DISTINCT delete attempts get
 * distinct `createdAt`s → distinct keys, which is correct: each is a separately
 * audited event, not a duplicate.
 */
export function auditEntryId(entry: LaunchDeletionAudit): string {
  return `${entry.tenantId}_${entry.campaignId}_${entry.createdAt}_${entry.status}`.replace(
    /[^\w.-]/g,
    "_",
  );
}

/** GCS object path for an audit entry, under the launch-delete prefix. */
export function auditObjectPath(entry: LaunchDeletionAudit): string {
  return `audit/launch-delete/${auditEntryId(entry)}.json`;
}

/**
 * Write one immutable audit record to the WORM object store (the authoritative,
 * tamper-resistant system-of-record). Create-only and idempotent (see the sink).
 * Throws on a hard failure so callers can decide whether to proceed — the
 * "initiated" record is awaited BEFORE any destructive write for exactly this
 * reason (no purge without a durable trail).
 */
export async function writeAuditObject(
  entry: LaunchDeletionAudit,
  sink: AuditObjectSink = gcsAuditSink(),
): Promise<void> {
  await sink.put(auditObjectPath(entry), JSON.stringify(entry));
}

/**
 * Append a launch-deletion audit row to the control-plane `audit_events`
 * Firestore collection — the OPERATIONAL INDEX (the WORM object is the
 * authoritative record). Idempotent via the deterministic id + atomic create().
 * Mirrors logDomainGrant(). Writes to the (default) database.
 */
export async function recordLaunchDeletion(
  entry: LaunchDeletionAudit,
  db: FirestoreLike = getDb() as unknown as FirestoreLike,
): Promise<void> {
  const id = auditEntryId(entry);
  try {
    await db.collection("audit_events").doc(id).create({ ...entry });
  } catch (err) {
    if (isAlreadyExists(err)) return; // duplicate audit write — fine
    throw err;
  }
}

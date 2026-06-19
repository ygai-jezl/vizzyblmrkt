import { forTenant } from "./repository";
import type { WhereClause } from "./repository";
import {
  recordLaunchDeletion,
  writeAuditObject,
  auditEntryId,
  type LaunchDeletionAudit,
  type LaunchDeletionCounts,
} from "./audit";
import { gcsAuditSink, type AuditObjectSink } from "./auditSink";
import { TenantIsolationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";

export interface DeleteLaunchResult {
  campaignName: string;
  deleted: LaunchDeletionCounts;
  /**
   * Whether the authoritative WORM outcome record was durably persisted. The
   * purge always has at least the durable "initiated" WORM record (it gates the
   * purge), so the trail is never empty — but if every outcome-write attempt
   * fails, this is false and the caller MUST surface/alert that the final record
   * (counts + completed/failed) needs reconciliation. Never silently a 200.
   */
  auditComplete: boolean;
}

const WORM_WRITE_ATTEMPTS = 3;

/**
 * Permanently delete a launch and everything it owns, then append an immutable
 * audit record. This is the destructive "clean up the database, keep the trail"
 * operation behind DELETE /api/admin/campaigns/[id].
 *
 * Tenant-scoped throughout: forTenant() partitions every read and delete to
 * `ctx`'s tenant, so this can only ever purge the caller's OWN launch — a
 * guessed/foreign campaign id reads as absent (→ TenantIsolationError → 404).
 *
 * Purge order deletes CHILDREN first (signups → broadcasts → journeys → email
 * jobs) and the campaign doc LAST: if the run fails partway, the campaign still
 * exists so an operator can see the launch and retry, rather than orphaning
 * child rows under a vanished launch.
 *
 * Two-phase audit, so no deletion can ever happen untraceably:
 *   1. An immutable "initiated" record is written to the WORM store BEFORE any
 *      destructive write. If that write fails, the purge is ABORTED — there is no
 *      data loss without a durable intent record. This also covers a process that
 *      dies mid-purge (the initiated record survives).
 *   2. After the purge, a "completed" (or "failed", with partial counts + error)
 *      record is written to the WORM store (authoritative) and the Firestore index.
 * The audit captures counts only; the erased signup PII is never copied into it
 * (GDPR-erasure + residency safe).
 *
 * `db` and `sink` are injected by tests (a fake Firestore + a fake WORM sink);
 * production omits them and they default to the real regional/control databases
 * and the GCS WORM bucket.
 */
export async function deleteLaunch(
  ctx: TenantContext,
  campaignId: string,
  opts: { reason?: string } = {},
  db?: FirestoreLike,
  sink: AuditObjectSink = gcsAuditSink(),
): Promise<DeleteLaunchResult> {
  const repo = forTenant(ctx, db);

  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) {
    // Same message shape as the repository's own ownership failures; the route
    // maps it to 404 rather than leaking whether the id exists in another tenant.
    throw new TenantIsolationError(
      `campaigns/${campaignId} not found in tenant ${ctx.tenantId}`,
    );
  }

  const where: WhereClause[] = [["campaignId", "==", campaignId]];
  const deleted: LaunchDeletionCounts = {
    campaigns: 0,
    signups: 0,
    broadcasts: 0,
    journeys: 0,
    emailJobs: 0,
  };

  const auditBase: Omit<LaunchDeletionAudit, "status" | "error" | "errorCode"> = {
    action: "launch.delete",
    actorUid: ctx.userId,
    actorEmail: ctx.email,
    actorRole: ctx.role,
    tenantId: ctx.tenantId,
    region: ctx.region,
    campaignId,
    campaignName: campaign.waitlistName,
    deleted,
    ...(opts.reason ? { reason: opts.reason } : {}),
    createdAt: new Date().toISOString(),
  };

  // Phase 1 — durable INTENT record before any destructive write. A WORM failure
  // here throws and aborts the purge (no data loss without a trail). `deleted` is
  // all-zero at this point, which is correct: nothing has been purged yet.
  await writeAuditObject({ ...auditBase, status: "initiated" }, sink);

  // Phase 2 — purge, then the OUTCOME record.
  try {
    deleted.signups = await repo.signups.deleteWhere(where);
    deleted.broadcasts = await repo.broadcasts.deleteWhere(where);
    deleted.journeys = await repo.journeys.deleteWhere(where);
    deleted.emailJobs = await repo.emailJobs.deleteWhere(where);
    await repo.campaigns.delete(campaignId);
    deleted.campaigns = 1;
  } catch (err) {
    await emitOutcome(
      {
        ...auditBase,
        status: "failed",
        error: errorMessage(err),
        ...(errorCode(err) ? { errorCode: errorCode(err) } : {}),
      },
      db,
      sink,
    );
    throw err;
  }

  const { wormPersisted } = await emitOutcome(
    { ...auditBase, status: "completed" },
    db,
    sink,
  );
  return { campaignName: campaign.waitlistName, deleted, auditComplete: wormPersisted };
}

/**
 * Write the OUTCOME record. The purge has already happened by now, so we must
 * never throw back to the caller (that would misreport an already-completed
 * deletion). We write the authoritative WORM object with a few retries; if every
 * attempt fails we log the full entry at ERROR and report `wormPersisted: false`
 * so the caller surfaces the gap instead of returning a silent 200.
 *
 * IMPORTANT — the trail is never empty even here: the purge only runs AFTER the
 * "initiated" WORM record was durably written (phase 1 awaits it and aborts on
 * failure), so a durable record of WHO/WHEN/WHAT-launch always exists; only the
 * final counts + completed/failed status would be missing, and that is exactly
 * what `auditComplete: false` flags for reconciliation. The Firestore index copy
 * is strictly best-effort (tamperable, non-authoritative).
 */
async function emitOutcome(
  entry: LaunchDeletionAudit,
  db: FirestoreLike | undefined,
  sink: AuditObjectSink,
): Promise<{ wormPersisted: boolean }> {
  let wormErr: unknown;
  for (let attempt = 1; attempt <= WORM_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await writeAuditObject(entry, sink);
      wormErr = undefined;
      break;
    } catch (err) {
      wormErr = err;
    }
  }
  if (wormErr) {
    console.error(
      `[audit] WORM audit write FAILED after ${WORM_WRITE_ATTEMPTS} attempts for ${auditEntryId(entry)}: ${JSON.stringify(entry)}`,
      wormErr,
    );
  }
  try {
    await recordLaunchDeletion(entry, db);
  } catch (err) {
    console.error(
      `[audit] Firestore audit index write failed for ${auditEntryId(entry)}`,
      err,
    );
  }
  return { wormPersisted: !wormErr };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The structured failure code (Firestore gRPC codes are strings or numbers), if
 * the error carries one — captured on the audit trail for forensic triage.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") return String(code);
  }
  return undefined;
}

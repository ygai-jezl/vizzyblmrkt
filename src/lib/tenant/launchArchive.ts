import { forTenant } from "./repository";
import {
  recordLaunchDeletion,
  writeAuditObject,
  auditEntryId,
  type LaunchDeletionAudit,
} from "./audit";
import { gcsAuditSink, type AuditObjectSink } from "./auditSink";
import { TenantIsolationError } from "./errors";
import type { FirestoreLike, TenantContext } from "./types";

export type ArchiveAction = "archive" | "restore";

export interface SetArchiveResult {
  campaignName: string;
  /** The launch's archived state after the call: the ISO timestamp, or null if active. */
  archivedAt: string | null;
  /** Archive only: whether an ACTIVE journey was paused as part of closing the launch. */
  journeyPaused: boolean;
  /**
   * Whether the (best-effort) audit record persisted. Unlike a delete, this NEVER
   * gates the mutation — it is reported only so a failure is observable.
   */
  auditPersisted: boolean;
}

/**
 * Archive (close) or restore (reopen) a launch. The non-destructive counterpart
 * to deleteLaunch: archiving sets `archivedAt` (which stops public signups and
 * pauses the active journey) but PRESERVES every record, so the launch's data
 * stays readable for agents/analytics. Behind POST /api/admin/campaigns/[id]/archive.
 *
 * Tenant-scoped throughout: forTenant() partitions every read/write to `ctx`'s
 * tenant, so this can only ever touch the caller's OWN launch — a guessed/foreign
 * id reads as absent (→ TenantIsolationError → 404).
 *
 * Idempotent: setting the state the launch is already in is a no-op (no mutation,
 * no audit row). On RESTORE we clear `archivedAt` by writing `null` (never
 * `undefined`, which `ignoreUndefinedProperties` would drop) and deliberately do
 * NOT auto-resume the paused journey — the admin re-activates it manually so a
 * restore can never trigger a surprise re-send.
 *
 * Audit is lightweight and best-effort: deleteLaunch uses a two-phase WORM record
 * that ABORTS the purge if the durable intent write fails, because the data loss
 * is irreversible. Archive/restore destroys nothing and is reversible, so the
 * state change is applied first and the audit (WORM + Firestore index) is written
 * after — an audit hiccup must never refuse to close/reopen a launch. It is
 * recorded for the same who/when/what reasons, PII-free.
 *
 * `db` and `sink` are injected by tests; production omits them (real regional/
 * control databases + the GCS WORM bucket).
 */
export async function setLaunchArchived(
  ctx: TenantContext,
  campaignId: string,
  action: ArchiveAction,
  opts: { reason?: string } = {},
  db?: FirestoreLike,
  sink: AuditObjectSink = gcsAuditSink(),
): Promise<SetArchiveResult> {
  const repo = forTenant(ctx, db);

  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) {
    // Same message shape as the repository's own ownership failures; the route
    // maps it to 404 rather than leaking whether the id exists in another tenant.
    throw new TenantIsolationError(
      `campaigns/${campaignId} not found in tenant ${ctx.tenantId}`,
    );
  }

  const currentlyArchived = !!campaign.archivedAt;
  const wantArchived = action === "archive";

  // Idempotent no-op: already in the requested state. No mutation, no audit row.
  if (currentlyArchived === wantArchived) {
    return {
      campaignName: campaign.waitlistName,
      archivedAt: campaign.archivedAt ?? null,
      journeyPaused: false,
      auditPersisted: true,
    };
  }

  const now = new Date().toISOString();
  let journeyPaused = false;

  if (wantArchived) {
    await repo.campaigns.update(campaignId, { archivedAt: now });
    // Pause the launch's single journey so in-flight steps stop sending. Only an
    // ACTIVE journey is touched (draft/paused are left as-is), mirroring the
    // pause branch of the journey activate route.
    const journeyId = `journey_${campaignId}`;
    const journey = await repo.journeys.getById(journeyId);
    if (journey?.status === "active") {
      await repo.journeys.update(journeyId, { status: "paused", updatedAt: now });
      journeyPaused = true;
    }
    // Cancel any scheduled (not-yet-sent) broadcasts so a closed launch never
    // fires a deferred send and none is left stuck showing a future time. Mirrors
    // the journey pause above. A broadcast the worker has already claimed (job is
    // "processing"/"done") is left alone — same safety as cancelScheduledBroadcast.
    // (Single campaignId equality filter — no composite index needed.)
    const broadcasts = await repo.broadcasts.find({
      where: [["campaignId", "==", campaignId]],
    });
    for (const b of broadcasts) {
      if (b.status !== "scheduled") continue;
      const jobKey = `broadcast:${b.id}`;
      const job = await repo.emailJobs.getById(jobKey);
      if (job && job.status !== "pending" && job.status !== "failed") continue;
      if (job) await repo.emailJobs.delete(jobKey);
      await repo.broadcasts.update(b.id, { status: "draft", scheduledAt: null });
    }
  } else {
    await repo.campaigns.update(campaignId, { archivedAt: null });
  }

  const archivedAt = wantArchived ? now : null;

  const entry: LaunchDeletionAudit = {
    action: wantArchived ? "launch.archive" : "launch.restore",
    actorUid: ctx.userId,
    actorEmail: ctx.email,
    actorRole: ctx.role,
    tenantId: ctx.tenantId,
    region: ctx.region,
    campaignId,
    campaignName: campaign.waitlistName,
    status: "recorded",
    ...(opts.reason ? { reason: opts.reason } : {}),
    createdAt: now,
  };

  let auditPersisted = true;
  try {
    await writeAuditObject(entry, sink);
  } catch (err) {
    auditPersisted = false;
    console.error(
      `[audit] WORM ${entry.action} write failed for ${auditEntryId(entry)}`,
      err,
    );
  }
  // Best-effort operational index; never throws back to the caller.
  try {
    await recordLaunchDeletion(entry, db);
  } catch (err) {
    console.error(
      `[audit] Firestore audit index write failed for ${auditEntryId(entry)}`,
      err,
    );
  }

  return {
    campaignName: campaign.waitlistName,
    archivedAt,
    journeyPaused,
    auditPersisted,
  };
}

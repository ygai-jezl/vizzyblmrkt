import { forTenant, listAllTenants, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Region, Tenant } from "@/lib/types/tenant";
import {
  scheduledPostDedupeKey,
  type ScheduledPost,
  type ScheduledPostChannel,
} from "@/lib/types/scheduledPost";

/**
 * Distribute delivery worker — drains the `campaign_scheduled_posts` queue and
 * publishes due posts to their channel. Mirrors the email delivery worker
 * (src/lib/email/delivery.ts): idempotent, best-effort, a failed post retries up
 * to MAX_ATTEMPTS then parks as "failed", and a stale ("processing") claim is
 * reclaimable after the lease.
 *
 * PHASE 1: `publishPost` is a MANUAL stamp (no live channel adapter yet) — the
 * post flips to "done" with publishedRef.platform === "manual" and the operator
 * posts from the preview. Phase 4+ replaces it with a per-channel client (X MCP /
 * Graph API) that returns a real publishedRef.
 *
 * NOTE (D2): before real publishing lands, the claim below must be upgraded to a
 * Firestore transaction — the 60s cron can invoke overlapping runs, and only a
 * transactional claim (plus the publishedRef guard) guarantees two workers can't
 * both publish the same post. The publishedRef guard is already in place so a
 * double-claim is safe today (the manual stamp is idempotent).
 */

const MAX_ATTEMPTS = 3;
/** Visibility timeout: a "processing" claim older than this is reclaimable. */
const LEASE_MS = 5 * 60_000;

export async function processScheduledPosts(
  ctx: TenantContext,
  limit = 25,
  db?: FirestoreLike,
): Promise<{ processed: number; done: number; failed: number }> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - LEASE_MS).toISOString();
  const repo = forTenant(ctx, db).scheduledPosts;

  // Due pending posts, PLUS posts whose "processing" claim has expired (a prior
  // worker crashed mid-run) so they can be reclaimed rather than stuck forever.
  const [due, stale] = await Promise.all([
    repo.find({
      where: [
        ["status", "==", "pending"],
        ["scheduledAt", "<=", now],
      ],
      orderBy: [["scheduledAt", "asc"]],
      limit,
    }),
    repo.find({
      where: [
        ["status", "==", "processing"],
        ["claimedAt", "<=", staleBefore],
      ],
      orderBy: [["claimedAt", "asc"]],
      limit,
    }),
  ]);
  const seen = new Set<string>();
  const posts = [...due, ...stale].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  let done = 0;
  let failed = 0;
  for (const post of posts) {
    const attempts = post.attempts + 1;
    await repo.update(post.id, {
      status: "processing",
      attempts,
      claimedAt: new Date().toISOString(),
    });
    try {
      await dispatchScheduledPost(ctx, post, db);
      done += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const exhausted = attempts >= MAX_ATTEMPTS;
      // Mirror the email worker (delivery.ts): flip back to "pending" and LEAVE
      // claimedAt stamped. A pending row is re-eligible via the due-query
      // regardless of claimedAt, and not nulling it avoids ever producing a
      // (processing, null-claim) row the stale-reclaim query could never match.
      await repo.update(post.id, {
        status: exhausted ? "failed" : "pending",
        lastError: msg,
        processedAt: exhausted ? new Date().toISOString() : null,
      });
      failed += 1;
    }
  }
  return { processed: posts.length, done, failed };
}

async function dispatchScheduledPost(
  ctx: TenantContext,
  post: ScheduledPost,
  db?: FirestoreLike,
): Promise<void> {
  // Exhaustive dispatch: a new jobKind must be handled here or the `never` check
  // below fails to compile. Phase 1 only implements "publish".
  switch (post.jobKind) {
    case "publish":
      await publishPost(ctx, post, db);
      return;
    case "auto_plug_comment":
    case "auto_engage_draft":
    case "auto_dm":
    case "performance_fetch":
    case "li_connection_request":
    case "li_dm_held":
    case "li_dm_release":
      throw new Error(`jobKind not implemented in phase 1: ${post.jobKind}`);
    default: {
      const _exhaustive: never = post.jobKind;
      throw new Error(`unknown jobKind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Publish one post to its channel. PHASE 1: manual stamp only — no external call.
 * Idempotency guard (D6): once publishedRef is set, a retry never re-publishes.
 */
async function publishPost(
  ctx: TenantContext,
  post: ScheduledPost,
  db?: FirestoreLike,
): Promise<void> {
  const repo = forTenant(ctx, db).scheduledPosts;
  // A retry after a successful-but-unacked publish must never re-post.
  if (post.publishedRef) {
    await repo.update(post.id, {
      status: "done",
      processedAt: new Date().toISOString(),
      lastError: null,
    });
    return;
  }
  // PHASE 1: release the post for MANUAL publishing (operator posts from the
  // preview's copy action). Replaced in Phase 4 by a per-channel live adapter.
  //
  // PHASE 4 CONTRACT: a real adapter MUST persist publishedRef atomically with (or
  // before) the external side-effect is committed — and use the channel's own
  // idempotency key — so a crash between "posted to channel" and "publishedRef
  // saved" can't let the stale-reclaim path re-post (the guard above only fires
  // once publishedRef is persisted). It must also upgrade the claim above to a
  // Firestore transaction, since the 60s cron can invoke overlapping runs.
  await repo.update(post.id, {
    status: "done",
    publishedRef: { platform: "manual", publishedAt: new Date().toISOString() },
    processedAt: new Date().toISOString(),
    lastError: null,
  });
}

export interface DistributeDrainResult {
  tenants: number;
  processed: number;
  done: number;
  failed: number;
  perTenant: Array<
    | { tenantId: string; region: Region; processed: number; done: number; failed: number }
    | { tenantId: string; region: Region; error: string }
  >;
}

/**
 * Fan the Distribute worker out over EVERY tenant, across all regional databases
 * (US/EU/Asia). The scheduled (Cloud Scheduler) worker calls this: a single cron
 * has no one tenant context. One tenant's failure is logged and skipped so it can
 * never stall the others.
 */
export async function processScheduledPostsForAllTenants(
  limitPerTenant = 100,
  deps: {
    listTenants?: () => Promise<Tenant[]>;
    drain?: (
      ctx: TenantContext,
      limit: number,
    ) => Promise<{ processed: number; done: number; failed: number }>;
  } = {},
): Promise<DistributeDrainResult> {
  const listTenants = deps.listTenants ?? listAllTenants;
  const drain = deps.drain ?? processScheduledPosts;
  const tenants = await listTenants();
  let processed = 0;
  let done = 0;
  let failed = 0;
  const perTenant: DistributeDrainResult["perTenant"] = [];
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const r = await drain(ctx, limitPerTenant);
      processed += r.processed;
      done += r.done;
      failed += r.failed;
      perTenant.push({ tenantId: t.id, region: t.region, ...r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      console.warn(`[distribute] tenant ${t.id} (${t.region}) drain failed: ${msg}`);
      perTenant.push({ tenantId: t.id, region: t.region, error: msg });
    }
  }
  return { tenants: tenants.length, processed, done, failed, perTenant };
}

// ---- Orchestration (schedule / cancel / list) -----------------------------

export interface SchedulePostInput {
  workspaceId: string;
  contentPlanId: string;
  nodeId: string;
  channel: ScheduledPostChannel;
  format?: string | null;
  body: string;
  /** ISO instant (already validated future by the route). */
  scheduledAt: string;
}

/**
 * Schedule (or re-time) a post for a Create node. Idempotent per (workspace, plan,
 * node): the atomic create rejects a duplicate, at which point a still-pending or
 * failed post is re-armed to the new time. A post already "processing"/"done" is
 * terminal (the publish is under way or complete) — surfaced so the caller can 409.
 */
export async function schedulePost(
  ctx: TenantContext,
  input: SchedulePostInput,
  db?: FirestoreLike,
): Promise<{ status: "scheduled"; post: ScheduledPost }> {
  const dedupeKey = scheduledPostDedupeKey(
    input.workspaceId,
    input.contentPlanId,
    input.nodeId,
  );
  const now = new Date().toISOString();
  const repo = forTenant(ctx, db).scheduledPosts;
  try {
    const post = await repo.create(dedupeKey, {
      workspaceId: input.workspaceId,
      contentPlanId: input.contentPlanId,
      nodeId: input.nodeId,
      channel: input.channel,
      format: input.format ?? null,
      jobKind: "publish",
      status: "pending",
      dedupeKey,
      scheduledAt: input.scheduledAt,
      attempts: 0,
      claimedAt: null,
      body: input.body,
      publishedRef: null,
      lastError: null,
      createdAt: now,
      processedAt: null,
    });
    return { status: "scheduled", post };
  } catch (err) {
    if (!(err instanceof TenantIsolationError)) throw err;
    // Already scheduled → re-arm ONLY if it hasn't started/finished publishing.
    // `!publishedRef` also excludes a Phase-4 post that published then later-step-
    // failed (status "failed" but already live) — re-queuing that would double-post.
    //
    // NOTE (Phase 4): create-collision → getById → update is not atomic. A schedule
    // that races a concurrent publish (getById reads "pending" just before the
    // worker publishes) can still re-arm a now-published post; the publishedRef
    // guard in publishPost prevents an actual re-post, but a fully-correct fix needs
    // a Firestore transaction here (see D2/D6 in the Distribute Roadmap).
    const existing = await repo.getById(dedupeKey);
    if (
      existing &&
      (existing.status === "pending" || existing.status === "failed") &&
      !existing.publishedRef
    ) {
      const patch = {
        status: "pending" as const,
        attempts: 0,
        scheduledAt: input.scheduledAt,
        claimedAt: null,
        lastError: null,
        processedAt: null,
        // Refresh the payload in case the node was edited since first scheduling.
        body: input.body,
        channel: input.channel,
        format: input.format ?? null,
      };
      await repo.update(dedupeKey, patch);
      // Construct the result in-memory — no second read for data we just wrote.
      return { status: "scheduled", post: { ...existing, ...patch } };
    }
    throw new SchedulePostConflictError(
      existing ? "already_publishing" : "conflict",
    );
  }
}

/** Thrown by schedulePost when a post can't be re-armed (already publishing/done). */
export class SchedulePostConflictError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SchedulePostConflictError";
  }
}

/**
 * Cancel a not-yet-published scheduled post: delete its queue doc. Returns true
 * when it's gone (deleted, or already absent — a retry after a partial cancel is
 * safe). Returns false when the worker already claimed it ("processing") or it's
 * "done" — too late to cancel.
 */
export async function cancelScheduledPost(
  ctx: TenantContext,
  workspaceId: string,
  contentPlanId: string,
  nodeId: string,
  db?: FirestoreLike,
): Promise<boolean> {
  const dedupeKey = scheduledPostDedupeKey(workspaceId, contentPlanId, nodeId);
  const repo = forTenant(ctx, db).scheduledPosts;
  const existing = await repo.getById(dedupeKey);
  if (!existing) return true; // nothing queued — already effectively cancelled
  // A post that already published (publishedRef set) can't be truly cancelled,
  // even if a later step failed it — report NOT cancellable so the caller never
  // tells the operator a live post was removed. Only a genuinely un-published
  // pending/failed post is safe to delete.
  if (
    (existing.status === "pending" || existing.status === "failed") &&
    !existing.publishedRef
  ) {
    await repo.delete(dedupeKey);
    return true;
  }
  return false; // processing / done / already-published — too late to cancel
}

/** List a workspace's scheduled posts (newest scheduled first). */
export async function listScheduledPosts(
  ctx: TenantContext,
  workspaceId: string,
  db?: FirestoreLike,
  limit = 500,
): Promise<ScheduledPost[]> {
  const rows = await forTenant(ctx, db).scheduledPosts.find({
    where: [["workspaceId", "==", workspaceId]],
    limit,
  });
  // In-memory sort (equality-only query → no composite index needed).
  return rows.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

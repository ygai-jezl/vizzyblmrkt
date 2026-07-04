import { forTenant, getTenantById, listAllTenants, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Region, Tenant } from "@/lib/types/tenant";
import { getDecryptedSocialTokens } from "@/lib/social/connections";
import { publishToX, fetchXPublicMetrics } from "@/lib/social/x/client";
import { postToLinkedIn } from "@/lib/social/linkedin/client";
import { personUrn } from "@/lib/social/linkedin/oauth";
import { isSocialPublishEnabled, buildXThread, classifyPublishResult } from "./publishX";
import { AUTO_PLUG_DELAY_MS, thresholdCrossed } from "./autoPlug";
import { isClosedLoopEnabled } from "./feedback/retrieveExemplars";
import { recordExemplar } from "./feedback/recordExemplar";
import { PERFORMANCE_FETCH_DELAY_MS, exemplarQualifies, exemplarTags } from "./feedback/harvest";
import {
  scheduledPostDedupeKey,
  type ScheduledPost,
  type ScheduledPostChannel,
} from "@/lib/types/scheduledPost";
import { expandSpintax } from "./spintax";
import type { PpsResult } from "./pps";

/**
 * Distribute delivery worker — drains the `campaign_scheduled_posts` queue and
 * publishes due posts to their channel. Mirrors the email delivery worker
 * (src/lib/email/delivery.ts): idempotent, best-effort, a failed post retries up
 * to MAX_ATTEMPTS then parks as "failed", and a stale ("processing") claim is
 * reclaimable after the lease.
 *
 * `publishPost` is a MANUAL stamp for channels without a live adapter (flips to
 * "done" with publishedRef.platform === "manual"); channel:'x' publishes for real
 * via publishToX when DISTRIBUTE_SOCIAL_ENABLED is on.
 *
 * EXACTLY-ONCE (D2/D6): the claim below is a Firestore TRANSACTION (repo.claim) —
 * the 60s cron can invoke overlapping runs, and the transactional pending→processing
 * transition (plus publishPost's publishedRef guard) guarantees two workers can't both
 * publish the same post to a channel with no idempotency key (X). This rests on the
 * invariant "a publish finishes within its claim lease": publishToX enforces a
 * wall-time budget (PUBLISH_BUDGET_MS) well under LEASE_MS, so a slow/hung send is
 * aborted rather than outliving its claim and being reclaimed + re-posted. Residual:
 * a hard crash between X accepting a post and Firestore recording publishedRef can
 * still re-post on stale-reclaim — inherent to X's lack of an idempotency key;
 * publishX parks partial/ambiguous/timeout sends to shrink that window.
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

  let processed = 0;
  let done = 0;
  let failed = 0;
  for (const candidate of posts) {
    // EXACTLY-ONCE CLAIM (D2/D6): the query above only finds CANDIDATES — the claim
    // is authoritative. Inside a transaction we re-read the post FRESH and transition
    // pending / stale-processing → processing atomically. Overlapping cron runs both
    // see the candidate, but only one commits the claim; every loser re-reads a
    // "processing" (fresh lease) or terminal ("done"/"failed") status and declines.
    // That is what stops a channel with NO idempotency key (X) from double-posting.
    // A stale post that already carries a publishedRef is still claimed here — but
    // publishPost's top guard reconciles it to "done" WITHOUT re-posting.
    const claimed = await repo.claim(candidate.id, (cur) => {
      const isDue = cur.status === "pending" && cur.scheduledAt <= now;
      const isStale =
        cur.status === "processing" &&
        typeof cur.claimedAt === "string" &&
        cur.claimedAt <= staleBefore;
      if (!isDue && !isStale) return null; // fresh lease / finished / not yet due
      return { status: "processing" as const, attempts: cur.attempts + 1, claimedAt: now };
    });
    if (!claimed) continue; // lost the race, or no longer eligible
    processed += 1;

    try {
      // A "parked" post is terminally failed WITHOUT a throw (a throw means retry).
      // Count it as failed so drain telemetry doesn't over-report success (e.g. an
      // operator draining after connecting X sees an accurate done/failed split).
      const outcome = await dispatchScheduledPost(ctx, claimed, db);
      if (outcome === "parked") failed += 1;
      else done += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      const exhausted = claimed.attempts >= MAX_ATTEMPTS;
      // Mirror the email worker (delivery.ts): flip back to "pending" and LEAVE
      // claimedAt stamped. A pending row is re-eligible via the due-query
      // regardless of claimedAt, and not nulling it avoids ever producing a
      // (processing, null-claim) row the stale-reclaim query could never match.
      await repo.update(claimed.id, {
        status: exhausted ? "failed" : "pending",
        lastError: msg,
        processedAt: exhausted ? new Date().toISOString() : null,
      });
      failed += 1;
    }
  }
  return { processed, done, failed };
}

async function dispatchScheduledPost(
  ctx: TenantContext,
  post: ScheduledPost,
  db?: FirestoreLike,
): Promise<"done" | "parked"> {
  // Exhaustive dispatch: a new jobKind must be handled here or the `never` check
  // below fails to compile. Phase 1 only implements "publish".
  switch (post.jobKind) {
    case "publish":
      return await publishPost(ctx, post, db);
    case "auto_plug_comment":
      return await runAutoPlugComment(ctx, post, db);
    case "performance_fetch":
      return await runPerformanceFetch(ctx, post, db);
    case "auto_engage_draft":
    case "auto_dm":
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
): Promise<"done" | "parked"> {
  const repo = forTenant(ctx, db).scheduledPosts;
  // A retry after a successful-but-unacked publish must never re-post.
  if (post.publishedRef) {
    await repo.update(post.id, {
      status: "done",
      processedAt: new Date().toISOString(),
      lastError: null,
    });
    return "done";
  }
  // Spintax: render ONE fresh variant per publish (recycling anti-duplicate). The
  // rendered copy is what a real Phase-4 adapter would post; stored so the operator
  // sees exactly which variant went out. Falls back to the source verbatim if the
  // template is invalid (expandSpintax never throws).
  const renderedVariant = post.spintaxSource
    ? expandSpintax(post.spintaxSource)
    : undefined;
  const now = new Date().toISOString();
  const renderPatch = renderedVariant !== undefined ? { renderedVariant } : {};

  // Real X publishing (flag-gated). Requires a connected X token; without one the
  // post can't publish → park it (failed) so the operator connects X.
  if (post.channel === "x" && isSocialPublishEnabled()) {
    // NB: no .catch here — a TRANSIENT registry read error must propagate so the
    // worker RETRIES a genuinely-connected tenant, rather than mis-parking it as
    // "not connected". A tenant that simply has no X token yields null (not a throw).
    const tenant = await getTenantById(ctx.tenantId, db);
    const tokens = getDecryptedSocialTokens(tenant, "x");
    if (!tokens) {
      await repo.update(post.id, {
        status: "failed",
        ...renderPatch,
        lastError: "x_not_connected",
        processedAt: now,
      });
      return "parked";
    }
    const parts = buildXThread(post.threadParts, renderedVariant ?? post.body);
    const outcome = classifyPublishResult(await publishToX({ parts, accessToken: tokens.accessToken }));
    if (outcome.kind === "published") {
      await repo.update(post.id, {
        status: "done",
        ...renderPatch,
        publishedRef: { platform: "x", remoteId: outcome.remoteId, url: outcome.url, publishedAt: now },
        processedAt: now,
        lastError: null,
      });
      // Attach follow-ups (poll metrics later). Enqueued AFTER the parent is stamped
      // done (above): publish-first is deliberate so a crash here can only LOSE a
      // follow-up (silent miss), never re-publish the parent (double-tweet). The
      // enqueue can't be atomic with the X post (no idempotency key).
      if (post.autoPlug) await enqueueAutoPlug(repo, post, outcome.remoteId, now);
      // Closed loop: only enqueue a harvest job while the loop is enabled (else junk).
      if (isClosedLoopEnabled()) {
        await enqueuePerformanceFetch(repo, post, outcome.remoteId, renderedVariant ?? post.body, now);
      }
      return "done";
    }
    if (outcome.kind === "park") {
      // NOT retryable (a retry re-posts the thread); park as "failed" for the operator.
      // If a tweet MAY already be live (posted=true: partial thread / ambiguous 2xx),
      // stamp an `x_unconfirmed` publishedRef so schedulePost's re-arm gate (which keys
      // off `!publishedRef`) can't re-publish it — X has no idempotency key. A permanent
      // nothing-posted park (posted=false: empty copy) leaves publishedRef unset so the
      // operator can fix + re-arm safely.
      await repo.update(post.id, {
        status: "failed",
        ...renderPatch,
        ...(outcome.posted
          ? { publishedRef: { platform: "x_unconfirmed", publishedAt: now } }
          : {}),
        lastError: `x_publish:${outcome.reason}`,
        processedAt: now,
      });
      return "parked";
    }
    throw new Error(`x_publish:${outcome.reason}`); // clean failure → worker retries
  }

  // Real LinkedIn publishing (flag-gated, shares DISTRIBUTE_SOCIAL_ENABLED). A single
  // organic post to the member's feed (no threads). Mirrors the X path's classify /
  // park / retry semantics; no follow-up jobs (LinkedIn metrics/closed-loop is a later
  // phase — the auto_plug/performance_fetch enqueues are X-only).
  if (post.channel === "linkedin" && isSocialPublishEnabled()) {
    const tenant = await getTenantById(ctx.tenantId, db);
    // Resolve the author: a linkedin_org URN → post as that Company Page (CM/App-2
    // token, and only if the tenant actually administers it); otherwise → the
    // connected member (personal/App-1 token).
    const wantsOrg = post.linkedInAuthorUrn?.startsWith("urn:li:organization:") ?? false;
    let authorUrn: string | undefined;
    let accessToken: string | undefined;
    if (wantsOrg) {
      const cm = tenant?.socialConnections?.linkedin_org;
      const admins = cm?.orgs?.some((o) => o.urn === post.linkedInAuthorUrn) ?? false;
      const cmTokens = getDecryptedSocialTokens(tenant, "linkedin_org");
      if (cmTokens && admins) {
        authorUrn = post.linkedInAuthorUrn ?? undefined;
        accessToken = cmTokens.accessToken;
      }
    } else {
      const memberId = tenant?.socialConnections?.linkedin?.userId;
      const tokens = getDecryptedSocialTokens(tenant, "linkedin");
      if (tokens && memberId) {
        authorUrn = personUrn(memberId);
        accessToken = tokens.accessToken;
      }
    }
    if (!authorUrn || !accessToken) {
      await repo.update(post.id, {
        status: "failed",
        ...renderPatch,
        lastError: wantsOrg ? "linkedin_page_not_connected" : "linkedin_not_connected",
        processedAt: now,
      });
      return "parked";
    }
    const outcome = classifyPublishResult(
      await postToLinkedIn({ authorUrn, text: renderedVariant ?? post.body, accessToken }),
    );
    if (outcome.kind === "published") {
      await repo.update(post.id, {
        status: "done",
        ...renderPatch,
        publishedRef: { platform: "linkedin", remoteId: outcome.remoteId, url: outcome.url, publishedAt: now },
        processedAt: now,
        lastError: null,
      });
      return "done";
    }
    if (outcome.kind === "park") {
      await repo.update(post.id, {
        status: "failed",
        ...renderPatch,
        ...(outcome.posted
          ? { publishedRef: { platform: "linkedin_unconfirmed", publishedAt: now } }
          : {}),
        lastError: `li_publish:${outcome.reason}`,
        processedAt: now,
      });
      return "parked";
    }
    throw new Error(`li_publish:${outcome.reason}`); // clean failure → worker retries
  }

  // DEFAULT: manual stamp (no live adapter for this channel, or the flag is off).
  // Idempotent by design (the publishedRef guard above) and now protected upstream by
  // the transactional claim, so it is safe under the running 60s cron.
  await repo.update(post.id, {
    status: "done",
    ...renderPatch,
    publishedRef: { platform: "manual", publishedAt: now },
    processedAt: now,
    lastError: null,
  });
  return "done";
}

/**
 * Enqueue the Auto-Plug follow-up for a just-published post carrying an autoPlug
 * rule. A separate `auto_plug_comment` job (deterministic id → idempotent) polls the
 * post's metrics at +AUTO_PLUG_DELAY_MS and posts the promo comment if the threshold
 * is crossed. Only for a REAL X publish (needs the tweet's remoteId).
 */
async function enqueueAutoPlug(
  repo: ReturnType<typeof forTenant>["scheduledPosts"],
  parent: ScheduledPost,
  remoteId: string,
  now: string,
): Promise<void> {
  if (!parent.autoPlug) return;
  const id = `autoplug:${parent.dedupeKey}`;
  const scheduledAt = new Date(Date.parse(now) + AUTO_PLUG_DELAY_MS).toISOString();
  // Re-arm the rule to THIS publish: fresh (firedAt cleared) and targeting the new
  // tweet. UPSERT (not create) so a re-armed + republished parent re-points its
  // singleton auto-plug job at the new remoteId instead of colliding and leaving a
  // stale-target job pointing at the old (possibly deleted) tweet.
  const fields = {
    workspaceId: parent.workspaceId,
    contentPlanId: parent.contentPlanId,
    nodeId: parent.nodeId,
    channel: parent.channel,
    format: null,
    jobKind: "auto_plug_comment" as const,
    status: "pending" as const,
    dedupeKey: id,
    scheduledAt,
    attempts: 0,
    claimedAt: null,
    body: parent.autoPlug.commentBody,
    autoPlug: { ...parent.autoPlug, firedAt: null },
    sourceRemoteId: remoteId,
    publishedRef: null,
    lastError: null,
    processedAt: null,
  };
  const existing = await repo.getById(id);
  if (existing) {
    await repo.update(id, fields as never); // re-target + re-arm for the new publish
  } else {
    await repo.create(id, { ...fields, createdAt: now } as never);
  }
}

/**
 * Auto-Plug worker: poll the source post's public metrics ONCE; if it crossed the
 * threshold, post the promo comment as a reply under it. Reuses the publish
 * idempotency + classification. One-shot: if the threshold isn't met at poll time it
 * completes without firing (never re-posts — the firedAt/publishedRef guard).
 */
async function runAutoPlugComment(
  ctx: TenantContext,
  post: ScheduledPost,
  db?: FirestoreLike,
): Promise<"done" | "parked"> {
  const repo = forTenant(ctx, db).scheduledPosts;
  const now = new Date().toISOString();
  // Idempotency: already fired (comment posted) → done, never re-post.
  if (post.autoPlug?.firedAt || post.publishedRef) {
    await repo.update(post.id, { status: "done", processedAt: now, lastError: null });
    return "done";
  }
  if (!isSocialPublishEnabled()) {
    // No live channel → can't poll/post. Park (not "done") so drain telemetry counts
    // it as failed — a silent done++ would hide that the plug never ran. Re-arm after
    // enabling the flag. (Consistent with the x_not_connected posture below.)
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "social_disabled" });
    return "parked";
  }
  if (!post.sourceRemoteId || !post.autoPlug) {
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "autoplug_misconfigured" });
    return "parked";
  }
  const tenant = await getTenantById(ctx.tenantId, db);
  const tokens = getDecryptedSocialTokens(tenant, "x");
  if (!tokens) {
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "x_not_connected" });
    return "parked";
  }

  const metrics = await fetchXPublicMetrics(post.sourceRemoteId, tokens.accessToken);
  if (!metrics.ok) {
    // Transient read failure → retry; permanent (auth/tier/deleted tweet) → park.
    const cls = classifyPublishResult({ ok: false, reason: metrics.reason });
    if (cls.kind === "retry") throw new Error(`autoplug_metrics:${metrics.reason}`);
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: `autoplug_metrics:${metrics.reason}` });
    return "parked";
  }
  if (!thresholdCrossed(metrics.metrics, post.autoPlug)) {
    // ONE-SHOT (known limitation): a single poll at +AUTO_PLUG_DELAY_MS. If the post
    // hasn't crossed the threshold by then it completes WITHOUT firing and never
    // re-polls — a late-blooming post won't auto-plug. `lastError` distinguishes this
    // from a real fire (which sets publishedRef). A multi-poll window is a follow-up.
    await repo.update(post.id, { status: "done", processedAt: now, lastError: "threshold_not_met" });
    return "done";
  }

  // Fire: post the comment as a reply under the source tweet.
  const outcome = classifyPublishResult(
    await publishToX({
      parts: [post.autoPlug.commentBody],
      accessToken: tokens.accessToken,
      replyToId: post.sourceRemoteId,
    }),
  );
  if (outcome.kind === "published") {
    await repo.update(post.id, {
      status: "done",
      autoPlug: { ...post.autoPlug, firedAt: now },
      publishedRef: { platform: "x", remoteId: outcome.remoteId, url: outcome.url, publishedAt: now },
      processedAt: now,
      lastError: null,
    });
    return "done";
  }
  if (outcome.kind === "park") {
    await repo.update(post.id, {
      status: "failed",
      ...(outcome.posted ? { publishedRef: { platform: "x_unconfirmed", publishedAt: now } } : {}),
      lastError: `autoplug_publish:${outcome.reason}`,
      processedAt: now,
    });
    return "parked";
  }
  throw new Error(`autoplug_publish:${outcome.reason}`); // clean failure → worker retries
}

/**
 * Enqueue the closed-loop harvest follow-up for a just-published post: a singleton
 * `performance_fetch` job that, at +PERFORMANCE_FETCH_DELAY_MS, polls the post's real
 * engagement and — if it crossed the high-performer bar — records it as an exemplar.
 * UPSERT (re-targets on re-publish), carrying the ACTUAL published copy.
 */
async function enqueuePerformanceFetch(
  repo: ReturnType<typeof forTenant>["scheduledPosts"],
  parent: ScheduledPost,
  remoteId: string,
  publishedCopy: string,
  now: string,
): Promise<void> {
  const id = `perf:${parent.dedupeKey}`;
  const scheduledAt = new Date(Date.parse(now) + PERFORMANCE_FETCH_DELAY_MS).toISOString();
  const fields = {
    workspaceId: parent.workspaceId,
    contentPlanId: parent.contentPlanId,
    nodeId: parent.nodeId,
    channel: parent.channel,
    format: parent.format ?? null,
    jobKind: "performance_fetch" as const,
    status: "pending" as const,
    dedupeKey: id,
    scheduledAt,
    attempts: 0,
    claimedAt: null,
    body: publishedCopy, // the exact copy that published — the exemplar candidate
    sourceRemoteId: remoteId,
    publishedRef: null,
    lastError: null,
    processedAt: null,
  };
  const existing = await repo.getById(id);
  if (existing) await repo.update(id, fields as never);
  else await repo.create(id, { ...fields, createdAt: now } as never);
}

/**
 * Closed-loop harvest worker: poll a published post's real engagement ONCE; if it
 * crossed the high-performer bar, capture it as a performance exemplar to weight
 * future Create generations. Best-effort: a permanent metrics failure or a below-bar
 * post simply completes without harvesting; a transient failure retries.
 */
async function runPerformanceFetch(
  ctx: TenantContext,
  post: ScheduledPost,
  db?: FirestoreLike,
): Promise<"done" | "parked"> {
  const repo = forTenant(ctx, db).scheduledPosts;
  const now = new Date().toISOString();
  if (!isClosedLoopEnabled()) {
    await repo.update(post.id, { status: "done", processedAt: now, lastError: "closed_loop_disabled" });
    return "done";
  }
  if (!isSocialPublishEnabled()) {
    // Can't poll X → park (failed++) so telemetry is honest; re-arm after enabling.
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "social_disabled" });
    return "parked";
  }
  if (!post.sourceRemoteId) {
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "perf_misconfigured" });
    return "parked";
  }
  const tenant = await getTenantById(ctx.tenantId, db);
  const tokens = getDecryptedSocialTokens(tenant, "x");
  if (!tokens) {
    await repo.update(post.id, { status: "failed", processedAt: now, lastError: "x_not_connected" });
    return "parked";
  }

  const metrics = await fetchXPublicMetrics(post.sourceRemoteId, tokens.accessToken);
  if (!metrics.ok) {
    const cls = classifyPublishResult({ ok: false, reason: metrics.reason });
    if (cls.kind === "retry") throw new Error(`perf_metrics:${metrics.reason}`);
    // Permanent (deleted tweet / auth) → best-effort give up, no harvest.
    await repo.update(post.id, { status: "done", processedAt: now, lastError: `perf_metrics:${metrics.reason}` });
    return "done";
  }

  if (!exemplarQualifies(metrics.metrics)) {
    await repo.update(post.id, { status: "done", processedAt: now, lastError: "below_bar" });
    return "done";
  }

  // Qualified → harvest. sourcePostId is the PARENT post (strip the perf: prefix) so
  // there is one exemplar per source post. recordExemplar is fail-soft (never throws).
  const parentId = post.dedupeKey.replace(/^perf:/, "");
  const text = post.body; // the published copy carried on the job
  const outcome = await recordExemplar(ctx, {
    channel: post.channel,
    text,
    tags: exemplarTags(text, post.channel, post.format),
    metric: { name: "likes", value: metrics.metrics.likes },
    sourcePostId: parentId,
    sourceRemoteId: post.sourceRemoteId,
  });
  await repo.update(post.id, {
    status: "done",
    processedAt: now,
    lastError: outcome === "recorded" ? null : "exemplar_skipped",
  });
  return "done";
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
  /** Optional `{a|b|c}` template; one variant is rendered at publish (validated by the route). */
  spintaxSource?: string | null;
  /** Predictive Performance Score computed at enqueue (re-checked from the body). */
  pps?: PpsResult | null;
  /** LinkedIn author URN (org URN → post as that Page; absent → personal). */
  linkedInAuthorUrn?: string | null;
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
      spintaxSource: input.spintaxSource ?? null,
      renderedVariant: null,
      pps: input.pps ?? null,
      linkedInAuthorUrn: input.linkedInAuthorUrn ?? null,
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
        // Refresh the payload in case the node/template was edited since scheduling.
        body: input.body,
        spintaxSource: input.spintaxSource ?? null,
        renderedVariant: null, // stale render from a prior arm; re-picked at publish
        threadParts: null, // a prior deconstruction is stale once body is refreshed
        pps: input.pps ?? null,
        linkedInAuthorUrn: input.linkedInAuthorUrn ?? null,
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
 * Update ONLY a post's spintax template (and drop any stale render). Unlike
 * schedulePost this does NOT touch scheduledAt/status/attempts — so editing the
 * template on an overdue-but-pending post can't hit the route's must_be_future
 * guard, and editing a FAILED post doesn't silently un-fail + re-queue it.
 * Rejects a post that's already publishing/done (`already_publishing`) or absent.
 */
export async function setPostSpintax(
  ctx: TenantContext,
  workspaceId: string,
  contentPlanId: string,
  nodeId: string,
  spintaxSource: string | null,
  db?: FirestoreLike,
): Promise<{ post: ScheduledPost }> {
  const dedupeKey = scheduledPostDedupeKey(workspaceId, contentPlanId, nodeId);
  const repo = forTenant(ctx, db).scheduledPosts;
  const existing = await loadEditablePost(repo, dedupeKey);
  const patch = { spintaxSource: spintaxSource ?? null, renderedVariant: null };
  await repo.update(dedupeKey, patch);
  return { post: { ...existing, ...patch } };
}

/** getById + assert the post exists and is still editable (pending/failed, unpublished). */
async function loadEditablePost(
  repo: { getById: (id: string) => Promise<ScheduledPost | null> },
  dedupeKey: string,
): Promise<ScheduledPost> {
  const existing = await repo.getById(dedupeKey);
  if (!existing) throw new SchedulePostConflictError("post_not_found");
  if (
    existing.publishedRef ||
    (existing.status !== "pending" && existing.status !== "failed")
  ) {
    throw new SchedulePostConflictError("already_publishing");
  }
  return existing;
}

/**
 * Attach carousel slide asset refs (filenames served by the workspace asset proxy)
 * to an editable post. Same guards as setPostSpintax.
 */
export async function setPostCarousel(
  ctx: TenantContext,
  workspaceId: string,
  contentPlanId: string,
  nodeId: string,
  carouselAssetRefs: string[],
  db?: FirestoreLike,
): Promise<{ post: ScheduledPost }> {
  const dedupeKey = scheduledPostDedupeKey(workspaceId, contentPlanId, nodeId);
  const repo = forTenant(ctx, db).scheduledPosts;
  const existing = await loadEditablePost(repo, dedupeKey);
  const patch = { carouselAssetRefs };
  await repo.update(dedupeKey, patch);
  return { post: { ...existing, ...patch } };
}

/**
 * Fail-fast editability check — throws SchedulePostConflictError (post_not_found /
 * already_publishing) if the post can't be edited. Used to gate an EXPENSIVE
 * carousel build before spending image-gen calls on a post that can't be attached.
 */
export async function getEditablePost(
  ctx: TenantContext,
  workspaceId: string,
  contentPlanId: string,
  nodeId: string,
  db?: FirestoreLike,
): Promise<ScheduledPost> {
  const dedupeKey = scheduledPostDedupeKey(workspaceId, contentPlanId, nodeId);
  return loadEditablePost(forTenant(ctx, db).scheduledPosts, dedupeKey);
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

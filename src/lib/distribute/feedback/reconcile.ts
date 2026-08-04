import { embedDocument } from "@/lib/agents/embeddings";
import { recordExemplar, scrubExemplarText } from "./recordExemplar";
import { exemplarTags } from "./harvest";
import { isClosedLoopEnabled } from "./retrieveExemplars";
import {
  computeBaseline,
  logOutcome,
  rewardFor,
  promotableCluster,
  clusterStatsFromMembers,
  isSameCluster,
  passesFloors,
  harvestable,
  EXEMPLAR_MIN,
  R_PROMOTE,
  REACH_FLOOR,
  type ClusterMember,
  type RewardTier,
} from "./reward";
import { listSettledForReward, listBaselineCohort, writePostReward } from "@/lib/tenant";
import { writePostPerfVector, findNearestPostVectors } from "@/lib/tenant/postVectors";
import { refreshLearnedPostPatterns } from "./patterns";
import { STEERING_CHANNELS } from "./steeringState";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { PostPerformance, PostReward } from "@/lib/types/postPerformance";

/**
 * Offline reward reconciliation — the second half of the closed loop. Scores settled posts
 * against the tenant's own recent baseline, clusters near-duplicates (embedding + findNearest),
 * applies the repetition penalty + repeatability gate (reward.ts), and records the qualifiers
 * as `performance_exemplars`. Runs after each Distribute drain (gated), bounded per channel,
 * fail-soft per post. Not unit-tested against the fake (embeddings + findNearest need Vertex/
 * real Firestore) — the math it drives is unit-tested in reward.test.ts.
 */

// Single source of truth for learnable channels (kept in sync with the Steering panel).
const CHANNELS = STEERING_CHANNELS;
const BASELINE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const BASELINE_MAX = 200;
const NEIGHBOR_K = 8;
const RECONCILE_MAX_PER_CHANNEL = 20;

function dayOf(post: PostPerformance): string {
  return (post.publishedAt ?? post.createdAt ?? "").slice(0, 10);
}

/** Score one settled post: baseline-relative reward + cluster penalty, persist, maybe harvest.
 *  Returns the final tier so the caller can trigger directive synthesis on a new promotion. */
async function reconcilePost(
  ctx: TenantContext,
  post: PostPerformance,
  baselineUs: number[],
): Promise<RewardTier | null> {
  const measurement = post.measurement;
  if (!measurement) return null;
  const u = logOutcome(measurement.ER);
  const baseline = computeBaseline(baselineUs);

  // Embed the (scrubbed) copy for near-duplicate clustering. If embeddings are off/failed,
  // treat the post as novel (no cluster) rather than blocking the score.
  const text = scrubExemplarText(post.body ?? "");
  const vector = text ? await embedDocument(text, ctx.region) : null;

  let sim = 0;
  let clusterId = post.id;
  let members: ClusterMember[] = [];
  if (vector) {
    const neighbors = await findNearestPostVectors(ctx, post.channel, vector, NEIGHBOR_K, post.id);
    const nearest = neighbors[0];
    if (nearest && isSameCluster(nearest.sim)) {
      sim = nearest.sim;
      clusterId = nearest.clusterId;
      members = neighbors
        .filter((n) => n.clusterId === clusterId && isSameCluster(n.sim))
        .map((n) => ({ u: n.u, day: n.day, above: n.above }));
    } else if (nearest) {
      sim = nearest.sim; // most-similar prior, but below the dup threshold → a fresh singleton
    }
  }

  const clusterStats = members.length ? clusterStatsFromMembers(members) : null;
  const scored = rewardFor({ u, baseline, sim, cluster: clusterStats });

  // Floors: a tiny-reach / low-action post can't be a positive proven performer.
  const floorsOk = passesFloors(measurement.metrics);
  const thisAbove = floorsOk && scored.R_baseline >= R_PROMOTE;
  let R_final = scored.R_final;
  let tier: RewardTier = scored.tier;
  if (!floorsOk) {
    R_final = Math.min(R_final, 0);
    tier = "quarantined";
  } else if (tier === "scored") {
    // Promote the whole cluster (incl. this post) only with repeatable, spread-out evidence.
    const fullCluster = clusterStatsFromMembers([...members, { u, day: dayOf(post), above: thisAbove }]);
    if (promotableCluster(fullCluster)) tier = "promoted";
  }

  const now = new Date().toISOString();
  const reward: PostReward = {
    R_baseline: scored.R_baseline,
    R_final,
    z: scored.z,
    z_cluster: scored.z_cluster,
    novelty: scored.novelty,
    tier,
    computedAt: now,
  };

  // Persist the vector FIRST (so future near-duplicates can cluster to this post), THEN flip
  // the reward to `scored`. If the vector write throws, the reward isn't committed and the post
  // stays `settled` → the next pass re-scores it (findNearest excludes its own id), rather than
  // being permanently scored-but-vectorless (unclusterable).
  if (vector) {
    await writePostPerfVector(
      ctx,
      { id: post.id, channel: post.channel, u, day: dayOf(post), above: thisAbove, clusterId },
      vector,
    );
  }
  await writePostReward(ctx, post.id, { reward, clusterId });

  // Harvest a proven performer (replaces the old flat likes≥25 gate). Excludes `cold` (scored
  // only against the generic prior — no real tenant baseline yet) and `quarantined` (bot/viral
  // extreme-z) via harvestable(tier), so a single lucky/first post can't seed the exemplar store.
  // recordExemplar is fail-soft + scrubs/embeds its own copy for the retrieval store.
  if (floorsOk && harvestable(tier) && R_final >= EXEMPLAR_MIN && post.body) {
    await recordExemplar(ctx, {
      channel: post.channel,
      text: post.body,
      tags: exemplarTags(post.body, post.channel, post.format),
      metric: { name: "reward_x100", value: Math.max(0, Math.round(R_final * 100)) },
      sourcePostId: post.sourcePostId,
      sourceRemoteId: post.sourceRemoteId,
    });
  }
  return tier;
}

/**
 * Reconcile all settled-but-unscored posts for a tenant (all channels), bounded. Returns the
 * number scored. Baseline grows monotonically as we score oldest-first, so within one pass a
 * post's baseline never includes a post published after it.
 */
export async function reconcileTenantRewards(
  ctx: TenantContext,
  db?: FirestoreLike,
): Promise<number> {
  if (!isClosedLoopEnabled()) return 0;
  let scored = 0;
  const sinceIso = new Date(Date.now() - BASELINE_WINDOW_MS).toISOString();
  for (const channel of CHANNELS) {
    let settled: PostPerformance[];
    try {
      settled = await listSettledForReward(ctx, channel, RECONCILE_MAX_PER_CHANNEL, db);
    } catch (err) {
      console.warn("[reconcile] list settled failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
      continue;
    }
    if (!settled.length) continue;

    let cohort: PostPerformance[] = [];
    try {
      cohort = await listBaselineCohort(ctx, channel, sinceIso, BASELINE_MAX, db);
    } catch (err) {
      console.warn("[reconcile] baseline cohort failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    }
    // Only reach-eligible posts define the baseline — a sub-REACH_FLOOR post's ER is computed
    // against the low IMP_FLOOR denominator and would inflate what "normal" engagement means.
    const baselineUs = cohort
      .filter((p) => (p.measurement?.metrics.impressions ?? 0) >= REACH_FLOOR)
      .map((p) => logOutcome(p.measurement!.ER));

    let channelPromoted = false;
    for (const post of settled) {
      try {
        const tier = await reconcilePost(ctx, post, baselineUs);
        if (tier === "promoted") channelPromoted = true;
        if ((post.measurement?.metrics.impressions ?? 0) >= REACH_FLOOR) {
          baselineUs.push(logOutcome(post.measurement!.ER)); // grow the baseline as we go
        }
        scored += 1;
      } catch (err) {
        console.warn(
          "[reconcile] score failed for",
          post.id,
          err instanceof Error ? err.message.slice(0, 200) : "error",
        );
      }
    }
    // A cluster crossed the repeatability gate this pass → re-synthesize the channel's learned
    // directive (fail-soft + separately flag-gated inside refreshLearnedPostPatterns).
    if (channelPromoted) {
      await refreshLearnedPostPatterns(ctx, channel, db).catch(() => {});
    }
  }
  return scored;
}

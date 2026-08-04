import type { MetricRaw } from "@/lib/types/postPerformance";

/**
 * The history-aware reward core — PURE, unit-tested, no I/O. Replaces the old flat
 * "likes ≥ 25" qualifier with a BASELINE-RELATIVE, REPETITION-PENALIZED score so a post is
 * only "good" if it beats the tenant's own recent norm AND isn't a tired repeat of a
 * template that already performs at this level. The impure reconciliation (embedding,
 * clustering, persistence) lives in reconcile.ts; it calls these functions.
 *
 * Founder's rule: "a post that did well once is NOT good if a near-identical post was used
 * before and didn't do exceptionally." Realized by `rewardFor`: a repeat sitting at its
 * cluster's mean scores ~0; only ABOVE-cluster lift or genuine NOVELTY earns credit.
 */

// ── Tunables (env-overridable where a tenant/operator may reasonably want to move them) ──
const SCALE = 1000; // log-outcome scale: u = ln(1 + ER·SCALE); tames the heavy tail
const SIM_DUP = envNum("POST_REWARD_SIM_DUP", 0.92); // ≥ → same cluster (paraphrase/template)
const SIM_NOVEL = envNum("POST_REWARD_SIM_NOVEL", 0.85); // novelty ramp base
const EXTREME_Z = 6; // z above this is quarantined pending a confirming poll (viral vs bot)

/** Reach/action floors — below these a rate is noise, never a positive reward. */
export const REACH_FLOOR = envInt("POST_REWARD_REACH_FLOOR", 200);
export const MIN_ACTIONS = envInt("POST_REWARD_MIN_ACTIONS", 5);
/** Baseline cohort must have ≥ this many settled posts before ANY positive reward is emitted. */
export const MIN_HARD = envInt("POST_REWARD_MIN_BASELINE", 3);
/** Record a performance exemplar when R_final ≥ this (+ floors pass). */
export const EXEMPLAR_MIN = envNum("POST_REWARD_EXEMPLAR_MIN", 0.25);

/** Cluster promotion gate — a *pattern* needs repeatable, above-baseline evidence. */
export const K_CLUSTER = envInt("POST_REWARD_PROMOTE_K", 3); // distinct posts
export const R_PROMOTE = envNum("POST_REWARD_PROMOTE_R", 0.3); // per-post R_baseline bar (≈ z≥0.6)
export const K_DISTINCT_DAYS = envInt("POST_REWARD_PROMOTE_DAYS", 3);

/** Empirical-Bayes prior strength (pseudo-posts) for a cold tenant×channel baseline. */
const PRIOR_N0 = envNum("POST_REWARD_PRIOR_N0", 5);
/** Default global prior when the region has no pooled history yet (log-outcome units). */
const DEFAULT_PRIOR = { m: Math.log(1 + 0.02 * SCALE), mad: 0.5 }; // ~2% ER baseline

function envNum(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : dflt;
}
function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export type RewardTier = "cold" | "quarantined" | "below" | "scored" | "promoted";

export interface Baseline {
  m: number; // median log-outcome
  mad: number; // scaled MAD (robust σ)
  n: number; // cohort size (pre-shrink)
}

/** Running stats for a near-duplicate cluster (maintained in the cluster store via Welford). */
export interface ClusterStats {
  count: number; // distinct member posts
  meanU: number;
  stdU: number;
  distinctDays: number;
  aboveCount: number; // members with R_baseline ≥ R_PROMOTE
}

export interface RewardResult {
  R_baseline: number;
  R_final: number;
  z: number;
  z_cluster: number;
  novelty: number;
  tier: RewardTier;
}

/** Drift-normalized log outcome from the composite engagement rate. */
export function logOutcome(ER: number): number {
  return Math.log(1 + Math.max(0, ER) * SCALE);
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation, scaled to be a robust σ estimate (×1.4826 for normal data). */
export function scaledMad(xs: number[], med: number): number {
  if (!xs.length) return 0;
  return 1.4826 * median(xs.map((x) => Math.abs(x - med)));
}

/**
 * Robust baseline (median + MAD on the log outcome), empirical-Bayes shrunk toward a prior
 * when the cohort is small so a 3-post tenant doesn't over-trust its own sparse history.
 * `us` are the OTHER settled posts' log-outcomes for this tenant×channel (recent window).
 */
export function computeBaseline(us: number[], prior = DEFAULT_PRIOR): Baseline {
  const n = us.length;
  const m0 = median(us);
  const mad0 = scaledMad(us, m0);
  const w = n / (n + PRIOR_N0);
  const m = w * m0 + (1 - w) * prior.m;
  // Shrink the spread too; never let it collapse to 0 (would explode z).
  const madShrunk = w * mad0 + (1 - w) * prior.mad;
  return { m, mad: Math.max(madShrunk, 1e-6), n };
}

export function robustZ(u: number, baseline: Baseline): number {
  return (u - baseline.m) / (baseline.mad + 1e-9);
}

/** Bounded reward transform: clamp(tanh(z/2), −1, 1). z=2→0.76, z=4→0.96; negatives retire. */
export function clampTanh(z: number): number {
  const v = Math.tanh(z / 2);
  return Math.max(-1, Math.min(1, v));
}

/**
 * Novelty from the nearest-neighbor cosine similarity, ramped so that anything in the
 * "same cluster" regime (sim ≥ SIM_DUP) is novelty 0 (judged purely on cluster lift) and
 * anything at/under SIM_NOVEL is novelty 1 (judged on the tenant baseline). This is what
 * makes a near-identical repeat earn ~0 rather than keeping a slice of the baseline reward.
 */
export function noveltyFromSim(sim: number): number {
  return Math.max(0, Math.min(1, (SIM_DUP - sim) / (SIM_DUP - SIM_NOVEL)));
}

/** Do the reach/action floors pass (a tiny-sample high rate is not a win)? */
export function passesFloors(raw: MetricRaw): boolean {
  const actions = raw.likes + raw.comments + raw.shares + (raw.clicks ?? 0);
  return raw.impressions >= REACH_FLOOR && actions >= MIN_ACTIONS;
}

/** Whether a near-neighbor at `sim` should be treated as the SAME cluster. */
export function isSameCluster(sim: number): boolean {
  return sim >= SIM_DUP;
}

/**
 * The core: blend the tenant-baseline reward with the cluster-relative lift, weighted by
 * novelty. A near-identical repeat sitting at its cluster mean → R_final ≈ 0; only
 * above-cluster lift (z_cluster>0) or genuine novelty (novelty→1) earns positive credit;
 * a repeat below its cluster carries a negative (retires a fatigued template).
 */
export function rewardFor(input: {
  u: number;
  baseline: Baseline;
  /** Nearest-neighbor cosine similarity to any prior post (0 if none / first post). */
  sim: number;
  /** The assigned cluster's stats BEFORE adding this post (null if a fresh singleton). */
  cluster: ClusterStats | null;
}): RewardResult {
  const { u, baseline, sim, cluster } = input;
  const z = robustZ(u, baseline);
  const R_baseline = clampTanh(z);
  const novelty = noveltyFromSim(sim);

  // Cluster-relative lift: needs ≥2 prior members for a meaningful distribution.
  let z_cluster = 0;
  if (cluster && cluster.count >= 2 && cluster.stdU > 1e-6) {
    z_cluster = (u - cluster.meanU) / (cluster.stdU + 1e-9);
  }
  // A repeat's credit is capped by BOTH its standing vs the tenant baseline AND its standing
  // vs its own cluster: matching a proven template's mean → 0; beating it → positive; below
  // either → negative (retire the fatigued template, or a below-baseline win doesn't count).
  const clusterLift = Math.min(R_baseline, clampTanh(z_cluster));
  const R_final = novelty * R_baseline + (1 - novelty) * clusterLift;

  const tier = determineTier({ baselineN: baseline.n, z, R_final });
  return { R_baseline, R_final, z, z_cluster, novelty, tier };
}

/**
 * Disposition of a scored post. `cold` (no baseline yet) and `quarantined` (bot/viral-ambiguous
 * extreme z) are NEVER usable — the caller must exclude them from exemplar harvest so a first
 * post scored only against the generic prior, or a bot-inflated spike, can't define "good". A
 * lone novel `scored` post MAY be a soft few-shot exemplar; only a *promotable cluster* (see
 * promotableCluster) ever feeds the learned directive — that is where the repeatability gate lives.
 */
export function determineTier(input: { baselineN: number; z: number; R_final: number }): RewardTier {
  if (input.baselineN < MIN_HARD) return "cold"; // can't define "good" from too little history
  if (input.z > EXTREME_Z) return "quarantined"; // viral-vs-bot ambiguity → confirm later
  if (input.R_final < 0) return "below"; // net-negative: a signal to AVOID
  return "scored";
}

/** Whether a scored post is eligible to be harvested as a retrieval exemplar (soft few-shot). */
export function harvestable(tier: RewardTier): boolean {
  return tier === "scored" || tier === "promoted";
}

/**
 * Cluster-level promotion gate: a pattern enters the learned directive only with repeatable,
 * spread-out, above-baseline evidence — never one lucky burst. `cluster` here INCLUDES the
 * just-added post.
 */
export function promotableCluster(cluster: ClusterStats): boolean {
  return (
    cluster.count >= K_CLUSTER &&
    cluster.aboveCount >= K_CLUSTER &&
    cluster.distinctDays >= K_DISTINCT_DAYS &&
    cluster.meanU > 0
  );
}

/** A prior near-duplicate post, as returned by the vector store's nearest-neighbor query. */
export interface ClusterMember {
  u: number;
  day: string; // YYYY-MM-DD (distinct-days spread)
  above: boolean; // R_baseline ≥ R_PROMOTE when it was scored
}

/** Fold a set of cluster members into running stats (population std over the members). */
export function clusterStatsFromMembers(members: ClusterMember[]): ClusterStats {
  const count = members.length;
  if (count === 0) return { count: 0, meanU: 0, stdU: 0, distinctDays: 0, aboveCount: 0 };
  const meanU = members.reduce((a, m) => a + m.u, 0) / count;
  const variance = members.reduce((a, m) => a + (m.u - meanU) ** 2, 0) / count;
  return {
    count,
    meanU,
    stdU: Math.sqrt(variance),
    distinctDays: new Set(members.map((m) => m.day)).size,
    aboveCount: members.filter((m) => m.above).length,
  };
}

export const REWARD_THRESHOLDS = { SIM_DUP, SIM_NOVEL, R_PROMOTE } as const;

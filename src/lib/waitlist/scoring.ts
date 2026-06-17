/**
 * Leaderboard / queue scoring.
 *
 * Founder decision (2026-06-15): each *verified* referral is worth
 * `campaign.spotsToMoveUponReferral` ("spots skipped per referral", an
 * admin-editable integer per campaign). Signup time breaks ties — earlier
 * signups rank ahead at equal referral weight.
 *
 * We deliberately do NOT collapse signup time into the stored `score` (the
 * classic `referrals * K - unixTimestamp` trick). Two reasons:
 *   1. Mixing a ~10-digit timestamp with a small referral term invites the
 *      seconds-vs-milliseconds precision bug (JS integers are exact only to
 *      2^53) — the timestamp can silently swamp referrals.
 *   2. A magic constant `K` has no honest unit.
 *
 * Instead `score` is a small pure integer (referral weight) and ties are broken
 * by `createdAt ASC` at query time via the composite index
 * (score DESC, createdAt ASC). Final position/leaderboard math lands in Phase 2.
 */

/**
 * Stored, sortable score. Higher = closer to the front of the queue.
 * @param amountReferred         count of verified referrals (integer ≥ 0)
 * @param spotsToMoveUponReferral per-campaign skip weight (integer 0..1000)
 */
export function computeScore(
  amountReferred: number,
  spotsToMoveUponReferral: number,
): number {
  assertNonNegativeInt(amountReferred, "amountReferred");
  assertNonNegativeInt(spotsToMoveUponReferral, "spotsToMoveUponReferral");
  return amountReferred * spotsToMoveUponReferral;
}

/**
 * Effective referral weight used for QUEUE RANKING (not the public top-referrers
 * list): a signup's verified referrals plus any `engagementBonus` earned by
 * completing the post-signup AI conversation. Kept separate from the stored
 * `amountReferred` (which remains the literal, honestly-displayed referral count)
 * so the boost moves a user up their queue position without faking referrals.
 * When no signup has a bonus this equals `amountReferred`, so ranking is
 * unchanged. See lib/waitlist/rank.ts.
 */
export function effectiveReferralWeight(s: {
  amountReferred: number;
  engagementBonus?: number;
}): number {
  return s.amountReferred + (s.engagementBonus ?? 0);
}

/** Queue ordinal used as the deterministic tie-breaker. Integer Unix SECONDS. */
export function signupUnixSeconds(createdAtIso: string): number {
  const ms = Date.parse(createdAtIso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid createdAt timestamp: ${createdAtIso}`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Total order for ranking: higher score first, then earlier signup. Returns a
 * negative number if `a` ranks ahead of `b` (so Array.sort puts the front of
 * the queue first).
 */
export function comparePriority(
  a: { score: number; createdAt: string },
  b: { score: number; createdAt: string },
): number {
  if (a.score !== b.score) return b.score - a.score; // higher score → front
  return signupUnixSeconds(a.createdAt) - signupUnixSeconds(b.createdAt); // earlier → front
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

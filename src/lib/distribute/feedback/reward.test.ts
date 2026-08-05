import { describe, it, expect } from "vitest";
import {
  logOutcome,
  median,
  scaledMad,
  computeBaseline,
  robustZ,
  clampTanh,
  noveltyFromSim,
  passesFloors,
  isSameCluster,
  rewardFor,
  determineTier,
  promotableCluster,
  clusterStatsFromMembers,
  harvestable,
  type Baseline,
  type ClusterStats,
} from "./reward";

describe("statistics primitives", () => {
  it("median handles odd/even", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it("scaledMad is outlier-resistant", () => {
    // one huge outlier barely moves the MAD (unlike stddev)
    const xs = [1, 1, 1, 1, 100];
    expect(scaledMad(xs, median(xs))).toBeLessThan(1); // median=1, |dev| mostly 0
  });
  it("clampTanh is bounded and monotonic", () => {
    expect(clampTanh(0)).toBe(0);
    expect(clampTanh(4)).toBeGreaterThan(0.9);
    expect(clampTanh(-4)).toBeLessThan(-0.9);
    expect(clampTanh(100)).toBeLessThanOrEqual(1);
  });
});

describe("computeBaseline (empirical-Bayes shrink)", () => {
  it("trusts a large cohort's own median", () => {
    const us = Array.from({ length: 40 }, () => logOutcome(0.02));
    const b = computeBaseline(us);
    expect(b.n).toBe(40);
    expect(b.m).toBeCloseTo(logOutcome(0.02), 3);
    expect(b.mad).toBeGreaterThan(0);
  });
  it("shrinks a tiny cohort toward the prior and never collapses the spread", () => {
    const b = computeBaseline([logOutcome(0.5)]); // 1 wild post
    expect(b.n).toBe(1);
    // pulled well below the lone post's own value toward the ~2% prior
    expect(b.m).toBeLessThan(logOutcome(0.5));
    expect(b.mad).toBeGreaterThan(1e-6);
  });
});

describe("floors + clustering thresholds", () => {
  it("passesFloors rejects tiny-reach / low-action posts", () => {
    expect(passesFloors({ impressions: 3, likes: 3, comments: 0, shares: 0 })).toBe(false); // reach
    expect(passesFloors({ impressions: 5000, likes: 2, comments: 0, shares: 0 })).toBe(false); // actions
    expect(passesFloors({ impressions: 5000, likes: 10, comments: 2, shares: 1 })).toBe(true);
  });
  it("isSameCluster / noveltyFromSim ramp", () => {
    expect(isSameCluster(0.95)).toBe(true);
    expect(isSameCluster(0.9)).toBe(false);
    expect(noveltyFromSim(1)).toBe(0); // identical → no novelty
    expect(noveltyFromSim(0.85)).toBeCloseTo(1, 6); // at the ramp base → full novelty
    expect(noveltyFromSim(0)).toBe(1); // completely unrelated → capped at 1
  });
});

describe("rewardFor — the founder's history-aware rule", () => {
  // A healthy baseline: median ER ~2%, some spread, plenty of history.
  const baseline: Baseline = computeBaseline(
    Array.from({ length: 30 }, (_, i) => logOutcome(0.015 + (i % 5) * 0.004)),
  );

  it("a genuinely NOVEL post that beats baseline scores positive (soft exemplar, not promoted)", () => {
    const u = logOutcome(0.08); // ~4× the baseline median
    const r = rewardFor({ u, baseline, sim: 0.1, cluster: null });
    expect(r.novelty).toBe(1);
    expect(r.R_baseline).toBeGreaterThan(0.3);
    expect(r.R_final).toBeGreaterThan(0.3);
    // A lone novel post is a legit soft exemplar (harvestable), but promotion to the learned
    // directive is blocked separately by the repeatability gate (promotableCluster).
    expect(r.tier).toBe("scored");
  });

  it("a near-identical REPEAT sitting at its cluster mean earns ~0 (the core requirement)", () => {
    const clusterMeanU = logOutcome(0.08);
    const cluster: ClusterStats = {
      count: 4,
      meanU: clusterMeanU,
      stdU: 0.15,
      distinctDays: 4,
      aboveCount: 4,
    };
    // The new post matches the cluster mean AND is a near-duplicate (sim high → novelty ~0).
    const r = rewardFor({ u: clusterMeanU, baseline, sim: 0.98, cluster });
    expect(r.novelty).toBeLessThan(0.15);
    expect(Math.abs(r.z_cluster)).toBeLessThan(1e-6);
    expect(Math.abs(r.R_final)).toBeLessThan(0.05); // ≈ 0 — no credit for a tired repeat
  });

  it("a repeat that BEATS its cluster earns positive via cluster lift", () => {
    const cluster: ClusterStats = {
      count: 4,
      meanU: logOutcome(0.05),
      stdU: 0.2,
      distinctDays: 4,
      aboveCount: 3,
    };
    const r = rewardFor({ u: logOutcome(0.15), baseline, sim: 0.98, cluster }); // well above cluster
    expect(r.z_cluster).toBeGreaterThan(0);
    expect(r.R_final).toBeGreaterThan(0.05);
  });

  it("a repeat that UNDER-performs its cluster carries a negative (retire the template)", () => {
    const cluster: ClusterStats = {
      count: 5,
      meanU: logOutcome(0.1),
      stdU: 0.2,
      distinctDays: 5,
      aboveCount: 4,
    };
    const r = rewardFor({ u: logOutcome(0.02), baseline, sim: 0.98, cluster }); // below cluster
    expect(r.z_cluster).toBeLessThan(0);
    expect(r.R_final).toBeLessThan(0);
    expect(r.tier).toBe("below");
  });
});

describe("determineTier", () => {
  it("cold when the baseline cohort is too small (even a strong score)", () => {
    expect(determineTier({ baselineN: 2, z: 3, R_final: 0.8 })).toBe("cold");
  });
  it("quarantines an extreme-z post (bot/viral ambiguity)", () => {
    expect(determineTier({ baselineN: 20, z: 8, R_final: 0.9 })).toBe("quarantined");
  });
  it("below when net-negative, scored when positive with a real baseline", () => {
    expect(determineTier({ baselineN: 20, z: -1, R_final: -0.2 })).toBe("below");
    expect(determineTier({ baselineN: 20, z: 1, R_final: 0.4 })).toBe("scored");
  });
});

describe("harvestable", () => {
  it("allows scored + promoted, blocks cold/quarantined/below", () => {
    expect(harvestable("scored")).toBe(true);
    expect(harvestable("promoted")).toBe(true);
    expect(harvestable("cold")).toBe(false);
    expect(harvestable("quarantined")).toBe(false);
    expect(harvestable("below")).toBe(false);
  });
});

describe("promotableCluster — repeatability gate (no single-post worship)", () => {
  it("does NOT promote a single lucky outlier", () => {
    expect(promotableCluster({ count: 1, meanU: 5, stdU: 0, distinctDays: 1, aboveCount: 1 })).toBe(false);
  });
  it("does NOT promote K posts crammed into one day", () => {
    expect(promotableCluster({ count: 3, meanU: 5, stdU: 0.1, distinctDays: 1, aboveCount: 3 })).toBe(false);
  });
  it("does NOT promote when too few members clear the per-post bar", () => {
    expect(promotableCluster({ count: 4, meanU: 5, stdU: 0.1, distinctDays: 4, aboveCount: 1 })).toBe(false);
  });
  it("promotes a repeatable, spread-out, above-baseline pattern", () => {
    expect(promotableCluster({ count: 3, meanU: 2, stdU: 0.2, distinctDays: 3, aboveCount: 3 })).toBe(true);
  });
});

describe("clusterStatsFromMembers", () => {
  it("computes count/mean/std/distinctDays/aboveCount from neighbors", () => {
    const s = clusterStatsFromMembers([
      { u: 4, day: "2026-07-01", above: true },
      { u: 4, day: "2026-07-01", above: true },
      { u: 6, day: "2026-07-03", above: false },
    ]);
    expect(s.count).toBe(3);
    expect(s.meanU).toBeCloseTo(4.667, 2);
    expect(s.stdU).toBeGreaterThan(0);
    expect(s.distinctDays).toBe(2); // 07-01 collapses
    expect(s.aboveCount).toBe(2);
  });
  it("is empty for no members", () => {
    expect(clusterStatsFromMembers([])).toMatchObject({ count: 0, distinctDays: 0, aboveCount: 0 });
  });
});

describe("robustZ", () => {
  it("is 0 at the median and grows with deviation", () => {
    const b: Baseline = { m: 2, mad: 0.5, n: 20 };
    expect(robustZ(2, b)).toBeCloseTo(0, 6);
    expect(robustZ(3, b)).toBeCloseTo(2, 3);
  });
});

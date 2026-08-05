import { describe, it, expect, afterEach } from "vitest";
import {
  groupByCluster,
  promotedClusters,
  avoidClusters,
  deterministicRationale,
  injectionCohortForNode,
} from "./patterns";
import type { PostPerformance } from "@/lib/types/postPerformance";

/** Minimal scored PostPerformance for the grouping logic. */
function post(over: {
  id: string;
  clusterId: string;
  ER: number;
  rBaseline: number;
  rFinal: number;
  day: string;
}): PostPerformance {
  return {
    id: over.id,
    tenantId: "t",
    channel: "linkedin",
    sourcePostId: over.id,
    workspaceId: "w",
    contentPlanId: "p",
    nodeId: over.id,
    body: `body ${over.id}`,
    hashtags: [],
    snapshots: [],
    rewardStatus: "scored",
    publishedAt: `${over.day}T00:00:00.000Z`,
    createdAt: `${over.day}T00:00:00.000Z`,
    updatedAt: `${over.day}T00:00:00.000Z`,
    clusterId: over.clusterId,
    measurement: {
      windowClosedAt: `${over.day}T00:00:00.000Z`,
      ageHoursAtMeasure: 168,
      metrics: { impressions: 1000, likes: 10, comments: 0, shares: 0 },
      actions: 10,
      ER: over.ER,
      composite: over.ER,
    },
    reward: {
      R_baseline: over.rBaseline,
      R_final: over.rFinal,
      z: 1,
      z_cluster: 0,
      novelty: 0,
      tier: "scored",
      computedAt: `${over.day}T00:00:00.000Z`,
    },
  } as PostPerformance;
}

describe("groupByCluster", () => {
  it("groups scored posts by clusterId", () => {
    const groups = groupByCluster([
      post({ id: "a", clusterId: "c1", ER: 0.05, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-01" }),
      post({ id: "b", clusterId: "c1", ER: 0.06, rBaseline: 0.6, rFinal: 0.6, day: "2026-07-02" }),
      post({ id: "c", clusterId: "c2", ER: 0.01, rBaseline: -0.4, rFinal: -0.4, day: "2026-07-03" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.clusterId === "c1")!.members).toHaveLength(2);
  });
});

describe("promotedClusters (repeatability gate)", () => {
  it("promotes a cluster with 3 above-baseline posts spread over 3 days", () => {
    const posts = [
      post({ id: "a", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-01" }),
      post({ id: "b", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-02" }),
      post({ id: "c", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-03" }),
    ];
    expect(promotedClusters(groupByCluster(posts))).toHaveLength(1);
  });
  it("does NOT promote 3 above-baseline posts on the SAME day (not spread out)", () => {
    const posts = [
      post({ id: "a", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-01" }),
      post({ id: "b", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-01" }),
      post({ id: "c", clusterId: "c1", ER: 0.08, rBaseline: 0.5, rFinal: 0.5, day: "2026-07-01" }),
    ];
    expect(promotedClusters(groupByCluster(posts))).toHaveLength(0);
  });
  it("does NOT promote a single lucky post", () => {
    const posts = [post({ id: "a", clusterId: "c1", ER: 0.2, rBaseline: 0.9, rFinal: 0.9, day: "2026-07-01" })];
    expect(promotedClusters(groupByCluster(posts))).toHaveLength(0);
  });
});

describe("avoidClusters", () => {
  it("flags a ≥2-member cluster whose members average net-negative", () => {
    const posts = [
      post({ id: "a", clusterId: "bad", ER: 0.005, rBaseline: -0.5, rFinal: -0.5, day: "2026-07-01" }),
      post({ id: "b", clusterId: "bad", ER: 0.005, rBaseline: -0.4, rFinal: -0.4, day: "2026-07-02" }),
    ];
    expect(avoidClusters(groupByCluster(posts))).toHaveLength(1);
  });
});

describe("injectionCohortForNode (permanent holdout)", () => {
  const saved = process.env.POST_PATTERNS_HOLDOUT_PCT;
  afterEach(() => {
    if (saved === undefined) delete process.env.POST_PATTERNS_HOLDOUT_PCT;
    else process.env.POST_PATTERNS_HOLDOUT_PCT = saved;
  });

  it("is deterministic for the same node id", () => {
    expect(injectionCohortForNode("node_abc")).toBe(injectionCohortForNode("node_abc"));
  });
  it("assigns everyone to injected when holdout is 0%", () => {
    process.env.POST_PATTERNS_HOLDOUT_PCT = "0";
    for (const id of ["a", "b", "c", "d", "e"]) expect(injectionCohortForNode(id)).toBe("injected");
  });
  it("carves out roughly the configured fraction across many ids", () => {
    process.env.POST_PATTERNS_HOLDOUT_PCT = "20";
    let holdout = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (injectionCohortForNode(`node_${i}`) === "holdout") holdout++;
    const frac = holdout / N;
    expect(frac).toBeGreaterThan(0.12); // ~20% ± sampling
    expect(frac).toBeLessThan(0.28);
  });
});

describe("deterministicRationale", () => {
  it("summarizes promoted evidence in plain language", () => {
    const groups = groupByCluster([
      post({ id: "a", clusterId: "c1", ER: 0.08, rBaseline: 0.4, rFinal: 0.4, day: "2026-07-01" }),
      post({ id: "b", clusterId: "c1", ER: 0.08, rBaseline: 0.4, rFinal: 0.4, day: "2026-07-02" }),
    ]);
    const r = deterministicRationale(groups);
    expect(r).toContain("proven pattern");
    expect(r).toMatch(/\d+%/);
  });
});

import { describe, it, expect } from "vitest";
import { postResultView, resultDay, resultNumbers, RESULT_COPY } from "./postResults";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { PostPerformance } from "@/lib/types/postPerformance";

const T0 = "2026-11-12T07:30:00.000Z";

function post(over: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "post:ws_1:plan_1:n1",
    tenantId: "ten_a",
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: "n1",
    channel: "linkedin",
    jobKind: "publish",
    status: "done",
    dedupeKey: "post:ws_1:plan_1:n1",
    scheduledAt: T0,
    attempts: 0,
    body: "Our sourdough starter turns nine this week.",
    publishedRef: { platform: "linkedin", remoteId: "urn:li:share:1", publishedAt: T0, authorUrn: "urn:li:organization:5" },
    createdAt: T0,
    ...over,
  };
}

function job(over: Partial<ScheduledPost> = {}): ScheduledPost {
  return post({
    id: "perf:post:ws_1:plan_1:n1",
    dedupeKey: "perf:post:ws_1:plan_1:n1",
    jobKind: "performance_fetch",
    status: "pending",
    scheduledAt: "2026-11-14T07:30:00.000Z",
    publishedRef: null,
    lastError: null,
    ...over,
  });
}

const raw = (impressions: number, extra: Partial<{ likes: number; comments: number; shares: number; clicks: number }> = {}) => ({
  impressions,
  likes: extra.likes ?? 0,
  comments: extra.comments ?? 0,
  shares: extra.shares ?? 0,
  ...(extra.clicks !== undefined ? { clicks: extra.clicks } : {}),
});

function record(over: Partial<PostPerformance> = {}): PostPerformance {
  return {
    id: "pp:ten_a:linkedin:post:ws_1:plan_1:n1",
    tenantId: "ten_a",
    channel: "linkedin",
    sourcePostId: "post:ws_1:plan_1:n1",
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: "n1",
    publishedAt: T0,
    body: "",
    hashtags: [],
    snapshots: [],
    rewardStatus: "collecting",
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const measurement = (r: ReturnType<typeof raw>) => ({
  windowClosedAt: "2026-11-19T07:30:00.000Z",
  ageHoursAtMeasure: 168,
  metrics: r,
  actions: r.likes + r.comments + r.shares,
  ER: 0.02,
  composite: 0.02,
});

const reward = (tier: "cold" | "quarantined" | "below" | "scored" | "promoted", R_final = 0, z = 0) => ({
  R_baseline: 0,
  R_final,
  z,
  z_cluster: 0,
  novelty: 0,
  tier,
  computedAt: T0,
});

describe("postResultView", () => {
  it("shows nothing for a post that isn't published, or isn't LinkedIn or X", () => {
    expect(postResultView({ post: post({ status: "pending", publishedRef: null }), job: null, record: null })).toBeNull();
    expect(postResultView({ post: post({ channel: "blog" }), job: job(), record: null })).toBeNull();
  });

  it("says a personal profile post has no results, and shows nothing for an older post without a job", () => {
    const personal = post({ publishedRef: { platform: "linkedin", publishedAt: T0, authorUrn: "urn:li:person:abc" } });
    expect(postResultView({ post: personal, job: null, record: null })).toEqual({ kind: "personal" });
    expect(postResultView({ post: post(), job: null, record: null })).toBeNull();
    const older = post({ publishedRef: { platform: "linkedin", publishedAt: T0 } });
    expect(postResultView({ post: older, job: null, record: null })).toBeNull();
  });

  it("waits for the first read with its day", () => {
    const v = postResultView({ post: post(), job: job(), record: null });
    expect(v).toEqual({ kind: "waiting", firstAt: "2026-11-14T07:30:00.000Z", firstDay: "Sat 14 Nov" });
  });

  it("shows the latest numbers, the day and the final day while collecting", () => {
    const rec = record({
      snapshots: [
        { at: "x", ageHours: 48, source: "linkedin_org", raw: raw(180) },
        { at: "x", ageHours: 72.4, source: "linkedin_org", raw: raw(310) },
        { at: "x", ageHours: 96.2, source: "linkedin_org", raw: raw(412, { likes: 9, comments: 2, shares: 1, clicks: 14 }) },
      ],
    });
    const v = postResultView({ post: post(), job: job({ lastError: "repoll" }), record: rec });
    expect(v).toMatchObject({ kind: "collecting", day: 4, finalDay: "Thu 19 Nov", series: [180, 310, 412, null, null, null] });
    expect(v && "numbers" in v ? v.numbers.map((n) => `${n.value} ${n.label}`) : []).toEqual([
      "412 impressions",
      "9 reactions",
      "2 comments",
      "1 repost",
      "14 clicks",
    ]);
  });

  it("after 7 days a small post says it is too small to learn from", () => {
    const m = raw(13, { clicks: 5 });
    const v = postResultView({
      post: post(),
      job: job({ status: "done" }),
      record: record({ measurement: measurement(m), rewardStatus: "settled" }),
    });
    expect(v).toMatchObject({ kind: "settled", tag: "small", verdict: RESULT_COPY.smallNote });
  });

  it("names an example for new drafts, and compares the rest with the usual", () => {
    const m = raw(1284, { likes: 31, comments: 6, shares: 4 });
    const settled = (r: ReturnType<typeof reward>) =>
      postResultView({
        post: post({ channel: "x", publishedRef: { platform: "x", publishedAt: T0 } }),
        job: job({ status: "done", channel: "x" }),
        record: record({ channel: "x", measurement: measurement(m), rewardStatus: "scored", reward: r }),
      });
    expect(settled(reward("promoted", 0.4, 1.5))).toMatchObject({ tag: "example", verdict: expect.stringContaining("Above your usual for X") });
    expect(settled(reward("scored", 0.1, 1.2))).toMatchObject({ tag: null, verdict: "Above your usual for X." });
    expect(settled(reward("scored", 0.1, 0.2))).toMatchObject({ tag: null, verdict: "About your usual for X." });
    expect(settled(reward("below", -0.3, -1))).toMatchObject({ tag: null, verdict: "Below your usual for X." });
    expect(settled(reward("cold"))).toMatchObject({ tag: null, verdict: RESULT_COPY.comparingCold });
    expect(settled(reward("quarantined", 0, 7))).toMatchObject({ tag: null, verdict: RESULT_COPY.checking });
  });

  it("before scoring, a settled post says it will be compared", () => {
    const m = raw(900, { likes: 20 });
    const v = postResultView({ post: post(), job: job({ status: "done" }), record: record({ measurement: measurement(m), rewardStatus: "settled" }) });
    expect(v).toMatchObject({ kind: "settled", verdict: RESULT_COPY.comparingSoon });
  });

  it("says why results stopped, keeping any numbers already read", () => {
    const rec = record({ snapshots: [{ at: "x", ageHours: 48, source: "linkedin_org", raw: raw(50) }] });
    const notConnected = postResultView({ post: post(), job: job({ status: "failed", lastError: "linkedin_not_connected" }), record: rec });
    expect(notConnected).toMatchObject({ kind: "stopped", message: expect.stringContaining("Settings › Integrations") });
    expect(notConnected && "numbers" in notConnected ? notConnected.numbers[0]?.value : null).toBe(50);
    const gone = postResultView({ post: post(), job: job({ status: "done", lastError: "perf_metrics:li_api_404" }), record: null });
    expect(gone).toMatchObject({ kind: "stopped", message: "LinkedIn no longer has this post, so YouGrow stopped reading its numbers." });
    expect(postResultView({ post: post(), job: job({ status: "done", lastError: "closed_loop_disabled" }), record: null })).toBeNull();
  });
});

describe("resultNumbers and resultDay", () => {
  it("uses each platform's words, in the singular for one", () => {
    expect(resultNumbers("x", raw(1, { likes: 1, comments: 1, shares: 1 })).map((n) => n.label)).toEqual(["view", "like", "reply", "repost"]);
    expect(resultNumbers("linkedin", raw(2)).map((n) => n.label)).toEqual(["impressions", "reactions", "comments", "reposts"]);
  });

  it("formats a day in UTC and gives nothing for a bad date", () => {
    expect(resultDay("2026-11-17T23:30:00.000Z")).toBe("Tue 17 Nov");
    expect(resultDay("not a date")).toBe("");
  });
});

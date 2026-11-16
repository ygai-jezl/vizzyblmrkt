import { describe, it, expect } from "vitest";
import { draftChangeView, loadPostExtras } from "./postExtras";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { postPerformanceDocId } from "@/lib/types/postPerformance";

const T0 = "2026-11-12T07:30:00.000Z";
const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };

function post(id: string, over: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id,
    tenantId: "ten_a",
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: id,
    channel: "linkedin",
    jobKind: "publish",
    status: "done",
    dedupeKey: id,
    scheduledAt: T0,
    attempts: 0,
    body: "Posted text.",
    publishedRef: { platform: "linkedin", publishedAt: T0, authorUrn: "urn:li:organization:5" },
    createdAt: T0,
    ...over,
  };
}

function seedJob(db: FakeFirestore, parentId: string, tenantId = "ten_a"): void {
  db.seed("campaign_scheduled_posts", `perf:${parentId}`, {
    tenantId,
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: parentId,
    channel: "linkedin",
    jobKind: "performance_fetch",
    status: "pending",
    dedupeKey: `perf:${parentId}`,
    scheduledAt: "2026-11-14T07:30:00.000Z",
    attempts: 0,
    body: "Posted text.",
    createdAt: T0,
  });
}

function seedRecord(db: FakeFirestore, parentId: string, tenantId: string, impressions: number): void {
  db.seed("post_performance", postPerformanceDocId("ten_a", "linkedin", parentId), {
    tenantId,
    channel: "linkedin",
    sourcePostId: parentId,
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: parentId,
    publishedAt: T0,
    body: "",
    hashtags: [],
    snapshots: [{ at: T0, ageHours: 72, source: "linkedin_org", raw: { impressions, likes: 1, comments: 0, shares: 0 } }],
    rewardStatus: "collecting",
    createdAt: T0,
    updatedAt: T0,
  });
}

describe("loadPostExtras", () => {
  it("reads each published post's results job and record", async () => {
    const db = new FakeFirestore();
    seedJob(db, "p1");
    seedRecord(db, "p1", "ten_a", 412);
    seedJob(db, "p2");
    const out = await loadPostExtras(ctx, [post("p1"), post("p2"), post("p3", { status: "pending", publishedRef: null })], { results: true, drafts: false }, db);
    expect(out.p1?.result).toMatchObject({ kind: "collecting", day: 3 });
    expect(out.p2?.result).toMatchObject({ kind: "waiting" });
    expect(out.p3).toBeUndefined();
  });

  it("never shows a record stamped with another brand", async () => {
    const db = new FakeFirestore();
    seedJob(db, "p1");
    seedRecord(db, "p1", "ten_other", 9999);
    const out = await loadPostExtras(ctx, [post("p1")], { results: true, drafts: false }, db);
    expect(out.p1?.result).toMatchObject({ kind: "waiting" });
  });

  it("reads nothing with results off, and adds drafts from the posts alone", async () => {
    const db = new FakeFirestore();
    seedJob(db, "p1");
    const out = await loadPostExtras(ctx, [post("p1", { aiBody: "Vizzy text." })], { results: false, drafts: true }, db);
    expect(out.p1?.result).toBeUndefined();
    expect(out.p1?.draft).toMatchObject({ changed: true });
    expect(await loadPostExtras(ctx, [post("p1")], { results: false, drafts: false }, db)).toEqual({});
  });
});

describe("draftChangeView", () => {
  it("is null without a kept draft, unchanged when only spacing differs, and counts changed words", () => {
    expect(draftChangeView({ aiBody: null, body: "x" })).toBeNull();
    expect(draftChangeView({ aiBody: "Same text. ", body: "Same text." })).toEqual({ changed: false, words: 0, segments: [] });
    const v = draftChangeView({ aiBody: "a big cat sat", body: "a small cat sat" })!;
    expect(v).toMatchObject({ changed: true, words: 1 });
    expect(v.segments.filter((s) => s.op !== "same").map((s) => `${s.op}:${s.text.trim()}`)).toEqual(["del:big", "ins:small"]);
  });
});

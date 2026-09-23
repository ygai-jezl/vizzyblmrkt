import { describe, it, expect } from "vitest";
import { programmeOverview } from "./programmeOverview";

const now = new Date("2026-09-23T12:00:00Z");
const ws = { id: "w1", name: "The Weekly Plate" };
const node = (id: string, type: string, status: string, body = "text") => ({ id, type, status, body });

describe("programmeOverview", () => {
  const overview = programmeOverview({
    workspace: ws,
    ideas: [{ status: "captured" }, { status: "templatized" }, { status: "captured" }],
    templates: 4,
    plans: [
      { id: "p1", name: "Batch cooking", graph: { nodes: [node("h", "hub", "generated"), node("s", "spoke", "empty")], edges: [] } },
      { id: "p2", name: "Lunchbox swaps", graph: { nodes: [node("h", "hub", "approved"), node("s", "spoke", "generated")], edges: [] } },
    ] as never,
    posts: [
      { id: "a", workspaceId: "w1", contentPlanId: "p2", channel: "linkedin", jobKind: "publish", status: "pending", scheduledAt: "2026-09-24T07:30:00Z" },
      { id: "b", workspaceId: "w1", contentPlanId: "p2", channel: "x", jobKind: "publish", status: "pending", scheduledAt: "2026-10-20T07:30:00Z" },
      { id: "c", workspaceId: "w1", contentPlanId: "p1", channel: "blog", jobKind: "publish", status: "done", scheduledAt: "2026-09-20T07:30:00Z" },
      { id: "d", workspaceId: "w1", contentPlanId: "p1", channel: "linkedin", jobKind: "publish", status: "failed", scheduledAt: "2026-09-22T07:30:00Z", lastError: "linkedin_not_connected" },
      { id: "e", workspaceId: "w1", contentPlanId: "p1", channel: "linkedin", jobKind: "performance_fetch", status: "done", scheduledAt: "2026-09-21T07:30:00Z" },
    ] as never,
    newsletters: [
      { subject: "Your week, sorted", status: "scheduled", scheduledAt: "2026-09-29T08:00:00Z" },
      { subject: "Last week", status: "sent", scheduledAt: null },
    ],
    now,
  });

  it("counts each pipeline stage (follow-up jobs don't count as posts)", () => {
    expect(overview.pipeline.map((s) => `${s.label}=${s.count}`)).toEqual([
      "Ideas=3",
      "Templates=4",
      "Drafts=2",
      "Scheduled=2",
      "Published=1",
    ]);
    expect(overview.pipeline[0]!.note).toBe("2 not templated yet");
    expect(overview.pipeline[2]!.note).toBe("3 pieces written");
  });

  it("lists the next seven days in time order", () => {
    expect(overview.upcoming.map((u) => `${u.channel}:${u.title}`)).toEqual([
      "LinkedIn:Lunchbox swaps",
      "Newsletter:Your week, sorted",
    ]);
  });

  it("surfaces the hub waiting for approval and the failed post", () => {
    expect(overview.needsYou.map((i) => i.title)).toEqual([
      "Approve the hub of “Batch cooking”",
      "Connect LinkedIn to publish this post",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import {
  isSchedulableNode,
  listSchedulableNodes,
  mondayUTC,
  weekDateKeys,
  dateKeyOf,
  groupPostsByDate,
  formatUtc,
  friendlyScheduleError,
} from "./uiModel";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPost } from "@/lib/types/scheduledPost";

function node(over: Partial<ContentNode> = {}): ContentNode {
  return {
    id: "n1",
    type: "spoke",
    channel: "x",
    role: "Spoke: X",
    position: { x: 0, y: 0 },
    body: "hello",
    placeholderValues: {},
    status: "generated",
    warnings: [],
    ...over,
  } as ContentNode;
}

function plan(id: string, nodes: ContentNode[]): ContentPlan {
  return {
    id,
    tenantId: "t",
    workspaceId: "ws",
    name: `plan ${id}`,
    status: "ready",
    strategy: { objective: "brand_visibility" },
    scope: { topics: [], spark: "" },
    knowledge: { groundingScope: "global", proofAssets: [] },
    topology: { hubChannel: "newsletter", spokeChannels: [] },
    graph: { nodes, edges: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ContentPlan;
}

function post(over: Partial<ScheduledPost> = {}): ScheduledPost {
  return {
    id: "p",
    tenantId: "t",
    workspaceId: "ws",
    contentPlanId: "plan1",
    nodeId: "n1",
    channel: "x",
    jobKind: "publish",
    status: "pending",
    dedupeKey: "p",
    scheduledAt: "2026-07-01T12:00:00.000Z",
    attempts: 0,
    body: "hi",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as ScheduledPost;
}

describe("isSchedulableNode", () => {
  it("accepts a generated node with a body + publishable channel", () => {
    expect(isSchedulableNode(node())).toBe(true);
    expect(isSchedulableNode(node({ status: "approved" }))).toBe(true);
  });
  it("rejects empty / generating / errored nodes", () => {
    expect(isSchedulableNode(node({ status: "empty" }))).toBe(false);
    expect(isSchedulableNode(node({ status: "generating" }))).toBe(false);
    expect(isSchedulableNode(node({ body: "   " }))).toBe(false);
  });
  it("rejects a non-publishable channel (e.g. standalone)", () => {
    expect(isSchedulableNode(node({ channel: "standalone" }))).toBe(false);
  });
});

describe("listSchedulableNodes", () => {
  it("lists publishable, generated nodes not already scheduled", () => {
    const plans = [
      plan("plan1", [
        node({ id: "n1" }),
        node({ id: "n2", status: "empty" }), // not generated → excluded
        node({ id: "n3", channel: "standalone" }), // not publishable → excluded
        node({ id: "n4" }),
      ]),
    ];
    const posts = [post({ contentPlanId: "plan1", nodeId: "n4" })]; // n4 already scheduled
    const out = listSchedulableNodes(plans, posts);
    expect(out.map((s) => s.node.id)).toEqual(["n1"]);
    expect(out[0]!.planName).toBe("plan plan1");
  });
});

describe("calendar bucketing", () => {
  it("mondayUTC returns the Monday midnight of the week", () => {
    // 2026-07-01 is a Wednesday → Monday is 2026-06-29.
    const wed = Date.parse("2026-07-01T15:30:00.000Z");
    expect(new Date(mondayUTC(wed)).toISOString()).toBe("2026-06-29T00:00:00.000Z");
    // A Sunday must map back to the SAME week's Monday (ISO week), not forward.
    const sun = Date.parse("2026-07-05T23:00:00.000Z");
    expect(new Date(mondayUTC(sun)).toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("weekDateKeys yields 7 consecutive day keys", () => {
    const keys = weekDateKeys(mondayUTC(Date.parse("2026-07-01T00:00:00.000Z")));
    expect(keys).toEqual([
      "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02",
      "2026-07-03", "2026-07-04", "2026-07-05",
    ]);
  });

  it("groupPostsByDate buckets by UTC day and sorts within a day", () => {
    const posts = [
      post({ id: "a", scheduledAt: "2026-07-01T18:00:00.000Z" }),
      post({ id: "b", scheduledAt: "2026-07-01T09:00:00.000Z" }),
      post({ id: "c", scheduledAt: "2026-07-02T09:00:00.000Z" }),
    ];
    const g = groupPostsByDate(posts);
    expect(g.get("2026-07-01")!.map((p) => p.id)).toEqual(["b", "a"]);
    expect(g.get("2026-07-02")!.map((p) => p.id)).toEqual(["c"]);
    expect(dateKeyOf("2026-07-02T09:00:00.000Z")).toBe("2026-07-02");
  });
});

describe("formatUtc", () => {
  it("renders a stable UTC string by slicing (no locale/tz dependence)", () => {
    expect(formatUtc("2026-07-01T20:00:00.000Z")).toBe("2026-07-01 20:00 UTC");
    expect(formatUtc("2026-12-31T09:05:00.000Z")).toBe("2026-12-31 09:05 UTC");
  });
  it("passes through a malformed value unchanged", () => {
    expect(formatUtc("not-a-date")).toBe("not-a-date");
  });
});

describe("friendlyScheduleError", () => {
  it("maps known route codes to operator-facing text", () => {
    expect(friendlyScheduleError("must_be_future")).toMatch(/future/i);
    expect(friendlyScheduleError("already_publishing")).toMatch(/already publishing/i);
  });
  it("falls back for unknown codes", () => {
    expect(friendlyScheduleError("request_failed_500")).toMatch(/couldn't/i);
  });
});

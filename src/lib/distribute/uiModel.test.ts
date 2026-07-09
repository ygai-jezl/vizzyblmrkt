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
  toCalendarNewsletters,
  groupNewslettersByDate,
} from "./uiModel";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { Broadcast } from "@/lib/types/broadcast";

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
    scope: { topics: [], spark: "", industryLens: "" },
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

function broadcast(over: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b1",
    tenantId: "t",
    campaignId: "camp1",
    name: "Weekly · Big News",
    subject: "Big News",
    body: "<p>hi</p>",
    status: "scheduled",
    audienceMode: "weekly",
    scheduledAt: null,
    sentAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  } as Broadcast;
}

describe("toCalendarNewsletters", () => {
  it("dates a scheduled newsletter by scheduledAt", () => {
    const items = toCalendarNewsletters([
      broadcast({ id: "b1", status: "scheduled", scheduledAt: "2026-07-03T10:00:00.000Z" }),
    ]);
    expect(items).toEqual([
      { id: "b1", subject: "Big News", dateIso: "2026-07-03T10:00:00.000Z", status: "scheduled" },
    ]);
  });

  it("dates a sent newsletter by sentAt, and prefers scheduledAt when both set", () => {
    expect(
      toCalendarNewsletters([broadcast({ scheduledAt: null, sentAt: "2026-07-01T09:00:00.000Z", status: "sent" })])[0],
    ).toMatchObject({ dateIso: "2026-07-01T09:00:00.000Z", status: "sent" });
    expect(
      toCalendarNewsletters([broadcast({ scheduledAt: "2026-07-05T00:00:00.000Z", sentAt: "2026-07-05T00:01:00.000Z" })])[0],
    ).toMatchObject({ dateIso: "2026-07-05T00:00:00.000Z" });
  });

  it("drops a broadcast with no scheduled/sent date (e.g. a draft), and falls back to name for the subject", () => {
    expect(toCalendarNewsletters([broadcast({ scheduledAt: null, sentAt: null })])).toEqual([]);
    const noSubject = toCalendarNewsletters([
      broadcast({ subject: "", name: "Weekly fallback", scheduledAt: "2026-07-03T10:00:00.000Z" }),
    ]);
    expect(noSubject[0]!.subject).toBe("Weekly fallback");
  });

  it("groupNewslettersByDate buckets by UTC day, sorted within a day", () => {
    const items = toCalendarNewsletters([
      broadcast({ id: "a", scheduledAt: "2026-07-01T18:00:00.000Z" }),
      broadcast({ id: "b", scheduledAt: "2026-07-01T09:00:00.000Z" }),
      broadcast({ id: "c", scheduledAt: "2026-07-02T09:00:00.000Z" }),
    ]);
    const g = groupNewslettersByDate(items);
    expect(g.get("2026-07-01")!.map((n) => n.id)).toEqual(["b", "a"]);
    expect(g.get("2026-07-02")!.map((n) => n.id)).toEqual(["c"]);
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

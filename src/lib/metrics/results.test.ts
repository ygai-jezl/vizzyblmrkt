import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS, meaningsOf, numberKeys, type Meaning } from "./meanings";

// The analytics the screens use are mocked: these tests check what Vizzy gets from them.
const src = vi.hoisted(() => ({
  loadEmailInsights: vi.fn(),
  computeHybridEmailAnalytics: vi.fn(),
  computeHybridSequenceBreakdown: vi.fn(),
  journeyAnalytics: vi.fn(),
  summariseEmailSends: vi.fn(),
  listPostPerformance: vi.fn(),
}));
vi.mock("@/lib/insights/email", () => ({ loadEmailInsights: src.loadEmailInsights }));
vi.mock("@/lib/analytics/email", () => ({ computeHybridEmailAnalytics: src.computeHybridEmailAnalytics, computeHybridSequenceBreakdown: src.computeHybridSequenceBreakdown }));
vi.mock("@/lib/lifecycle/adminApi", () => ({ journeyAnalytics: src.journeyAnalytics }));
vi.mock("@/lib/email/sends", () => ({ summariseEmailSends: src.summariseEmailSends }));
vi.mock("@/lib/tenant/postPerformance", () => ({ listPostPerformance: src.listPostPerformance }));

const { emailResults, postResults } = await import("./results");

const ctx = { tenantId: "ten_fernleaf", region: "us" as const, source: "agent" as const };
const TOTALS = { sends: 3, totalOpens: 9, totalClicks: 2, hardBounces: 1, softBounces: 0, deferrals: 1, complaints: 0, unsubscribes: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  src.summariseEmailSends.mockResolvedValue({ totals: TOTALS, complete: true });
  src.loadEmailInsights.mockResolvedValue({
    basis: "last 30 days",
    programmes: [{ id: "j1", name: "Welcome", href: "/admin/x", sends: 120, openRate: 0.5, clickRate: 0.1 }],
    broadcasts: [{ id: "b1", name: "Spring sale", campaignId: "c1", sentAt: "2026-11-01", sends: 300, openRate: 0.4, clickRate: 0.05 }],
  });
  src.computeHybridEmailAnalytics.mockResolvedValue({
    cards: { sends: 420, deliveryRate: 0.98, openRate: 0.45, clickRate: 0.08 },
    sequences: [{ kind: "sequence", id: "j1", name: "Welcome", enrolled: 100, sent: 120, delivered: 118, opened: 60, clicked: 12, unsubscribed: 1, openRate: 0.51, clickRate: 0.1 }],
    broadcasts: [{ kind: "broadcast", id: "b1", name: "Spring sale", enrolled: 300, delivered: 296, openRate: 0.4, clickRate: 0.05, unsubscribed: 2, pending: false }],
    truncated: false,
  });
  src.journeyAnalytics.mockResolvedValue({ status: 200, body: { items: [{ poolId: "p", itemId: "a", label: "Day 1", sent: 40, opens: 20, clicks: 4, unsubscribes: 0, bounces: 1, complaints: 0, ai: 3 }] } });
  src.listPostPerformance.mockImplementation(async (_ctx: unknown, opts: { channel: string }) =>
    opts.channel === "x"
      ? [
          {
            tenantId: "ten_fernleaf",
            channel: "x",
            sourcePostId: "p1",
            publishedAt: "2026-11-10T00:00:00Z",
            body: "Spring is repotting season.",
            rewardStatus: "settled",
            snapshots: [{ at: "2026-11-12", ageHours: 48, source: "x", raw: { impressions: 900, likes: 30, comments: 4, shares: 5, reposts: 4, quotes: 1, bookmarks: 7 } }],
            measurement: { windowClosedAt: "2026-11-17", metrics: { impressions: 1000, likes: 33, comments: 5, shares: 6, reposts: 5, quotes: 1, bookmarks: 8 }, actions: 80, ER: 0.08, composite: 0.08 },
          },
        ]
      : [],
  );
});

const everyNumberHasAMeaning = (body: unknown) => {
  const keys = [...numberKeys(body)].filter((k) => k !== "meanings");
  for (const k of keys) expect(Object.keys(MEANINGS), `no meaning for "${k}"`).toContain(k);
  const meanings = (body as { meanings: Record<string, unknown> }).meanings;
  for (const k of keys) expect(meanings[k], `"${k}" not explained in the response`).toBeTruthy();
};

describe("email results", () => {
  it("explains every number, for each scope", async () => {
    for (const args of [{ scope: "overview" as const }, { scope: "launch" as const, id: "c1" }, { scope: "journey" as const, id: "j1" }]) {
      const r = await emailResults(ctx, args);
      expect(r.status).toBe(200);
      everyNumberHasAMeaning(r.body);
    }
  });

  it("maps a journey's steps and adds the send-record totals for that journey only", async () => {
    const r = await emailResults(ctx, { scope: "journey", id: "j1" });
    expect(r.body).toMatchObject({ steps: [{ step: "Day 1", sends: 40, uniqueOpens: 20, uniqueClicks: 4, hardBounces: 1 }], detail: { totalOpens: 9, complete: true } });
    expect(src.summariseEmailSends).toHaveBeenCalledWith(ctx, { journeyId: "j1" });
    expect(JSON.stringify(r.body)).not.toContain("\"ai\"");
  });

  it("asks for an id for a launch or a journey, and passes a missing journey through", async () => {
    expect((await emailResults(ctx, { scope: "launch" })).status).toBe(400);
    src.journeyAnalytics.mockResolvedValue({ status: 404, body: { error: "not_found" } });
    expect((await emailResults(ctx, { scope: "journey", id: "nope" })).status).toBe(404);
  });
});

describe("email tests on a launch (WAITLIST_AB_WINNER_ENABLED)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const arm = (variantId: string, label: string, sent: number) => ({
    variantId,
    label,
    sent,
    delivered: sent,
    opened: sent / 2,
    clicked: 1,
    unsubscribed: 0,
    openRate: 0.5,
    clickRate: 1 / sent,
  });
  beforeEach(() =>
    src.computeHybridSequenceBreakdown.mockResolvedValue({
      truncated: false,
      nodes: [
        { ...arm("x", "", 112), nodeId: "email1", label: "Welcome", abTest: true, status: "promoted", winnerVariantId: "var_b", arms: [arm("control", "Control", 60), arm("var_b", "Variant A", 52)] },
        { ...arm("x", "", 40), nodeId: "email2", label: "Nudge", abTest: false, arms: [] },
      ],
    }),
  );

  it("says which version of each test won, every number explained", async () => {
    vi.stubEnv("WAITLIST_AB_WINNER_ENABLED", "true");
    const r = await emailResults(ctx, { scope: "launch", id: "c1" });
    expect(src.computeHybridSequenceBreakdown).toHaveBeenCalledWith(ctx, "journey_c1");
    expect((r.body as { emailTests: unknown }).emailTests).toEqual([
      {
        email: "Welcome",
        winnerPicked: true,
        winner: "Variant A",
        versions: [
          { version: "Control", sends: 60, delivered: 60, uniqueOpens: 30, uniqueClicks: 1, unsubscribes: 0, openRate: 0.5, clickRate: 1 / 60 },
          { version: "Variant A", sends: 52, delivered: 52, uniqueOpens: 26, uniqueClicks: 1, unsubscribes: 0, openRate: 0.5, clickRate: 1 / 52 },
        ],
      },
    ]);
    everyNumberHasAMeaning(r.body);
  });

  it("leaves them out while the switch is off", async () => {
    const r = await emailResults(ctx, { scope: "launch", id: "c1" });
    expect(r.body).not.toHaveProperty("emailTests");
    expect(src.computeHybridSequenceBreakdown).not.toHaveBeenCalled();
  });
});

describe("post results", () => {
  it("gives each post's settled numbers and a total per channel, every number explained", async () => {
    const r = await postResults(ctx, { days: 30 });
    const body = r.body as { totals: Array<Record<string, unknown>>; posts: Array<Record<string, unknown>> };
    expect(body.posts[0]).toMatchObject({ channel: "x", impressions: 1000, bookmarks: 8, engagementRate: 0.08, settled: true });
    expect(body.totals.find((t) => t.channel === "x")).toMatchObject({ posts: 1, impressions: 1000, engagementRate: 0.08 });
    everyNumberHasAMeaning(r.body);
  });

  it("keeps to one channel or one post when asked", async () => {
    await postResults(ctx, { channel: "x", days: 7 });
    expect(src.listPostPerformance).toHaveBeenCalledTimes(1);
    const one = (await postResults(ctx, { days: 30, post: "nope" })).body as { posts: unknown[] };
    expect(one.posts).toEqual([]);
  });
});

describe("the meanings", () => {
  it("set better and family together, on every meaning the learning loops name", () => {
    for (const [k, m] of Object.entries(MEANINGS) as Array<[string, Meaning]>) expect(m.better === undefined, k).toBe(m.family === undefined);
    for (const k of ["editShare", "keptShare", "declineShare", "likedShare", "unusedShare", "remadeShare", "openRate", "clickRate", "engagementRate", "searchClicks"] as const) {
      expect((MEANINGS[k] as Meaning).better, k).toBeDefined();
    }
  });

  it("leave better and family out of answers, which stay as they were", () => {
    const { openRate, editShare } = meaningsOf(["openRate", "editShare"]);
    expect(openRate).not.toHaveProperty("better");
    expect(openRate).not.toHaveProperty("family");
    expect(editShare).toEqual({ ...MEANINGS.editShare, better: undefined, family: undefined });
    expect(Object.keys(editShare!)).not.toContain("family");
  });

  it("are written in house style", () => {
    for (const [k, m] of Object.entries(MEANINGS)) {
      const text = Object.values(m).join(" ");
      expect(dashesIn(text), k).toEqual([]);
      expect(aiTellsIn(text), k).toEqual([]);
    }
  });
});

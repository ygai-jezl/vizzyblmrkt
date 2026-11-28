import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/gemini")>()),
  generateText: vi.fn(),
}));
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  listScoredForChannel: vi.fn(),
  setTenantLearnedChannelPatterns: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/registry")>()),
  getTenantById: vi.fn(),
}));

import { generateText } from "@/lib/agents/gemini";
import { listScoredForChannel, setTenantLearnedChannelPatterns } from "@/lib/tenant";
import { getTenantById } from "@/lib/tenant/registry";
import { LEARNED_PATTERN_VERSIONS } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { LearnLogEntry } from "@/lib/loops/learnLog";
import type { PostPerformance } from "@/lib/types/postPerformance";
import type { Tenant } from "@/lib/types/tenant";
import { refreshLearnedPostPatterns } from "./patterns";

/**
 * The judge defers (learning loops step 5, 4.9): no verdict, or a verdict of unsafe, adopts
 * nothing, a brand's first directive included, and writes a loop_learn line saying why. A safe
 * verdict still adopts, so the next pass after a deferral can.
 */

const ctx: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };

const DIRECTIVE = "Open with a question your reader asks at the counter, then answer it in two lines.";
const SYNTHESIS = JSON.stringify({ directive: DIRECTIVE, labels: ["Question hook"], avoid: ["Long lists of offers"] });
const SAFE = JSON.stringify({ safe: true, score: 72, rationale: "Three question openers averaged well above the usual." });
const UNSAFE = JSON.stringify({ safe: false, score: 10, rationale: "It promises results the posts never showed." });

/** One scored post in cluster c1; three of them on three days pass the repeatability gate. */
function post(id: string, day: string): PostPerformance {
  return {
    id,
    tenantId: ctx.tenantId,
    channel: "linkedin",
    sourcePostId: id,
    workspaceId: "w",
    contentPlanId: "p",
    nodeId: id,
    body: `Fresh sourdough question ${id}`,
    hashtags: [],
    snapshots: [],
    rewardStatus: "scored",
    publishedAt: `${day}T00:00:00.000Z`,
    createdAt: `${day}T00:00:00.000Z`,
    updatedAt: `${day}T00:00:00.000Z`,
    clusterId: "c1",
    measurement: {
      windowClosedAt: `${day}T00:00:00.000Z`,
      ageHoursAtMeasure: 168,
      metrics: { impressions: 1000, likes: 10, comments: 0, shares: 0 },
      actions: 10,
      ER: 0.08,
      composite: 0.08,
    },
    reward: { R_baseline: 0.5, R_final: 0.5, z: 1, z_cluster: 0, novelty: 0, tier: "promoted", computedAt: `${day}T00:00:00.000Z` },
  } as PostPerformance;
}
const PROMOTED = [post("a", "2026-11-02"), post("b", "2026-11-04"), post("c", "2026-11-06")];

function brand(existing?: string): Tenant {
  const fragments = existing
    ? { linkedin: { directive: existing, perform: [], avoid: [], sampleCount: 3, championScore: 60, activeVersion: 1, latestVersion: 1, pinnedVersion: null, frozen: false } }
    : {};
  return { id: ctx.tenantId, learnedPostPatterns: { channelFragments: fragments } } as unknown as Tenant;
}

/** The synthesis answers first, then the judge with `verdict`. */
function judgeSays(verdict: string | null) {
  vi.mocked(generateText).mockReset();
  vi.mocked(generateText).mockResolvedValueOnce(SYNTHESIS).mockResolvedValueOnce(verdict);
}

async function pass(db: FakeFirestore, existing?: string) {
  const lines: LearnLogEntry[] = [];
  vi.mocked(getTenantById).mockResolvedValue(brand(existing));
  await refreshLearnedPostPatterns(ctx, "linkedin", db, { log: (e) => lines.push(e) });
  return lines;
}

const deferral = (code: string) =>
  expect.objectContaining({
    event: "loop_learn",
    kind: "post_feedback",
    outcome: "skipped",
    reason: "error",
    code,
    scope: "linkedin",
    severity: "WARNING",
    tenantId: ctx.tenantId,
    region: "us",
  });

beforeEach(() => {
  vi.stubEnv("POST_PATTERNS_LEARN_ENABLED", "true");
  vi.mocked(listScoredForChannel).mockResolvedValue(PROMOTED);
  vi.mocked(setTenantLearnedChannelPatterns).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the judge defers", () => {
  it("adopts nothing when the judge gives no answer, a first directive included", async () => {
    const db = new FakeFirestore();
    judgeSays(null);
    const lines = await pass(db);
    expect(db.dump(LEARNED_PATTERN_VERSIONS)).toEqual([]);
    expect(setTenantLearnedChannelPatterns).not.toHaveBeenCalled();
    expect(lines).toEqual([deferral("judge_unavailable")]);
  });

  it("adopts nothing when the judge answers in prose with no JSON", async () => {
    const db = new FakeFirestore();
    judgeSays("This looks like a sensible change and I would adopt it.");
    const lines = await pass(db, "Lead with the loaf of the day.");
    expect(db.dump(LEARNED_PATTERN_VERSIONS)).toEqual([]);
    expect(setTenantLearnedChannelPatterns).not.toHaveBeenCalled();
    expect(lines).toEqual([deferral("judge_unavailable")]);
  });

  it("never adopts an unsafe first directive", async () => {
    const db = new FakeFirestore();
    judgeSays(UNSAFE);
    const lines = await pass(db);
    expect(db.dump(LEARNED_PATTERN_VERSIONS)).toEqual([]);
    expect(setTenantLearnedChannelPatterns).not.toHaveBeenCalled();
    expect(lines).toEqual([deferral("judge_unsafe")]);
  });

  it("keeps the directive in use over an unsafe proposal, and says so", async () => {
    const db = new FakeFirestore();
    judgeSays(UNSAFE);
    const lines = await pass(db, "Lead with the loaf of the day.");
    expect(setTenantLearnedChannelPatterns).not.toHaveBeenCalled();
    expect(lines).toEqual([deferral("judge_unsafe")]);
  });

  it("reads a verdict with no clear safe as unsafe", async () => {
    for (const verdict of [JSON.stringify({ score: 90, rationale: "Fine." }), JSON.stringify({ safe: "yes", score: 90 })]) {
      const db = new FakeFirestore();
      judgeSays(verdict);
      expect(await pass(db)).toEqual([deferral("judge_unsafe")]);
      expect(db.dump(LEARNED_PATTERN_VERSIONS)).toEqual([]);
    }
  });

  it("puts no words from the posts, the proposal or the verdict in the line", async () => {
    const db = new FakeFirestore();
    judgeSays(UNSAFE);
    const [line] = await pass(db);
    const text = JSON.stringify(line);
    for (const words of ["sourdough", "counter", "promises", "Question hook"]) expect(text).not.toContain(words);
  });

  it("writes the line to the log by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    judgeSays(null);
    vi.mocked(getTenantById).mockResolvedValue(brand());
    await refreshLearnedPostPatterns(ctx, "linkedin", new FakeFirestore());
    const logged = warn.mock.calls.map(([first]) => (typeof first === "string" && first.startsWith("{") ? JSON.parse(first) : null)).filter(Boolean);
    expect(logged).toEqual([deferral("judge_unavailable")]);
  });
});

describe("a safe verdict", () => {
  it("adopts the first directive and writes no line", async () => {
    const db = new FakeFirestore();
    judgeSays(SAFE);
    const lines = await pass(db);
    expect(lines).toEqual([]);
    expect(db.dump(LEARNED_PATTERN_VERSIONS)).toEqual([expect.objectContaining({ channel: "linkedin", version: 1, directive: DIRECTIVE, createdBy: "auto" })]);
    expect(setTenantLearnedChannelPatterns).toHaveBeenCalledWith(ctx.tenantId, "linkedin", expect.objectContaining({ directive: DIRECTIVE, activeVersion: 1 }));
  });

  it("adopts on the next pass after a deferral", async () => {
    const db = new FakeFirestore();
    judgeSays(null);
    expect(await pass(db)).toEqual([deferral("judge_unavailable")]);
    judgeSays(SAFE);
    expect(await pass(db)).toEqual([]);
    expect(db.dump(LEARNED_PATTERN_VERSIONS)).toHaveLength(1);
  });
});

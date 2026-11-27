import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { saveBrandMap } from "@/lib/brandMap/store";
import type { SearchOutcome } from "@/lib/search/query";
import { addLearned, listLearned } from "@/lib/autopilot/learned";
import { readLearned, skipPick } from "@/lib/autopilot/adminApi";
import type { Candidate } from "./candidates";
import { dropPick, goalLine, linesFor, pickNextUp, readNextUp, readPicks, reasonHolds, type PickDeps } from "./pick";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { StrategySchema, type Strategy } from "@/lib/types/brandStrategy";
import { NOT_SHARED_NEXT_UP, readSearchPlanning, searchConsoleLines } from "@/lib/connectors/signals/planning";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = new Date("2026-11-18T12:00:00.000Z");

const cand = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  questionId: `q_aaaaaaa${n}`,
  question: `Question ${n}?`,
  subjectId: "sub_aaaaaaaa",
  subjectName: "Share of voice",
  answered: 2,
  total: 7,
  lastArticleAt: "2026-10-08T00:00:00.000Z",
  focus: false,
  ...over,
});

const searchWith = (titles: Array<[string, string]>): SearchOutcome => ({
  ok: true,
  result: { hits: titles.map(([kind, title]) => ({ sourceKey: `${kind}:${title}`, kind: kind as never, ref: title, title, url: "/x", snippet: "", matched: "both", score: 1 })), reranked: false, meaning: true },
});

describe("what is known about a candidate", () => {
  it("numbers its lines and makes a chip of each", () => {
    const lines = linesFor(3, cand(1), { search: searchWith([["newsletter", "October newsletter"], ["competitor", "Rival A: Share of voice in 2026"]]), flag: { they: 3, flag: "crowded" }, now: NOW });
    expect(lines.map((l) => l.id)).toEqual(["3.1", "3.2", "3.3", "3.4"]);
    expect(lines[0]!.text).toBe("Brand map: 2 of 7 questions on this subject answered; last article went live 41 days ago.");
    expect(lines.map((l) => l.chip.kind)).toEqual(["map", "you", "them", "them"]);
    expect(lines[3]!.text).toContain("competitors write on it twice as much as you (3 competitor articles in 90 days)");
  });
});

describe("checking the reasons", () => {
  const lines = linesFor(1, cand(1), { search: searchWith([["competitor", "Rival A: Share of voice in 2026"]]), now: NOW });

  it("holds when every number and competitor it names is in its lines", () => {
    expect(reasonHolds("2 of 7 answered and 41 days without an article; Rival A wrote a case study.", lines, ["Rival A", "Rival B"])).toBe(true);
  });

  it("fails on a number or competitor its lines don't show", () => {
    expect(reasonHolds("1,240 impressions and no page in the top 10.", lines, ["Rival A"])).toBe(false);
    expect(reasonHolds("Rival B wrote on it this week.", lines, ["Rival A", "Rival B"])).toBe(false);
  });

  it("keeps the picks that hold, once each, with chips from the lines they used", () => {
    const weighed = [cand(1), cand(2)].map((c, i) => ({ candidate: c, lines: linesFor(i + 1, c, { search: searchWith([["post", `Post ${i}`]]), now: NOW }) }));
    const raw = JSON.stringify({
      picks: [
        { n: 2, because: "Only 2 of 7 answered.", uses: ["2.1", "2.2"] },
        { n: 2, because: "Again.", uses: [] },
        { n: 1, because: "It has 900 searches.", uses: ["1.1"] },
        { n: 9, because: "No such candidate.", uses: [] },
      ],
    });
    const picks = readPicks(raw, weighed, []);
    expect(picks.map((p) => p.questionId)).toEqual(["q_aaaaaaa2"]);
    expect(picks[0]!.chips.map((c) => c.kind)).toEqual(["map", "you"]);
    expect(readPicks("not json", weighed, [])).toEqual([]);
  });
});

describe("choosing Next up", () => {
  beforeEach(() => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function setup(): Promise<PickDeps & { db: FakeFirestore }> {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme", statement: "Tracks brands in AI answers.", isNot: ["An astrology app"] }, subjects: [] }) }, { db, nowMs: NOW.getTime() });
    return {
      db,
      now: () => NOW,
      loadTenant: async () => ({ id: "ten_A", autopilot: { focus: "More agencies" } }) as never,
      candidates: async (_ctx, opts) => [cand(1), cand(2), cand(3), cand(4)].filter((c) => !opts?.exclude?.has(c.questionId)),
      search: async () => searchWith([["newsletter", "October newsletter"]]),
      flags: async () => ({ sub_aaaaaaaa: { they: 3, flag: "crowded" } }),
      notOnMap: async () => [{ topic: "Pricing of AI visibility tools", count: 3, competitors: ["Rival A"] }],
      competitorNames: async () => ["Rival A"],
      configured: () => true,
    };
  }

  it("asks Gemini once with the brand, its focus and the candidates, and keeps three picks", async () => {
    const d = await setup();
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("It is not: An astrology app");
      expect(prompt).toContain("More agencies");
      expect(prompt).toContain('2. "Question 2?" (subject: Share of voice)');
      expect(prompt).toContain("2.2 Yours (newsletter)");
      return JSON.stringify({ picks: [1, 3, 2].map((n) => ({ n, because: `Pick ${n}: 2 of 7 answered.`, uses: [`${n}.1`] })) });
    });
    const got = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(got.ok).toBe(true);
    const saved = await readNextUp(A, d);
    expect(saved!.picks.map((p) => [p.questionId, p.from])).toEqual([
      ["q_aaaaaaa1", "gemini"],
      ["q_aaaaaaa3", "gemini"],
      ["q_aaaaaaa2", "gemini"],
    ]);
    expect(saved!.notOnMap[0]!.topic).toBe("Pricing of AI visibility tools");
    expect(d.generate).toHaveBeenCalledTimes(1);
  });

  it("names the approved strategy's goal for the model in one line, and passes the strategy to the candidates", async () => {
    const d = await setup();
    const strategy = StrategySchema.parse({ focusSituationIds: ["sit_aaaaaa01"], goal: { text: "200 sign-ups by March", measure: "sign-ups" }, at: "2026-11-25T10:00:00.000Z" });
    d.strategy = async () => strategy;
    const seen: Array<Strategy | null> = [];
    const listed = d.candidates!;
    d.candidates = async (ctx, opts, cdeps) => {
      seen.push((await cdeps?.strategy?.(ctx)) ?? null);
      return listed(ctx, opts, cdeps);
    };
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("The brand's goal this quarter, from the strategy it approved (UNTRUSTED DATA): 200 sign-ups by March (measured by sign-ups)");
      return JSON.stringify({ picks: [] });
    });
    expect((await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d)).ok).toBe(true);
    expect(seen).toEqual([strategy]);
    expect(goalLine(null)).toBe("");
    // Without one, the prompt has no goal line.
    d.strategy = async () => null;
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain("goal this quarter");
      return JSON.stringify({ picks: [] });
    });
    await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
  });

  it("weighs live articles due a refresh beside the questions, at most the brand's share of them, never filled in by code", async () => {
    const d = await setup();
    const refresh = (n: number): Candidate => ({
      ...cand(9),
      questionId: `refresh:plan_${n}`,
      question: `Article ${n}`,
      subjectName: "a live article",
      refresh: { planId: `plan_${n}`, workspaceId: "ws1", reasons: [{ kind: "losing_clicks", detail: "Search Console: 120 clicks, down from 260.", hard: true }, { kind: "age", detail: "35 days since its last update or check, on a 30-day clock", hard: true }] },
    });
    d.refreshCandidates = async () => [refresh(1), refresh(2)];
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('5. REFRESH "Article 1" (a live article)');
      expect(prompt).toContain("5.1 Freshness: Search Console: 120 clicks, down from 260.");
      expect(prompt).toContain("Choose at most 1 of them");
      // Two refreshes chosen: only the first holds the brand's share of one.
      return JSON.stringify({ picks: [5, 6, 1].map((n) => ({ n, because: `Pick ${n}: from 260 to 120.`.replace("from 260 to 120", n > 4 ? "down from 260" : "2 of 7 answered"), uses: [`${n}.1`] })) });
    });
    const got = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    const picks = got.ok ? got.doc.picks : [];
    expect(picks.map((p) => [p.questionId, p.kind ?? "write"])).toEqual([
      ["refresh:plan_1", "refresh"],
      ["q_aaaaaaa1", "write"],
      ["q_aaaaaaa2", "write"],
    ]);
    expect(picks[0]).toMatchObject({ planId: "plan_1", workspaceId: "ws1", chips: [{ kind: "num", label: "Search Console", text: "120 clicks, down from 260." }] });
    // With no refresh share, none is offered at all.
    d.loadTenant = async () => ({ id: "ten_A", refreshShare: 0 }) as never;
    d.generate = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain("REFRESH");
      return null;
    });
    const none = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(none.ok && none.doc.picks.every((p) => p.kind !== "refresh")).toBe(true);
  });

  it("takes Not now on a refresh pick, rests the article and says so on the Learned list", async () => {
    const d = await setup();
    const refresh: Candidate = {
      ...cand(9),
      questionId: "refresh:3ff11b5f-6081-463c-b9c0-1c90d46d3975",
      question: "Article 1",
      subjectName: "a live article",
      refresh: { planId: "3ff11b5f-6081-463c-b9c0-1c90d46d3975", workspaceId: "ws1", reasons: [{ kind: "age", detail: "35 days since its last update or check, on a 30-day clock", hard: true }] },
    };
    d.refreshCandidates = async () => [refresh];
    d.generate = async () => JSON.stringify({ picks: [5, 1, 2].map((n) => ({ n, because: `Pick ${n}.`, uses: [] })) });
    const first = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(first.ok && first.doc.picks[0]!.questionId).toBe(refresh.questionId);

    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    const r = await skipPick(A, { questionId: refresh.questionId, question: "Article 1", reason: "updated it by hand" }, { db: d.db, canUse: async () => true });
    expect(r.status).toBe(200);
    expect((r.body as { nextUp: { picks: Array<{ questionId: string }> } }).nextUp.picks.map((p) => p.questionId)).not.toContain(refresh.questionId);
    const learned = await listLearned(A, d);
    expect(learned[0]).toMatchObject({ kind: "skipped_pick", questionId: refresh.questionId });
    const read = await readLearned(A, { db: d.db, canUse: async () => true });
    expect((read.body as { learned: Array<{ line: string }> }).learned[0]!.line).toBe('Skipped refreshing the live article: "Article 1", because updated it by hand');

    const again = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(again.ok && again.doc.picks.map((p) => p.questionId)).not.toContain(refresh.questionId);
    // Anything else is still refused.
    expect((await skipPick(A, { questionId: "refresh:../x", question: "x" }, { db: d.db, canUse: async () => true })).status).toBe(400);
  });

  it("fills in from code, plainly, when Gemini gives too few or none", async () => {
    const d = await setup();
    d.generate = async () => null;
    const got = await pickNextUp(A, { by: "schedule", deadlineMs: Date.now() + 60_000 }, d);
    expect(got.ok && got.doc.picks.map((p) => p.from)).toEqual(["code", "code", "code"]);
    expect(got.ok && got.doc.picks[0]!.because).toBe("Share of voice has 2 of 7 questions answered.");
  });

  it("never offers a question skipped lately, and Not now keeps why on the Learned list", async () => {
    const d = await setup();
    d.generate = async () => null;
    await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    const r = await skipPick(A, { questionId: "q_aaaaaaa1", question: "Question 1?", reason: "not this quarter" }, { db: d.db, canUse: async () => true });
    expect(r.status).toBe(200);
    expect((r.body as { nextUp: { picks: Array<{ questionId: string }> } }).nextUp.picks.map((p) => p.questionId)).not.toContain("q_aaaaaaa1");
    expect((await listLearned(A, d))[0]).toMatchObject({ kind: "skipped_pick", questionId: "q_aaaaaaa1", reason: "not this quarter" });
    const again = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(again.ok && again.doc.picks.map((p) => p.questionId)).toEqual(["q_aaaaaaa2", "q_aaaaaaa3", "q_aaaaaaa4"]);
  });

  it("counts each pick once when it comes off the list: Not now as declined, used as kept (learning loops step 5)", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const d = await setup();
    d.generate = async () => null;
    await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    await skipPick(A, { questionId: "q_aaaaaaa1", question: "Question 1?", reason: "not this quarter" }, { db: d.db, canUse: async () => true });
    expect(await dropPick(A, "q_aaaaaaa2", "kept", d)).not.toBeNull();
    // A pick already off the list counts nothing more.
    expect(await dropPick(A, "q_aaaaaaa2", "kept", d)).toBeNull();
    const week = sumWeek(d.db, A.tenantId, loopWeekOf(new Date())) as { c: Record<string, Record<string, unknown>> };
    expect(week.c.next_up!.next_up).toEqual({ v0: { none: { made: 3, declined: 1, kept: 1 } } });
  });

  it("says when there is nothing to choose from", async () => {
    const d = await setup();
    d.candidates = async () => [];
    expect(await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d)).toEqual({ ok: false, error: "no_questions" });
  });

  it("keeps each brand's Next up apart", async () => {
    const d = await setup();
    d.generate = async () => null;
    await addLearned(A, { kind: "moved", text: "x", from: "person" }, d);
    await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(await readNextUp({ ...A, tenantId: "ten_B" }, d)).toBeNull();
  });
});

describe("Search Console demand (CONNECTOR_SIGNALS_ENABLED)", () => {
  // Made-up demand for a made-up site, as the planning docs hold it.
  const site = (name: string, id: string) => ({
    connectionId: id,
    site: name,
    window: { from: "2026-10-24", to: "2026-11-20" },
    days: 28,
    timeZone: "America/Los_Angeles",
    questions: new Map([["q_aaaaaaa1", { key: "q_aaaaaaa1", label: "track brand in chatgpt", subjectId: "sub_aaaaaaaa", m: { searchImpressions: 880, searchClicks: 21, searchPosition: 11.32 } }]]),
    subjects: new Map([["sub_aaaaaaaa", { key: "sub_aaaaaaaa", m: { nearbySearches: 14, searchImpressions: 6400, searchClicks: 210 } }]]),
  });
  const planning = { sites: [site("brand.example", "dcn_aaaaaaaaaaaaaaaaaaaa")], notShared: false };

  it("adds the search with the question's words and the searches near its subject, as Search Console chips", () => {
    const lines = linesFor(1, cand(1), { search: null, searchConsole: searchConsoleLines(cand(1), planning), now: NOW });
    expect(lines.slice(1).map((l) => l.text)).toEqual([
      'Search Console (28 days to 20 Nov, Pacific time): the search "track brand in chatgpt" had 880 impressions and 21 clicks, average position 11.3.',
      "Search Console (28 days to 20 Nov, Pacific time): 14 searches near this subject had 6,400 impressions and 210 clicks.",
    ]);
    expect(lines.slice(1).map((l) => l.chip)).toEqual([
      { kind: "num", label: "Search Console", text: "880 impressions, position 11.3" },
      { kind: "num", label: "Search Console", text: "14 nearby searches, 6,400 impressions" },
    ]);
    // Every number a reason takes from them is in the lines, so the pick holds.
    expect(reasonHolds("It sits just off Google's first page at position 11.3, with 880 impressions and 6,400 nearby.", lines, [])).toBe(true);
    expect(reasonHolds("It had 1,900 impressions.", lines, [])).toBe(false);
    // Only the subject's line for a question whose words nobody searched.
    expect(searchConsoleLines(cand(2), planning).map((l) => l.kind)).toEqual(["subject"]);
    expect(searchConsoleLines(cand(2, { subjectId: "sub_bbbbbbbb" }), planning)).toEqual([]);
  });

  it("names the site when the brand has more than one Search Console site", () => {
    const two = { sites: [site("brand.example", "dcn_aaaaaaaaaaaaaaaaaaaa"), { ...site("docs.brand.example", "dcn_bbbbbbbbbbbbbbbbbbbb"), questions: new Map() }], notShared: false };
    const [exact, near] = searchConsoleLines(cand(1), two);
    expect(exact!.text).toMatch(/^Search Console, brand\.example \(28 days to 20 Nov, Pacific time\): the search "track brand in chatgpt"/);
    expect(exact!.chip).toBe("brand.example: 880 impressions, position 11.3");
    expect(near!.site).toBe("brand.example");
  });

  it("reads the planning docs once per pick, and says when Search Console isn't used for planning", async () => {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" }, subjects: [] }) }, { db, nowMs: NOW.getTime() });
    const searchPlanning = vi.fn(async () => planning);
    let prompt = "";
    const base: PickDeps = {
      db,
      now: () => NOW,
      loadTenant: async () => null,
      candidates: async () => [cand(1), cand(2)],
      search: async () => searchWith([]),
      flags: async () => null,
      notOnMap: async () => [],
      competitorNames: async () => [],
      configured: () => true,
      searchPlanning,
      generate: vi.fn(async (p: string) => {
        prompt = p;
        return JSON.stringify({ picks: [{ n: 1, because: "Position 11.3 for a search with 880 impressions.", uses: ["1.3", "1.4"] }] });
      }),
    };
    const got = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, base);
    expect(searchPlanning).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('the search "track brand in chatgpt" had 880 impressions');
    expect(got.ok && got.doc.picks[0]).toMatchObject({ questionId: "q_aaaaaaa1", from: "gemini", chips: [{ label: "Search Console", text: "880 impressions, position 11.3" }, { label: "Search Console", text: "14 nearby searches, 6,400 impressions" }] });
    expect(got.ok && got.doc.missing).not.toContain(NOT_SHARED_NEXT_UP);
    const unshared = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, { ...base, searchPlanning: async () => ({ sites: [], notShared: true }) });
    expect(unshared.ok && unshared.doc.missing).toContain("Search Console isn't shared with your team and Vizzy, so its numbers weren't weighed.");
  });
});

describe("reading Search Console demand", () => {
  const SC = "dcn_ssssssssssssssssssss";
  beforeEach(() => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads only connections members and Vizzy may both read, and nothing while signals are off", async () => {
    const { seedSearchConsole, writePlanning } = await import("@/lib/connectors/testing/signals");
    const { changeDataConnection } = await import("@/lib/tenant");
    const db = new FakeFirestore();
    await seedSearchConsole(A, db, SC);
    await writePlanning(A, db, SC, "question", [{ key: "q_aaaaaaa1", label: "track brand in chatgpt", m: { searchImpressions: 880, searchClicks: 21, searchPosition: 11.3 } }]);
    const read = await readSearchPlanning(A, { db });
    expect(read).toMatchObject({ notShared: false, sites: [{ connectionId: SC, site: "fernhill.example", days: 28, window: { to: "2026-11-20" } }] });
    expect(read!.sites[0]!.questions.get("q_aaaaaaa1")).toMatchObject({ label: "track brand in chatgpt" });
    await changeDataConnection(A, SC, () => ({ patch: { grants: [{ to: "members", can: "read" }] }, activity: [] }), db);
    expect(await readSearchPlanning(A, { db })).toEqual({ sites: [], notShared: true });
    // With Vizzy's reads off in this copy nobody could share it with Vizzy, so Next up says nothing of it.
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "false");
    expect(await readSearchPlanning(A, { db })).toEqual({ sites: [], notShared: false });
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    expect(await readSearchPlanning(A, { db })).toBeNull();
  });
});

describe("AI answers in Next up (CONNECTOR_AI_ANSWERS_ENABLED, ADR-0019)", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function setup() {
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    const { parseManifest } = await import("@/lib/connectors/manifest");
    const { testMcpManifest } = await import("@/lib/connectors/testing/mcpServer");
    const { PLANNING } = await import("@/lib/connectors/testing/signals");
    const { PROMPT_MEASURES, readAiAnswers } = await import("@/lib/connectors/signals/aiAnswers");
    const { createDataConnection } = await import("@/lib/tenant");
    const { healthyAt } = await import("@/lib/connectors/health");
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" }, subjects: [] }) }, { db, nowMs: NOW.getTime() });
    // A made-up AI answers tool: it declares signals.ai_answers and gives each monitored prompt's numbers.
    const made = parseManifest(testMcpManifest);
    const tool = { ...made, uses: ["vizzy.read" as const, "signals.ai_answers" as const], produces: [{ ...made.produces[2]!, stream: "prompts", measures: [...PROMPT_MEASURES] }] };
    const at = NOW.toISOString();
    await createDataConnection(
      A,
      { id: "dcn_aaaaaaaaaaaaaaaaaaaa", connectorId: tool.id, method: "token_fields", label: "Acme", account: "acme.example", ownerUid: "u1", grants: PLANNING, secrets: {}, health: healthyAt(NOW), pausedAt: null, pausedBy: null, status: "connected", createdAt: at, updatedAt: at, disconnectedAt: null },
      [{ kind: "connected", by: "u1", at }],
      db,
    );
    const live = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      value: {
        connectorId: tool.id,
        connector: tool.name,
        stream: "prompts",
        by: "topic" as const,
        period: { from: "2026-10-21", to: "2026-11-17", timeZone: "UTC", finalThrough: "2026-11-17", words: "" },
        rows: [{ prompt: "best geo tools for agencies", promptEngines: 6, promptBrandMentions: 0, promptCompetitors: 4, promptCitations: 30 }],
        totals: null,
        more: false,
        meanings: {},
        notes: [],
        asOf: at,
      },
    }));
    let prompt = "";
    const deps: PickDeps = {
      db,
      now: () => NOW,
      loadTenant: async () => null,
      candidates: async () => [cand(1, { question: "Which GEO tools are best for agencies?" }), cand(2)],
      search: async () => searchWith([]),
      flags: async () => null,
      notOnMap: async () => [],
      competitorNames: async () => [],
      configured: () => true,
      aiAnswers: (c) => readAiAnswers(c, { db, live, manifestOf: (id) => (id === tool.id ? tool : null) }),
      generate: vi.fn(async (p: string) => {
        prompt = p;
        return JSON.stringify({ picks: [{ n: 1, because: "6 AI engines answer it and none named you.", uses: ["1.3"] }] });
      }),
    };
    return { deps, live, prompt: () => prompt };
  }

  it("adds the line for a question close to a monitored prompt, with an AI answers chip, and keeps the pick", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTOR_AI_ANSWERS_ENABLED", "true");
    const { deps, live, prompt } = await setup();
    const got = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, deps);
    expect(live).toHaveBeenCalledTimes(1);
    expect(prompt()).toContain('1.3 AI answers: the monitored prompt "best geo tools for agencies" is answered by 6 AI engines, whose answers named you 0 times and 4 competitors, with 30 citations in all.');
    // Only the question close in wording gets it.
    expect(prompt()).not.toContain("2.3 AI answers");
    expect(got.ok && got.doc.picks[0]).toMatchObject({ questionId: "q_aaaaaaa1", from: "gemini", chips: [{ kind: "num", label: "AI answers", text: '"best geo tools for agencies" answered by 6 engines, you named 0 times' }] });
  });

  it("says nothing of AI answers with the switch off", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    const { deps, live, prompt } = await setup();
    const got = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, deps);
    expect(live).not.toHaveBeenCalled();
    expect(prompt()).not.toContain("AI answers");
    expect(got.ok && got.doc.picks.flatMap((p) => p.chips).some((c) => c.label === "AI answers")).toBe(false);
  });
});

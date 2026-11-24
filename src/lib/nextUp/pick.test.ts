import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { saveBrandMap } from "@/lib/brandMap/store";
import type { SearchOutcome } from "@/lib/search/query";
import { addLearned, listLearned } from "@/lib/autopilot/learned";
import { skipPick } from "@/lib/autopilot/adminApi";
import type { Candidate } from "./candidates";
import { linesFor, pickNextUp, readNextUp, readPicks, reasonHolds, type PickDeps } from "./pick";
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
  const planning = { sites: [site("vizzybl.example", "dcn_aaaaaaaaaaaaaaaaaaaa")], notShared: false };

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
    const two = { sites: [site("vizzybl.example", "dcn_aaaaaaaaaaaaaaaaaaaa"), { ...site("docs.vizzybl.example", "dcn_bbbbbbbbbbbbbbbbbbbb"), questions: new Map() }], notShared: false };
    const [exact, near] = searchConsoleLines(cand(1), two);
    expect(exact!.text).toMatch(/^Search Console, vizzybl\.example \(28 days to 20 Nov, Pacific time\): the search "track brand in chatgpt"/);
    expect(exact!.chip).toBe("vizzybl.example: 880 impressions, position 11.3");
    expect(near!.site).toBe("vizzybl.example");
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
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    expect(await readSearchPlanning(A, { db })).toBeNull();
  });
});

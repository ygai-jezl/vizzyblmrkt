import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { KindCoverage } from "@/lib/metrics/outcomes";
import { StrategyMonthSchema, type StrategyClaim, type StrategyMonth, type StrategySuggestion, type SuggestHold } from "@/lib/types/brandStrategy";
import {
  basedOnLine,
  cantSeeLine,
  isHeld,
  isNoteSuggestion,
  isReviewSuggestion,
  keyActionWord,
  liveHolds,
  nextSuggestion,
  pickSuggestion,
  sourcesLine,
  suggestionAction,
  suggestionKey,
  suggestionLines,
  withHold,
  type SuggestInput,
} from "./suggestRules";

// One suggestion a month, by rules. A made-up physio clinic: three focus situations and two others.
const APPROVED_AT = "2026-10-20T09:00:00.000Z";
const NOW = "2027-01-02T00:10:00.000Z";
const SC = { connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", connector: "Google Search Console", measure: "searchClicks" };
const GA = { connectorId: "google-analytics", name: "Google Analytics 4", href: "/admin/account/connections/google-analytics", siteOnly: false };
const CF = { connectorId: "cloudflare", name: "Cloudflare", href: "/admin/account/connections/cloudflare", siteOnly: true };
const AI = { connectorId: "answers", name: "Answer Tracker", href: "/admin/account/connections/answers", siteOnly: false };
const F1 = "sit_aaaaaa01";
const F2 = "sit_aaaaaa02";
const F3 = "sit_aaaaaa03";
const HEEL = "sit_bbbbbb01";
const ANKLE = "sit_bbbbbb02";

type Row = { id: string; newLive?: number; clicks?: number; live?: number };
/** A kept month: search measured from SC unless `sources` says otherwise, its results for the 28 days to the 1st of the next month. */
function month(m: string, rows: Row[], over: Record<string, unknown> = {}): StrategyMonth {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
  const from = new Date(Date.UTC(y, mo, 1) - 27 * 86_400_000).toISOString().slice(0, 10);
  return StrategyMonthSchema.parse({
    month: m,
    at: `${new Date(Date.UTC(y, mo, 2)).toISOString().slice(0, 10)}T00:10:00.000Z`,
    strategyAt: APPROVED_AT,
    rows: rows.map((r) => ({ id: r.id, questions: 5, answered: 1, live: r.live ?? 1, newLive: r.newLive ?? 0, m: { searchClicks: r.clicks ?? 0, searchImpressions: (r.clicks ?? 0) * 10 } })),
    sources: { search: SC },
    resultsFor: { from, to: next },
    ...over,
  });
}

const COVERAGE: KindCoverage[] = [
  { kind: "search", state: "measured", connectionId: SC.connectionId, connectorId: "search-console", connector: SC.connector, measure: "searchClicks", siteOnly: false, alsoConnected: [] },
  { kind: "visits", state: "not_connected", could: [GA, CF] },
  { kind: "key_actions", state: "not_connected", could: [GA] },
  { kind: "ai_answers", state: "not_connected", could: [AI] },
];

const claim = (id: string, text: string, proof: StrategyClaim["proof"] = null, side: StrategyClaim["side"] = "you"): StrategyClaim => ({ id, side, text, competitor: null, proof, proposed: text });

/** Two months in which F2 stood still while the rest of the map moved. */
const DEC = month("2026-12", [{ id: F1, newLive: 1, clicks: 30 }, { id: F2 }, { id: F3, clicks: 4 }, { id: "rest", newLive: 2, clicks: 50 }]);
const NOV = month("2026-11", [{ id: F1, clicks: 20 }, { id: F2 }, { id: F3, clicks: 3 }, { id: "rest", newLive: 1, clicks: 40 }]);

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    nowIso: NOW,
    months: [DEC, NOV],
    approved: { at: APPROVED_AT, focusSituationIds: [F1, F2, F3], claims: [], goal: null },
    history: [],
    plan: null,
    situations: [
      { id: F1, text: "Back pain after desk work", questions: 15, answered: 9 },
      { id: F2, text: "Running knee in your 40s", questions: 11, answered: 2 },
      { id: F3, text: "Shoulder pain after the gym", questions: 6, answered: 0 },
      { id: HEEL, text: "Heel pain when you stand all day", questions: 20, answered: 4 },
      { id: ANKLE, text: "A sprained ankle that won't settle", questions: 9, answered: 8 },
    ],
    theirs: null,
    articles: [],
    byPage: {},
    coverage: COVERAGE,
    holds: [],
    ...over,
  };
}

const BEHIND = [
  { slotId: "slt_aaaaaa01", title: "How long does runner's knee take to heal?" },
  { slotId: "slt_aaaaaa02", title: "Is a standing desk worth it?" },
  { slotId: "slt_aaaaaa03", title: "Can I lift weights with shoulder pain?" },
];

describe("Behind plan", () => {
  it("names the first 3 entries due and not live, built in only", () => {
    const s = pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: BEHIND }, coverage: [] , months: [month("2026-12", [{ id: F1 }, { id: "rest" }], { sources: {} })] }))!;
    expect(s.detail).toEqual({ kind: "behind_plan", behind: 3, entries: BEHIND });
    expect(s.about).toBe("plan:2026-11-01T09:00:00.000Z");
    expect(suggestionLines(s)).toEqual([
      `3 articles your content plan had due aren't live yet: "How long does runner's knee take to heal?", "Is a standing desk worth it?" and "Can I lift weights with shoulder pain?".`,
      "Write or move these 3.",
    ]);
    expect(basedOnLine(s)).toBe("From your articles and your content plan.");
    expect(suggestionAction(s, "/admin/brand-kit/map?tab=strategy")).toEqual({ label: "Review the strategy", href: "/admin/brand-kit/map?tab=strategy" });
  });

  it("says how many more there are, and waits for 3", () => {
    const five = [...BEHIND, { slotId: "slt_aaaaaa04", title: "Heel pain in the morning" }, { slotId: "slt_aaaaaa05", title: "Knee taping" }];
    const s = pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: five } }))!;
    expect(s.detail).toMatchObject({ kind: "behind_plan", behind: 5 });
    expect(suggestionLines(s)[1]).toBe("Write or move these 3 first.");
    expect(pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: BEHIND.slice(0, 2) } }))!.detail.kind).toBe("stalled_focus");
  });
});

describe("A stalled focus", () => {
  it("swaps it for the situation their articles are most on, when the brand reads them", () => {
    const theirs = [
      ...Array.from({ length: 6 }, () => ({ publishedAt: "2026-12-10", situationIds: [HEEL] })),
      { publishedAt: "2026-12-11", situationIds: [ANKLE] },
      // Too old to count, and one with no date.
      ...Array.from({ length: 9 }, () => ({ publishedAt: "2026-08-01", situationIds: [ANKLE] })),
      { publishedAt: null, situationIds: [ANKLE] },
    ];
    const s = pickSuggestion(input({ theirs }))!;
    expect(s.detail).toEqual({
      kind: "stalled_focus",
      id: F2,
      text: "Running knee in your 40s",
      kinds: ["search"],
      swap: { id: HEEL, text: "Heel pain when you stand all day", by: "their_articles", count: 6, outcome: null, measure: null },
    });
    expect(suggestionLines(s)).toEqual([
      `"Running knee in your 40s" has had no new article and no search clicks for 2 months, while the rest of your map moved.`,
      `Swap it for "Heel pain when you stand all day": your competitors wrote 6 articles on it in the last 90 days.`,
    ]);
    expect(sourcesLine(s)).toBe(
      "From your articles, your competitors' articles and Google Search Console. Connect Google Analytics 4 to weigh visits and sign-ups too. Connect Answer Tracker to weigh AI citations too.",
    );
  });

  it("without their articles, swaps for the most of a measured result, else the most open questions", () => {
    const byResult = pickSuggestion(
      input({ articles: [{ key: "clinic.example/blog/ankle", situationId: ANKLE }, { key: "clinic.example/blog/heel", situationId: HEEL }], byPage: { "clinic.example/blog/ankle": { searchClicks: 40 }, "clinic.example/blog/heel": { searchClicks: 12 } } }),
    )!;
    expect(byResult.detail).toMatchObject({ kind: "stalled_focus", swap: { id: ANKLE, by: "result", count: 40, outcome: "search", measure: "searchClicks" } });
    expect(suggestionLines(byResult)[1]).toBe(`Swap it for "A sprained ankle that won't settle": its articles had 40 search clicks in the latest 28 days.`);
    // Read, but none on a situation outside the focus: the next way to pick decides.
    const byQuestions = pickSuggestion(input({ theirs: [{ publishedAt: "2026-12-10", situationIds: [F1] }] }))!;
    expect(byQuestions.detail).toMatchObject({ swap: { id: HEEL, by: "questions", count: 16 } });
    expect(suggestionLines(byQuestions)[1]).toBe(`Swap it for "Heel pain when you stand all day": 16 of its questions have no live answer yet.`);
    expect(basedOnLine(byQuestions)).toBe("From your articles, your brand map's questions and Google Search Console.");
  });

  it("is skipped when no result it needs is measured in both months", () => {
    const none = { sources: {}, resultsFor: null };
    const s = pickSuggestion(input({ months: [month("2026-12", DEC.rows.map((r) => ({ id: r.id, newLive: r.newLive })), none), month("2026-11", NOV.rows.map((r) => ({ id: r.id, newLive: r.newLive })), none)] }));
    expect(s?.detail.kind).toBe("measure_more");
  });

  it("is judged only where both months had the same source", () => {
    const other = month("2026-11", NOV.rows.map((r) => ({ id: r.id, newLive: r.newLive, clicks: r.m.searchClicks })), { sources: { search: { ...SC, connectionId: "dcn_bbbbbbbbbbbbbbbbbbbb" } } });
    expect(pickSuggestion(input({ months: [DEC, other] }))?.detail.kind).toBe("measure_more");
    // A month missing in between: no comparison.
    expect(pickSuggestion(input({ months: [DEC, month("2026-10", NOV.rows.map((r) => ({ id: r.id })))] }))?.detail.kind).toBe("measure_more");
  });

  it("needs no new article and no result in both months, while the rest of the map moved", () => {
    const quietRest = (m: StrategyMonth) => ({ ...m, rows: m.rows.map((r) => (r.id === "rest" ? { ...r, newLive: 0 } : r)) });
    // The rest's clicks rose (40 to 50): it moved, even with no new article.
    expect(pickSuggestion(input({ months: [quietRest(DEC), quietRest(NOV)] }))?.detail.kind).toBe("stalled_focus");
    const flat = (m: StrategyMonth) => ({ ...quietRest(m), rows: quietRest(m).rows.map((r) => (r.id === "rest" ? { ...r, m: { searchClicks: 40, searchImpressions: 400 } } : r)) });
    expect(pickSuggestion(input({ months: [flat(DEC), flat(NOV)] }))?.detail.kind).toBe("measure_more");
    // One click last month is a result: not stalled.
    const clicked = month("2026-11", [{ id: F1, clicks: 20 }, { id: F2, clicks: 1 }, { id: F3, clicks: 3 }, { id: "rest", newLive: 1, clicks: 40 }]);
    expect(pickSuggestion(input({ months: [DEC, clicked] }))?.detail.kind).toBe("measure_more");
  });
});

describe("A claim still without proof", () => {
  const claims = [claim("cl_aaaaaa01", "Same week appointments"), claim("cl_aaaaaa02", "Physios with sports training", { kind: "site", url: "https://clinic.example/team", title: "Team" }), claim("cl_aaaaaa03", "Cheaper than the hospital", null, "them")];
  // No stalled focus: F2 had a new article.
  const moving = [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: F3 }, { id: "rest" }]), NOV];

  it("asks for the page that proves it after 2 kept months with none", () => {
    const s = pickSuggestion(input({ months: moving, approved: { at: APPROVED_AT, focusSituationIds: [F1, F2, F3], claims, goal: null } }))!;
    expect(s.detail).toEqual({ kind: "claim_no_proof", id: "cl_aaaaaa01", text: "Same week appointments", months: 2 });
    expect(suggestionLines(s)).toEqual([`Your claim "Same week appointments" has had no proof for 2 months.`, "Add the page that proves it, or drop it."]);
    expect(basedOnLine(s)).toBe("From your approved claims.");
  });

  it("waits for 2 kept months, and counts a month only under a strategy where it had no proof", () => {
    const approved = { at: APPROVED_AT, focusSituationIds: [F1, F2, F3], claims, goal: null };
    expect(pickSuggestion(input({ months: moving.slice(0, 1), approved }))?.detail.kind).toBe("measure_more");
    // November looked at an earlier approval in which the claim had proof.
    const earlier = { at: "2026-10-01T09:00:00.000Z", claims: [claim("cl_aaaaaa01", "Same week appointments", { kind: "site", url: "https://clinic.example/book", title: "Book" })] };
    const nov = { ...NOV, strategyAt: earlier.at };
    expect(pickSuggestion(input({ months: [moving[0]!, nov], approved, history: [earlier] }))?.detail.kind).toBe("measure_more");
    // An approval no longer kept: it can't be told, so nothing is said.
    expect(pickSuggestion(input({ months: [moving[0]!, nov], approved }))?.detail.kind).toBe("measure_more");
  });
});

describe("Measure more", () => {
  const still = [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: F3 }, { id: "rest" }]), NOV];

  it("comes only when nothing else applies, for the first kind missing, with its Connect page", () => {
    const s = pickSuggestion(input({ months: still }))!;
    expect(s.detail).toEqual({ kind: "measure_more", outcome: "visits", why: "not_connected", connectors: [{ connectorId: "google-analytics", name: "Google Analytics 4", href: GA.href }] });
    expect(suggestionLines(s)).toEqual(["Connect Google Analytics 4 so your strategy can tell which situations bring visits."]);
    expect(suggestionAction(s, "/x")).toEqual({ label: "Connect Google Analytics 4", href: GA.href });
    expect(sourcesLine(s)).toBe("");
    expect(basedOnLine(s)).toBe("From what you've connected and Google Search Console.");
  });

  it("never for a kind whose read failed, and Share it for one not shared", () => {
    const coverage: KindCoverage[] = [
      COVERAGE[0]!,
      { kind: "visits", state: "failed", connectionId: "dcn_cccccccccccccccccccc", connectorId: "google-analytics", connector: "Google Analytics 4", href: "/admin/account/connections/connected?c=dcn_cccccccccccccccccccc" },
      { kind: "key_actions", state: "failed", connectionId: "dcn_cccccccccccccccccccc", connectorId: "google-analytics", connector: "Google Analytics 4", href: "/admin/account/connections/connected?c=dcn_cccccccccccccccccccc" },
      { kind: "ai_answers", state: "not_shared", connectionId: "dcn_dddddddddddddddddddd", connectorId: "answers", connector: "Answer Tracker", href: "/admin/account/connections/connected?c=dcn_dddddddddddddddddddd" },
    ];
    const s = pickSuggestion(input({ months: still, coverage }))!;
    expect(s.detail).toMatchObject({ kind: "measure_more", outcome: "ai_answers", why: "not_shared" });
    expect(suggestionLines(s)).toEqual(["Share Answer Tracker with your team and Vizzy so your strategy can tell which situations get you cited in AI answers."]);
    expect(suggestionAction(s, "/x")).toEqual({ label: "Share it", href: "/admin/account/connections/connected?c=dcn_dddddddddddddddddddd" });
    const failedOnly = coverage.map((c) => (c.kind === "ai_answers" ? { kind: "ai_answers" as const, state: "measured" as const, connectionId: "dcn_dddddddddddddddddddd", connectorId: "answers", connector: "Answer Tracker", measure: "aiCitations" as const, siteOnly: false, alsoConnected: [] } : c));
    expect(pickSuggestion(input({ months: still, coverage: failedOnly }))).toBeNull();
  });

  it("never suggests a tool that counts only the whole site: it can't tell situations apart", () => {
    const coverage = COVERAGE.map((c) => (c.kind === "visits" ? { kind: "visits" as const, state: "not_connected" as const, could: [CF] } : c));
    const s = pickSuggestion(input({ months: still, coverage }))!;
    expect(s.detail).toMatchObject({ kind: "measure_more", outcome: "key_actions" });
    // And it isn't named in what the suggestion couldn't see either.
    expect(s.cantSee.find((c) => c.kind === "visits")).toEqual({ kind: "visits", why: "not_connected", connector: null, href: null });
  });

  it("uses the brand's own word for key actions", () => {
    const coverage = COVERAGE.map((c) => (c.kind === "visits" ? { ...COVERAGE[0]!, kind: "visits" as const, measure: "ga4Sessions" as const } : c));
    const s = pickSuggestion(input({ months: still, coverage, approved: { at: APPROVED_AT, focusSituationIds: [F1, F2, F3], claims: [], goal: { text: "40 more bookings a month", measure: "bookings from the site", measureKey: null, from: "person", setAt: APPROVED_AT } } }))!;
    expect(s.keyWord).toBe("bookings");
    expect(suggestionLines(s)).toEqual(["Connect Google Analytics 4 so your strategy can tell which situations bring bookings."]);
  });
});

describe("Working", () => {
  it("adds a line when the focus rose by more than the rest, and makes no Review row", () => {
    // Every kind measured or held, nothing stalled: focus clicks 23 to 40, the rest 40 to 44.
    const dec = month("2026-12", [{ id: F1, newLive: 1, clicks: 30 }, { id: F2, newLive: 1, clicks: 6 }, { id: F3, clicks: 4 }, { id: "rest", clicks: 44 }]);
    const holds: SuggestHold[] = ["visits", "key_actions", "ai_answers"].map((k) => ({ kind: "measure_more", about: k, until: "2027-03-01T00:00:00.000Z", reason: "not_a_priority" }));
    const s = pickSuggestion(input({ months: [dec, NOV], holds }))!;
    expect(s.detail).toEqual({ kind: "working", outcome: "search", measure: "searchClicks", focusNow: 40, focusBefore: 23, restNow: 44, restBefore: 40 });
    expect(suggestionLines(s)).toEqual(["Your focus situations are working: their search clicks went from 23 to 40, ahead of the rest of your map (40 to 44)."]);
    expect(isReviewSuggestion(s)).toBe(false);
    // The rest grew faster: nothing to say.
    const restFaster = { ...dec, rows: dec.rows.map((r) => (r.id === "rest" ? { ...r, m: { searchClicks: 90, searchImpressions: 900 } } : r)) };
    expect(pickSuggestion(input({ months: [restFaster, NOV], holds }))).toBeNull();
  });
});

describe("Not now and one at a time", () => {
  it("keeps a suggestion away 60 days, or 90 for Measure more, and the next rule that applies is used", () => {
    const plan = { at: "2026-11-01T09:00:00.000Z", behind: BEHIND };
    const behind = pickSuggestion(input({ plan }))!;
    const holds = withHold([], behind, "already_doing", NOW);
    expect(holds).toEqual([{ kind: "behind_plan", about: "plan:2026-11-01T09:00:00.000Z", until: "2027-03-03T00:10:00.000Z", reason: "already_doing" }]);
    expect(pickSuggestion(input({ plan, holds }))!.detail.kind).toBe("stalled_focus");
    // A day after the hold ends, it can come back.
    expect(pickSuggestion(input({ plan, holds, nowIso: "2027-03-04T00:00:00.000Z" }))!.detail.kind).toBe("behind_plan");
    // A new plan is a new thing to be behind on.
    expect(pickSuggestion(input({ plan: { ...plan, at: "2026-12-15T09:00:00.000Z" }, holds }))!.detail.kind).toBe("behind_plan");

    const still = [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: F3 }, { id: "rest" }]), NOV];
    const visits = pickSuggestion(input({ months: still }))!;
    const measureHolds = withHold([], visits, "not_a_priority", NOW);
    expect(measureHolds[0]!.until).toBe("2027-04-02T00:10:00.000Z");
    expect(isHeld(measureHolds, "measure_more", "visits", "2027-04-01T00:00:00.000Z")).toBe(true);
    expect(isHeld(measureHolds, "measure_more", "visits", "2027-04-03T00:00:00.000Z")).toBe(false);
    expect(pickSuggestion(input({ months: still, holds: measureHolds }))!.detail).toMatchObject({ kind: "measure_more", outcome: "key_actions" });
    expect(liveHolds(measureHolds, "2027-05-01T00:00:00.000Z")).toEqual([]);
  });

  it("a new month's suggestion replaces an open one, keeping when it was first raised if it is the same", () => {
    const a = pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: BEHIND } }))!;
    const b = pickSuggestion(input())!;
    expect(nextSuggestion(a, b)).toEqual(b);
    const later = { ...a, raisedAt: "2027-02-02T00:10:00.000Z", month: "2027-01" };
    expect(nextSuggestion(a, later)).toEqual({ ...later, raisedAt: a.raisedAt });
    // Acted on or put off: the new one is new, with none of the old one's state or dates.
    const acted = { ...a, state: "acted" as const, actedAt: "2027-01-20T09:00:00.000Z" };
    expect(nextSuggestion(acted, later)).toEqual(later);
    expect(nextSuggestion(acted, later)).toMatchObject({ state: "open", actedAt: null, dismissedAt: null, raisedAt: later.raisedAt });
    expect(nextSuggestion({ ...a, state: "dismissed", dismissedAt: "2027-01-20T09:00:00.000Z" }, later)).toMatchObject({ state: "open", dismissedAt: null, raisedAt: later.raisedAt });
    // Nothing applies: last month's goes.
    expect(nextSuggestion(a, null)).toBeNull();
    expect(a.key).toBe(suggestionKey("behind_plan", "plan:2026-11-01T09:00:00.000Z"));
    expect(a.key).not.toBe(b.key);
  });
});

describe("one that can't be kept", () => {
  it("is passed over for the next one that applies, never ending the month with none", () => {
    // A stalled focus situation whose id can't be kept: the next rule that applies is used.
    const BAD = "sit_Not-Valid";
    const rows = (m: StrategyMonth) => ({ ...m, rows: m.rows.map((r) => (r.id === F2 ? { ...r, id: BAD } : r)) });
    const situations = input().situations.map((x) => (x.id === F2 ? { ...x, id: BAD } : x));
    const s = pickSuggestion(input({ months: [rows(DEC), rows(NOV)], situations, approved: { at: APPROVED_AT, focusSituationIds: [F1, BAD, F3], claims: [], goal: null } }));
    expect(s?.detail).toMatchObject({ kind: "measure_more", outcome: "visits" });
    // A behind plan with no entry it can name says nothing to write: the stalled focus comes next.
    const blank = BEHIND.map((e) => ({ ...e, title: "   " }));
    expect(pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: blank } }))?.detail.kind).toBe("stalled_focus");
    // Within one rule too: a claim whose words can't be kept gives way to the next claim.
    const moving = [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: F3 }, { id: "rest" }]), NOV];
    const claims = [claim("cl_aaaaaa01", "x".repeat(400)), claim("cl_aaaaaa02", "Same week appointments")];
    expect(pickSuggestion(input({ months: moving, approved: { at: APPROVED_AT, focusSituationIds: [F1, F2, F3], claims, goal: null } }))?.detail).toMatchObject({ kind: "claim_no_proof", id: "cl_aaaaaa02" });
  });
});

describe("which suggestions are notes", () => {
  it("are open, in Review and not Measure more: only connecting a tool settles that one", () => {
    const stalled = pickSuggestion(input())!;
    const still = [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: F3 }, { id: "rest" }]), NOV];
    const measure = pickSuggestion(input({ months: still }))!;
    expect(measure.detail.kind).toBe("measure_more");
    expect(isNoteSuggestion(stalled)).toBe(true);
    expect(isNoteSuggestion(measure)).toBe(false);
    expect(isReviewSuggestion(measure)).toBe(true);
    expect(isNoteSuggestion({ ...stalled, state: "acted" })).toBe(false);
    expect(isNoteSuggestion(null)).toBe(false);
  });
});

describe("its words", () => {
  it("say one in the singular, the brand's own word too", () => {
    const one = pickSuggestion(input({ articles: [{ key: "clinic.example/blog/ankle", situationId: ANKLE }], byPage: { "clinic.example/blog/ankle": { searchClicks: 1 } } }))!;
    expect(one.detail).toMatchObject({ kind: "stalled_focus", swap: { id: ANKLE, by: "result", count: 1, outcome: "search" } });
    expect(suggestionLines(one)[1]).toBe(`Swap it for "A sprained ankle that won't settle": its articles had 1 search click in the latest 28 days.`);
    const stall = one.detail as Extract<StrategySuggestion["detail"], { kind: "stalled_focus" }>;
    const keyActions = (count: number, keyWord: string | null): StrategySuggestion => ({ ...one, keyWord, detail: { ...stall, swap: { ...stall.swap, count, outcome: "key_actions", measure: "ga4KeyEvents" } } });
    const enquiries = keyActionWord("enquiries by phone or email");
    expect(enquiries).toBe("enquiries");
    expect(suggestionLines(keyActions(1, enquiries))[1]).toContain("its articles had 1 enquiry in the latest 28 days");
    expect(suggestionLines(keyActions(3, enquiries))[1]).toContain("its articles had 3 enquiries in the latest 28 days");
    expect(suggestionLines(keyActions(1, null))[1]).toContain("its articles had 1 sign-up in the latest 28 days");
  });

  it("finds the brand's word for key actions in its goal's measure", () => {
    expect(keyActionWord("bookings from the site")).toBe("bookings");
    expect(keyActionWord("Sign ups")).toBe("sign-ups");
    expect(keyActionWord("Search Console clicks")).toBeNull();
    expect(keyActionWord(null)).toBeNull();
  });

  it("say what it couldn't see, connector by connector", () => {
    const s = { keyWord: null, cantSee: [
      { kind: "visits" as const, why: "not_connected" as const, connector: "Google Analytics 4", href: GA.href },
      { kind: "key_actions" as const, why: "not_connected" as const, connector: "Google Analytics 4", href: GA.href },
      { kind: "ai_answers" as const, why: "failed" as const, connector: "Answer Tracker", href: "/x" },
    ] };
    expect(cantSeeLine(s)).toBe("Connect Google Analytics 4 to weigh visits and sign-ups too. Check Answer Tracker's connection to weigh AI citations too.");
  });

  it("keep to house style, whatever the suggestion", () => {
    const all: Array<StrategySuggestion | null> = [
      pickSuggestion(input({ plan: { at: "2026-11-01T09:00:00.000Z", behind: [...BEHIND, ...BEHIND] } })),
      pickSuggestion(input({ theirs: [{ publishedAt: "2026-12-10", situationIds: [HEEL] }] })),
      pickSuggestion(input()),
      pickSuggestion(input({ months: [month("2026-12", [{ id: F1 }, { id: F2, newLive: 1 }, { id: "rest" }]), NOV] })),
    ];
    for (const s of all) {
      expect(s).not.toBeNull();
      for (const line of [...suggestionLines(s!), sourcesLine(s!), basedOnLine(s!)]) {
        expect(dashesIn(line), line).toEqual([]);
        expect(aiTellsIn(line), line).toEqual([]);
      }
    }
  });
});

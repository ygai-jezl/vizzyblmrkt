import { describe, expect, it } from "vitest";
import type { KindCoverage } from "@/lib/metrics/outcomes";
import { BrandStrategyDocSchema, StrategyMonthSchema, STRATEGY_MONTH_LIMITS, type StrategyDecision, type StrategyMonth } from "@/lib/types/brandStrategy";
import type { PlanDecision } from "@/lib/types/contentStrategy";
import { arrowFor, monthBefore, monthBounds, monthDue, monthLook, previousMonth, storedMonth, tooEarly, weeksIn, withMonth, type MonthInput } from "./monthRules";

// How it went's rules, with fixed numbers. A made-up physio clinic: its buying situations, articles,
// competitors and numbers are all invented.
const SC: KindCoverage = { kind: "search", state: "measured", connectionId: "dcn_sc", connectorId: "search-console", connector: "Google Search Console", measure: "searchClicks", siteOnly: false, alsoConnected: [] };
const CF: KindCoverage = { kind: "visits", state: "measured", connectionId: "dcn_cf", connectorId: "cloudflare", connector: "Cloudflare", measure: "cfVisits", siteOnly: true, alsoConnected: [] };
const decision = (kind: StrategyDecision["kind"], at: string, by: string | null = "admin@clinic.example.com"): StrategyDecision => ({ kind, ref: "x", before: null, after: null, at, by });
const planDecision = (kind: PlanDecision["kind"], at: string): PlanDecision => ({ kind, ref: "x", before: null, after: null, at, by: "admin@clinic.example.com" });

function input(over: Partial<MonthInput> = {}): MonthInput {
  return {
    month: "2026-11",
    nowIso: "2026-12-02T10:08:00.000Z",
    approved: { at: "2026-10-20T09:00:00.000Z", focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02"] },
    plan: { at: "2026-10-21T09:00:00.000Z" },
    situations: [
      { id: "sit_aaaaaa01", text: "Back pain after desk work", questions: 15, answered: 9 },
      { id: "sit_aaaaaa02", text: "Running knee in your 40s", questions: 11, answered: 2 },
      { id: "sit_bbbbbb03", text: "Heel pain when you stand all day", questions: 50, answered: 20 },
      { id: "sit_bbbbbb04", text: "Shoulder pain after the gym", questions: 40, answered: 11 },
    ],
    articles: [
      { key: "k1", publishedAt: "2026-10-01T08:00:00.000Z", situationId: "sit_aaaaaa01" },
      { key: "k2", publishedAt: "2026-11-05T08:00:00.000Z", situationId: "sit_aaaaaa01" },
      { key: "k3", publishedAt: "2026-11-30T23:00:00.000Z", situationId: "sit_aaaaaa01" },
      { key: "k4", publishedAt: "2026-09-01T08:00:00.000Z", situationId: "sit_aaaaaa02" },
      // On no situation, and on one outside the focus: both the rest of the map.
      { key: "k5", publishedAt: "2026-11-10T08:00:00.000Z", situationId: null },
      { key: "k6", publishedAt: "2026-08-01T08:00:00.000Z", situationId: "sit_bbbbbb03" },
      // Live after the month ended: not this month's.
      { key: "k7", publishedAt: "2026-12-01T08:00:00.000Z", situationId: "sit_aaaaaa01" },
    ],
    outcomes: {
      coverage: [SC, CF, { kind: "key_actions", state: "not_connected", could: [] }, { kind: "ai_answers", state: "not_shared", connectionId: "dcn_vz", connectorId: "vizzybl", connector: "Vizzybl", href: "/x" }],
      byPage: {
        k1: { searchClicks: 100, searchImpressions: 1000 },
        k2: { searchClicks: 20, searchImpressions: 300 },
        k4: { searchClicks: 14, searchImpressions: 200 },
        k5: { searchClicks: 200, searchImpressions: 4000 },
        k7: { searchClicks: 50, searchImpressions: 500 },
      },
      site: { cfVisits: 900 },
      more: [],
    },
    theirs: [
      { publishedAt: "2026-11-03", situationIds: ["sit_aaaaaa01"] },
      { publishedAt: "2026-11-10", situationIds: ["sit_aaaaaa01", "sit_bbbbbb03"] },
      { publishedAt: "2026-10-30", situationIds: ["sit_aaaaaa01"] },
      { publishedAt: null, situationIds: ["sit_aaaaaa02"] },
      { publishedAt: "2026-11-12", situationIds: ["sit_bbbbbb03", "sit_bbbbbb04"] },
      { publishedAt: "2026-11-15", situationIds: ["sit_zzzzzz99"] },
    ],
    roadmap: { due: 8, done: 6 },
    decisions: [
      decision("star_kept", "2026-11-03T10:00:00.000Z"),
      decision("star_kept", "2026-11-03T10:00:00.000Z"),
      decision("star_kept", "2026-11-03T10:00:00.000Z"),
      decision("star_removed", "2026-11-03T10:00:00.000Z"),
      decision("star_removed", "2026-11-04T10:00:00.000Z", "vizzy"),
      decision("claim_edited", "2026-11-05T10:00:00.000Z"),
      decision("claim_edited", "2026-11-06T10:00:00.000Z"),
      decision("check_acted", "2026-11-07T10:00:00.000Z"),
      decision("claim_edited", "2026-10-31T23:59:00.000Z"),
    ],
    planDecisions: [planDecision("pick_skipped", "2026-12-01T09:00:00.000Z"), planDecision("pick_skipped", "2026-11-12T09:00:00.000Z"), planDecision("pick_skipped", "2026-11-11T09:00:00.000Z")],
    ...over,
  };
}

describe("the month's look", () => {
  it("adds up each focus situation and the rest of the map with fixed numbers", () => {
    const m = monthLook(input());
    expect(m.rows).toEqual([
      { id: "sit_aaaaaa01", questions: 15, answered: 9, live: 3, newLive: 2, theirs: 2, m: { searchClicks: 120, searchImpressions: 1300 } },
      { id: "sit_aaaaaa02", questions: 11, answered: 2, live: 1, newLive: 0, theirs: 0, m: { searchClicks: 14, searchImpressions: 200 } },
      { id: "rest", questions: 90, answered: 31, live: 2, newLive: 1, theirs: 2, m: { searchClicks: 200, searchImpressions: 4000 } },
    ]);
    // Cloudflare counts the whole site: a site total, never a row's.
    expect(m.site).toEqual({ cfVisits: 900 });
    expect(m.roadmap).toEqual({ due: 8, done: 6 });
    // What people did that month: Vizzy's own moves and other months' never count.
    expect(m.did).toEqual({ starsKept: 3, starsRemoved: 1, claimsEdited: 2, picksSkipped: 2, checksActed: 1, checksDismissed: 0, capped: false });
    expect(m).toMatchObject({ month: "2026-11", at: "2026-12-02T10:08:00.000Z", strategyAt: "2026-10-20T09:00:00.000Z", partway: false, planAt: "2026-10-21T09:00:00.000Z" });
  });

  it("keeps where each kind came from and what it couldn't measure, and why", () => {
    const m = monthLook(input({ outcomes: { ...input().outcomes, more: ["search", "ai_answers"] } }));
    expect(m.sources).toEqual({
      search: { connectionId: "dcn_sc", connector: "Google Search Console", measure: "searchClicks", siteOnly: false },
      visits: { connectionId: "dcn_cf", connector: "Cloudflare", measure: "cfVisits", siteOnly: true },
    });
    expect(m.missing).toEqual([
      { kind: "key_actions", why: "not_connected" },
      { kind: "ai_answers", why: "not_shared" },
    ]);
    // Only a kind it measured can have been capped.
    expect(m.more).toEqual(["search"]);
    // The days the connected results cover: the 28 days to the look, not the calendar month.
    const days = monthLook(input({ outcomes: { ...input().outcomes, periods: { search: { from: "2026-11-01", to: "2026-11-28" }, visits: { from: "2026-11-04", to: "2026-12-01" }, ai_answers: { from: "2026-10-01", to: "2026-12-01" } } } }));
    expect(days.resultsFor).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    expect(m.resultsFor).toBeNull();
  });

  it("with no connectors, keeps the built in rows and no numbers", () => {
    const none: KindCoverage[] = (["search", "visits", "key_actions", "ai_answers"] as const).map((kind) => ({ kind, state: "not_connected", could: [] }));
    const m = monthLook(input({ outcomes: { coverage: none, byPage: {}, site: {}, more: [] }, theirs: null, roadmap: null, plan: null, planDecisions: null }));
    expect(m.rows.map((r) => [r.id, r.live, r.theirs, r.m])).toEqual([
      ["sit_aaaaaa01", 3, null, {}],
      ["sit_aaaaaa02", 1, null, {}],
      ["rest", 2, null, {}],
    ]);
    expect(m.sources).toEqual({});
    expect(m.site).toEqual({});
    expect(m.missing.map((x) => x.kind)).toEqual(["search", "visits", "key_actions", "ai_answers"]);
    expect(m.did.picksSkipped).toBe(0);
  });

  it("says when the strategy was approved partway through, and when a log was full in the month", () => {
    const full = Array.from({ length: 200 }, () => decision("claim_edited", "2026-11-20T10:00:00.000Z"));
    const m = monthLook(input({ approved: { at: "2026-11-14T09:00:00.000Z", focusSituationIds: ["sit_aaaaaa01"] }, decisions: full }));
    expect(m.partway).toBe(true);
    expect(m.did).toMatchObject({ claimsEdited: 200, capped: true });
    // A focus situation no longer decided on the map is left out; its articles join the rest.
    const gone = monthLook(input({ approved: { at: "2026-10-20T09:00:00.000Z", focusSituationIds: ["sit_gone0001", "sit_aaaaaa02"] } }));
    expect(gone.rows.map((r) => [r.id, r.live])).toEqual([
      ["sit_aaaaaa02", 1],
      ["rest", 5],
    ]);
  });
});

describe("when a month is due", () => {
  const record = (over: Partial<{ approved: { at: string } | null; months: Array<{ month: string }>; monthsRetryAt: string | null }> = {}) => ({ approved: { at: "2026-10-20T09:00:00.000Z" }, months: [], monthsRetryAt: null, ...over });
  const at = (iso: string) => Date.parse(iso);
  it("from the 2nd, the month before, once, for a strategy approved before this month", () => {
    expect(monthDue(record(), at("2026-12-01T23:00:00.000Z"))).toBeNull();
    expect(monthDue(record(), at("2026-12-02T00:10:00.000Z"))).toBe("2026-11");
    expect(monthDue(record({ months: [{ month: "2026-11" }] }), at("2026-12-20T00:10:00.000Z"))).toBeNull();
    expect(monthDue(record({ approved: { at: "2026-12-01T09:00:00.000Z" } }), at("2026-12-02T00:10:00.000Z"))).toBeNull();
    expect(monthDue(record({ approved: null }), at("2026-12-02T00:10:00.000Z"))).toBeNull();
    // January looks at December of the year before.
    expect(monthDue(record(), at("2027-01-05T00:10:00.000Z"))).toBe("2026-12");
  });

  it("waits for a failed look's retry time", () => {
    expect(monthDue(record({ monthsRetryAt: "2026-12-03T00:10:00.000Z" }), at("2026-12-02T12:00:00.000Z"))).toBeNull();
    expect(monthDue(record({ monthsRetryAt: "2026-12-03T00:10:00.000Z" }), at("2026-12-03T00:11:00.000Z"))).toBe("2026-11");
  });

  it("knows a month's days and weeks", () => {
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28", startIso: "2026-02-01T00:00:00.000Z", endIso: "2026-03-01T00:00:00.000Z" });
    expect(previousMonth(at("2026-01-15T00:00:00.000Z"))).toBe("2025-12");
    expect([...weeksIn("2026-11")]).toEqual(["2026-W45", "2026-W46", "2026-W47", "2026-W48", "2026-W49"]);
  });
});

describe("keeping months", () => {
  const month = (m: string, over: Partial<StrategyMonth> = {}) => ({ ...monthLook({ ...input(), month: m }), ...over });

  it("keeps the newest 12, newest first, one each", () => {
    let months: StrategyMonth[] = [];
    for (let i = 0; i < 14; i += 1) months = withMonth(months, month(new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7))).map((x) => StrategyMonthSchema.parse(x));
    expect(months).toHaveLength(12);
    expect(months[0]!.month).toBe("2026-02");
    expect(months.at(-1)!.month).toBe("2025-03");
    // The same month again takes its place.
    const again = withMonth(months, month("2026-02", { at: "2026-03-09T00:00:00.000Z" })).map((x) => StrategyMonthSchema.parse(x));
    expect(again.filter((m) => m.month === "2026-02")).toHaveLength(1);
    expect(again[0]!.at).toBe("2026-03-09T00:00:00.000Z");
  });

  it("stays under 12 KB: five focus situations and every kind for 12 months fit, and bigger months keep fewer", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i === 5 ? "rest" : `sit_aaaaaa0${i}`, questions: 99, answered: 99, live: 99, newLive: 9, theirs: 9, m: { searchClicks: 12345, searchImpressions: 123456, ga4Sessions: 12345, ga4KeyEvents: 123, aiCitations: 12 } }));
    const src = { connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", connector: "Google Analytics 4", measure: "ga4Sessions", siteOnly: false };
    const big = (m: string) => StrategyMonthSchema.parse({ ...month(m), rows, sources: { search: src, visits: src, key_actions: src, ai_answers: src } });
    let stored: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i += 1) stored = withMonth(stored.map((x) => StrategyMonthSchema.parse(x)), big(`2026-${String(i + 1).padStart(2, "0")}`));
    expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThanOrEqual(STRATEGY_MONTH_LIMITS.bytes);
    expect(stored.length).toBeGreaterThanOrEqual(6);
    expect(stored[0]!.month).toBe("2026-12");
    // A brand like the clinic above, with two focus situations and two kinds measured, keeps all 12.
    let typical: Array<Record<string, unknown>> = [];
    const withDays = (m: string) => ({ ...month(m), resultsFor: { from: `${m}-03`, to: `${m}-28` } });
    for (let i = 0; i < 12; i += 1) typical = withMonth(typical.map((x) => StrategyMonthSchema.parse(x)), withDays(`2026-${String(i + 1).padStart(2, "0")}`));
    expect(typical).toHaveLength(12);
    expect(new TextEncoder().encode(JSON.stringify(typical)).length).toBeLessThanOrEqual(STRATEGY_MONTH_LIMITS.bytes);
  });

  it("stores a month without its defaults, and reads it back the same", () => {
    const m = monthLook(input({ theirs: [], roadmap: { due: 0, done: 0 } }));
    const stored = storedMonth(m);
    expect(StrategyMonthSchema.parse(stored)).toEqual(m);
    // Zero results, none of their articles and an empty roadmap are numbers, not gaps.
    expect(m.rows[1]!.theirs).toBe(0);
    expect(StrategyMonthSchema.parse(stored).roadmap).toEqual({ due: 0, done: 0 });
    expect(JSON.stringify(stored)).not.toContain('"partway"');
  });

  it("reads records stored before it with no months", () => {
    const doc = BrandStrategyDocSchema.parse({ id: "bst_ten_A", tenantId: "ten_A" });
    expect(doc.months).toEqual([]);
    expect(doc.monthsRetryAt).toBeNull();
    // A month a later build wrote that this one can't read is left out, never the record.
    expect(BrandStrategyDocSchema.parse({ id: "bst_ten_A", tenantId: "ten_A", months: [{ month: "bad" }, month("2026-11")] }).months.map((m) => m.month)).toEqual(["2026-11"]);
  });
});

describe("arrows against the month before", () => {
  const nov = monthLook(input());
  const oct = monthLook({ ...input(), month: "2026-10", outcomes: { ...input().outcomes, byPage: { k1: { searchClicks: 90, searchImpressions: 900 }, k4: { searchClicks: 20, searchImpressions: 100 } } } });

  it("show only when both months had the same source for that kind", () => {
    expect(arrowFor(nov, oct, "sit_aaaaaa01", "search")).toBe("up");
    expect(arrowFor(nov, oct, "sit_aaaaaa02", "search")).toBe("down");
    expect(arrowFor(nov, monthBefore([nov, oct], "2026-11"), "rest", "search")).toBe("up");
    // Another Search Console connection last month: no arrow.
    const moved = { ...oct, sources: { ...oct.sources, search: { ...oct.sources.search!, connectionId: "dcn_other" } } };
    expect(arrowFor(nov, moved, "sit_aaaaaa01", "search")).toBeNull();
    // Not measured last month: no arrow, so connecting partway never reads as a jump.
    expect(arrowFor(nov, { ...oct, sources: {} }, "sit_aaaaaa01", "search")).toBeNull();
    // A whole site source never has a row arrow, and no month before, none.
    expect(arrowFor(nov, oct, "sit_aaaaaa01", "visits")).toBeNull();
    expect(arrowFor(nov, null, "sit_aaaaaa01", "search")).toBeNull();
    // Only the calendar month before counts.
    expect(monthBefore([nov, { ...oct, month: "2026-09" }], "2026-11")).toBeNull();
  });

  it("says it is too early to tell until a full month after approval", () => {
    expect(tooEarly("2026-11-14T09:00:00.000Z", Date.parse("2026-12-13T09:00:00.000Z"))).toBe(true);
    expect(tooEarly("2026-11-14T09:00:00.000Z", Date.parse("2026-12-14T09:00:00.000Z"))).toBe(false);
    expect(tooEarly(null, Date.parse("2026-12-14T09:00:00.000Z"))).toBe(true);
  });
});

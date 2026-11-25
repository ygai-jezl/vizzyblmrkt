import type { RefreshRecord } from "@/lib/types/articleRefresh";
import { FRESHNESS_CLOCKS, type FreshnessClock } from "@/lib/types/contentPlan";

/**
 * "Which clock works" (BLOG_REFRESH_ENABLED): the brand's refresh records summed up per clock. Too
 * early until a clock has 8 refreshes with 28 days of Search Console results; then each clock's
 * click change, against the articles left alone, shows as a range, never one winning number. Once
 * all three have 8, the clock with the most clicks gained per dollar is suggested, and a person
 * accepts it. Without Search Console, a clock whose reviews mostly find nothing is called out as
 * probably too short. Pure: it reads the records it is given.
 */

export const READOUT = {
  /** Refreshes with results a clock needs before its range shows. */
  MIN_RESULTS: 8,
  /** Reviews a clock needs before "mostly nothing" says anything. */
  MIN_REVIEWS: 8,
  /** This share of a clock's reviews finding nothing calls it probably too short. */
  NOTHING_SHARE: 0.6,
} as const;

export interface ClockReadout {
  clockDays: FreshnessClock;
  /** Reviews decided on this clock (applied, nothing to change, or dismissed). */
  refreshes: number;
  /** Of those, the share that changed nothing (found nothing, or every change dismissed). */
  nothingShare: number | null;
  proposedAvg: number | null;
  acceptedAvg: number | null;
  costCentsAvg: number | null;
  /** Applied refreshes with Search Console results. */
  withResults: number;
  /** Clicks after against before, beside articles left alone: the mean and its 95% range, at 8 or more results. */
  clickLift: { mean: number; low: number; high: number } | null;
  /** More results it needs before its range shows. */
  resultsNeeded: number;
  /** Clicks gained per dollar of review cost, averaged (with 8 or more results). */
  clicksPerDollar: number | null;
}

export interface Readout {
  clocks: ClockReadout[];
  /** The first review, so "since" can be said. */
  since: string | null;
  suggestion: { clockDays: FreshnessClock; text: string } | null;
  tooShort: FreshnessClock[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function clockReadout(records: RefreshRecord[]): Readout {
  const decided = records.filter((r) => r.decision && r.decision.outcome !== "stopped" && r.decision.outcome !== "failed");
  const clocks = FRESHNESS_CLOCKS.map((clockDays): ClockReadout => {
    const mine = decided.filter((r) => r.observation.clockDays === clockDays);
    const nothing = mine.filter((r) => r.decision!.outcome === "nothing" || r.decision!.outcome === "dismissed").length;
    const results = mine.filter((r) => r.decision!.outcome === "applied" && r.outcome?.searchConsole && r.outcome.lift !== null);
    const lifts = results.map((r) => r.outcome!.lift!);
    const enough = lifts.length >= READOUT.MIN_RESULTS;
    let clickLift: ClockReadout["clickLift"] = null;
    if (enough) {
      const m = mean(lifts)!;
      const sd = Math.sqrt(lifts.reduce((a, x) => a + (x - m) ** 2, 0) / (lifts.length - 1));
      const half = (1.96 * sd) / Math.sqrt(lifts.length);
      clickLift = { mean: round(m, 3), low: round(m - half, 3), high: round(m + half, 3) };
    }
    const perDollar = results
      .filter((r) => (r.cost?.cents ?? 0) > 0)
      .map((r) => ((r.outcome!.before?.clicks ?? 0) * r.outcome!.lift!) / (r.cost!.cents / 100));
    return {
      clockDays,
      refreshes: mine.length,
      nothingShare: mine.length ? round(nothing / mine.length) : null,
      proposedAvg: mean(mine.map((r) => r.proposal?.count ?? 0)) === null ? null : round(mean(mine.map((r) => r.proposal?.count ?? 0))!, 1),
      acceptedAvg: mine.length ? round(mean(mine.map((r) => r.decision!.accepted))!, 1) : null,
      costCentsAvg: mean(mine.flatMap((r) => (r.cost ? [r.cost.cents] : []))) === null ? null : round(mean(mine.flatMap((r) => (r.cost ? [r.cost.cents] : [])))!, 1),
      withResults: lifts.length,
      clickLift,
      resultsNeeded: Math.max(0, READOUT.MIN_RESULTS - lifts.length),
      clicksPerDollar: enough && perDollar.length ? round(mean(perDollar)!, 1) : null,
    };
  });

  const tooShort = clocks.filter((c) => c.refreshes >= READOUT.MIN_REVIEWS && (c.nothingShare ?? 0) >= READOUT.NOTHING_SHARE).map((c) => c.clockDays);
  let suggestion: Readout["suggestion"] = null;
  if (clocks.every((c) => c.clicksPerDollar !== null)) {
    const ranked = [...clocks].sort((a, b) => b.clicksPerDollar! - a.clicksPerDollar!);
    const best = ranked[0]!;
    if (best.clicksPerDollar! > 0) {
      suggestion = {
        clockDays: best.clockDays,
        text: `${best.clockDays} days gains the most clicks for what reviews cost: about ${best.clicksPerDollar} a dollar, against ${ranked[1]!.clicksPerDollar} for ${ranked[1]!.clockDays} days. Use it, and a tenth of new articles keep testing.`,
      };
    }
  }
  const since = records.length ? records.map((r) => r.startedAt).sort()[0]! : null;
  return { clocks, since, suggestion, tooShort };
}

/** What the readout says in one line, for the card and for Vizzy. */
export function readoutLine(r: Readout): string {
  if (r.suggestion) return r.suggestion.text;
  const short = r.tooShort.map((d) => `${d}-day`).join(" and ");
  if (short) return `Most ${short} reviews find nothing to change, so ${r.tooShort.length > 1 ? "those clocks are" : "that clock is"} probably too short.`;
  const waiting = r.clocks.filter((c) => c.resultsNeeded > 0);
  if (!r.clocks.some((c) => c.refreshes)) return "No refreshes yet. Results show once each clock has 8 refreshes with 28 days of Search Console results.";
  return `Too early to suggest a clock: ${waiting.map((c) => `${c.clockDays} days needs ${c.resultsNeeded} more`).join(", ")} refreshes with results.`;
}

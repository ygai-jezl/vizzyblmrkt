import type { BlogArticleFreshness, FreshnessClock, FreshnessReason } from "@/lib/types/contentPlan";
import { FRESHNESS_CLOCKS } from "@/lib/types/contentPlan";
import { isDayOnly } from "./dates";
import { articleFigures } from "./figures";

/**
 * A live article's freshness (BLOG_FRESHNESS_ENABLED). Each has a clock of 20, 30 or 45 days,
 * counted from its last real update or check. By default the clocks are spread across a brand's
 * articles to learn which works best; a brand can fix one. Signals can make an article due sooner.
 * No AI: everything here is counted.
 */

const DAY_MS = 86_400_000;
/** "Review soon": within this many days of its clock. */
export const SOON_DAYS = 5;
/** The events kept per article, for the clock test's readout. */
export const MAX_EVENTS = 20;

export type ClockSetting = "test" | FreshnessClock;

/**
 * The clock for an article getting its first. A fixed setting gives that clock. The test gives the
 * clock its subject has fewest of (ties at random), so each subject sees all three.
 */
export function assignClock(
  setting: ClockSetting | undefined,
  subjectCounts: Partial<Record<FreshnessClock, number>>,
  rand: () => number = Math.random,
): { clockDays: FreshnessClock; arm: "test" | "fixed" } {
  if (setting === 20 || setting === 30 || setting === 45) return { clockDays: setting, arm: "fixed" };
  const fewest = Math.min(...FRESHNESS_CLOCKS.map((c) => subjectCounts[c] ?? 0));
  const tied = FRESHNESS_CLOCKS.filter((c) => (subjectCounts[c] ?? 0) === fewest);
  return { clockDays: tied[Math.min(tied.length - 1, Math.floor(rand() * tied.length))]!, arm: "test" };
}

/** When a stored date happened, as ms (a day counts from its start, UTC). */
const msOf = (at: string | null | undefined): number | null => {
  if (!at) return null;
  const ms = isDayOnly(at) ? Date.parse(`${at}T00:00:00Z`) : Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
};

export interface FreshnessInput {
  publishedAt: string | null;
  updatedAt: string | null;
  checkedAt: string | null;
  clockDays: FreshnessClock;
  /** Reasons found by the watch (Search Console, sources, links, questions, the page). */
  signals: FreshnessReason[];
}

/**
 * The article's state: due past its clock or with a hard reason; soon within SOON_DAYS of its clock
 * or with a soft one; otherwise fresh. The clock counts from the latest of Published, Updated and
 * the last check. Null without a Published date: an article that isn't live has no clock.
 */
export function articleFreshness(
  input: FreshnessInput,
  now: Date,
): { state: BlogArticleFreshness["state"]; reasons: FreshnessReason[]; dueAt: string } | null {
  const bases = [input.publishedAt, input.updatedAt, input.checkedAt].map(msOf).filter((m): m is number => m !== null);
  if (msOf(input.publishedAt) === null || !bases.length) return null;
  const base = Math.max(...bases);
  const due = base + input.clockDays * DAY_MS;
  const days = Math.floor((now.getTime() - base) / DAY_MS);
  const age: FreshnessReason[] = now.getTime() >= due ? [{ kind: "age", detail: `${days} days since its last update or check, on a ${input.clockDays}-day clock`, hard: true }] : [];
  const reasons = [...age, ...input.signals].slice(0, 12);
  const state = reasons.some((r) => r.hard) ? "due" : reasons.length || now.getTime() >= due - SOON_DAYS * DAY_MS ? "soon" : "fresh";
  return { state, reasons, dueAt: new Date(due).toISOString() };
}

/** The events with one more, oldest dropped past MAX_EVENTS. */
export function nextEvents(events: BlogArticleFreshness["events"], event: BlogArticleFreshness["events"][number]): BlogArticleFreshness["events"] {
  return [...events, event].slice(-MAX_EVENTS);
}

/** Years in the copy's figures this old or older count as an old figure (a hard reason). */
export const OLD_FIGURE_YEARS = 2;
/** A cited source dated this old or older is an old source (a soft reason). */
export const OLD_SOURCE_YEARS = 2;
/**
 * A new or just updated article: old figures and old sources count only once it is this many
 * days past going live or its last update. Its writer (or its refresh) chose them days ago, so
 * flagging them at once fills Review with articles nobody would refresh yet.
 */
export const NEW_ARTICLE_GRACE_DAYS = 14;

/** Within NEW_ARTICLE_GRACE_DAYS of going live or of its last update (a check doesn't count). */
export function inNewArticleGrace(dates: { publishedAt: string | null; updatedAt: string | null }, now: Date): boolean {
  const at = [dates.publishedAt, dates.updatedAt].map(msOf).filter((m): m is number => m !== null);
  return at.length > 0 && now.getTime() - Math.max(...at) < NEW_ARTICLE_GRACE_DAYS * DAY_MS;
}

const YEAR = /^(?:19|20)\d{2}$/;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** "23 June", "June 23rd": a day of the month is a date, never a figure. */
const DAY_OF_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi");

/**
 * Take out what names a year without stating a figure from it. A citation's year is its
 * source's year, which the old source reason weighs (a soft one): a link's text and target
 * ("[Semrush, 2024](https://...)") and a credit in brackets ("(Ahrefs, 2024)").
 */
function withoutCitations(markdown: string): string {
  return (markdown ?? "")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/\(\s*[^()\n]{1,80},\s*(?:19|20)\d{2}\s*\)/g, " ");
}

/** A credit that ends a sentence or a source line: "..., Semrush, 2024". */
const CREDIT_YEAR = /,\s*(?:19|20)\d{2}\s*[.!?]?\s*$/;

/**
 * The years at least OLD_FIGURE_YEARS old that a copy states a figure from ("In 2023, 38% of
 * buyers..."). A year counts only in a sentence that also states a figure, outside citations:
 * "placeholder dates from 2024" is history, and "[Semrush, 2024](...)" is an old source.
 */
export function oldFigureYears(markdown: string, now: Date): number[] {
  const limit = now.getUTCFullYear() - OLD_FIGURE_YEARS;
  const years = new Set<number>();
  for (const sentence of withoutCitations(markdown).split(/(?<=[.!?])\s+|\n+/)) {
    const figures = articleFigures(sentence.replace(CREDIT_YEAR, " ").replace(DAY_OF_MONTH, " "));
    if (!figures.some((f) => !YEAR.test(f.display))) continue; // a date, not a statistic
    for (const f of figures) if (YEAR.test(f.display) && Number(f.display) <= limit) years.add(Number(f.display));
  }
  return [...years].sort();
}

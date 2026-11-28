import { isoWeekOf } from "@/lib/connectors/period";
import type { MeaningKey } from "@/lib/metrics/meanings";
import { OUTCOMES, type KindCoverage, type OutcomeKind } from "@/lib/metrics/outcomes";
import {
  MONTH_REST_ID,
  STRATEGY_MONTH_LIMITS as M,
  StrategyMonthSchema,
  type MonthNumbers,
  type MonthRow,
  type MonthSource,
  type StrategyDecision,
  type StrategyMonth,
} from "@/lib/types/brandStrategy";
import type { PlanDecision } from "@/lib/types/contentStrategy";

/**
 * How it went's rules (STRATEGY_RESULTS_ENABLED), by code, with no model call: plain counts anyone
 * can check. Pure and client safe: month.ts reads the data and keeps the month on the strategy
 * record; the Strategy tab and Vizzy read it back.
 *
 * Once a calendar month, from the 2nd, the month before is added up for each focus situation of the
 * approved strategy and for the rest of the map together (every other decided situation, and every
 * live article on none of the focus ones), so the focus can be set beside everything else:
 *  - questions, and how many a live article answers (the situations' own counts);
 *  - live articles at the end of the month, and how many went live in it (by the day it went up);
 *  - their articles published in the month, when the brand reads its competitors' articles;
 *  - each kind of result measured (src/lib/metrics/outcomes.ts), added up over the row's live
 *    articles, from one connection per kind; a kind measured for the whole site only is a site
 *    total and never a row's;
 *  - the content plan's roadmap entries to write that were due in the month, and how many are done;
 *  - what people did in the month: stars kept and removed, claims edited, roadmap picks skipped,
 *    and weekly checks acted on or dismissed.
 * Each month keeps where its numbers came from and what it couldn't measure. Newest first, 12 at
 * most, fewer when they'd pass 12 KB.
 */

/** What the tab calls the rest of the map's row, and a focus situation no longer on the map. */
export const REST_TEXT = "Rest of your map";
export const GONE_TEXT = "A buying situation no longer on your map";

const DAY_MS = 86_400_000;
/** Who a change Vizzy made is logged as (store.ts VIZZY_BY): never counted as what people did. */
const VIZZY = "vizzy";

/** The first and last day of a month ("2026-11"), and the moment the next one starts. */
export function monthBounds(month: string): { from: string; to: string; startIso: string; endIso: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return { from: new Date(start).toISOString().slice(0, 10), to: new Date(end - DAY_MS).toISOString().slice(0, 10), startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

/** The calendar month before the one a moment is in (UTC). */
export function previousMonth(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** The ISO weeks whose Monday falls in a month. */
export function weeksIn(month: string): Set<string> {
  const { from, to } = monthBounds(month);
  const out = new Set<string>();
  for (let t = Date.parse(`${from}T00:00:00.000Z`); t <= Date.parse(`${to}T00:00:00.000Z`); t += DAY_MS) {
    if (new Date(t).getUTCDay() === 1) out.add(isoWeekOf(new Date(t).toISOString().slice(0, 10)));
  }
  return out;
}

/** What deciding a month needs of the record. */
export interface MonthRecord {
  approved: { at: string } | null;
  /** The approved strategies before the current one: the first approval is the earliest of them all. */
  history?: ReadonlyArray<{ at: string }>;
  months: Array<Pick<StrategyMonth, "month">>;
  monthsRetryAt: string | null;
}

/** When the strategy was first approved: the earliest of the current approval and those kept before it. Null with none approved. */
export function firstApprovedAt(doc: Pick<MonthRecord, "approved" | "history">): string | null {
  if (!doc.approved) return null;
  return [doc.approved.at, ...(doc.history ?? []).map((h) => h.at)].filter((at) => Number.isFinite(Date.parse(at))).sort()[0] ?? null;
}

/**
 * The first month How it went looks at: the first full calendar month that starts on or after the
 * first approval (approved 20 Nov: December, added up from 2 Jan). No first month is ever partial.
 */
export function firstMonth(firstAt: string): string {
  const d = new Date(firstAt);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const month = start >= d.getTime() ? start : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return new Date(month).toISOString().slice(0, 7);
}

/** The day a month is added up: the 2nd of the month after it (YYYY-MM-DD). */
export function lookDayOf(month: string): string {
  return new Date(Date.parse(monthBounds(month).endIso) + DAY_MS).toISOString().slice(0, 10);
}

/** Whether a month may be looked at at all: on or after the first full month after the first approval. */
export function monthCounts(doc: Pick<MonthRecord, "approved" | "history">, month: string): boolean {
  const first = firstApprovedAt(doc);
  return first !== null && month >= firstMonth(first);
}

/** The Monday an ISO week ("2026-W49") starts on (YYYY-MM-DD). */
export function mondayOfWeek(week: string): string {
  const [y, w] = week.split("-W").map(Number) as [number, number];
  const jan4 = Date.UTC(y, 0, 4);
  const day = new Date(jan4).getUTCDay() || 7;
  return new Date(jan4 - (day - 1) * DAY_MS + (w - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The month due a look at `nowMs`, or null: from the 2nd of a month, the month before, once, when
 * it counts (monthCounts), and not before a failed look's retry time.
 */
export function monthDue(doc: MonthRecord, nowMs: number): string | null {
  if (!doc.approved) return null;
  if (new Date(nowMs).getUTCDate() < 2) return null;
  const month = previousMonth(nowMs);
  if (!monthCounts(doc, month)) return null;
  if (doc.months.some((m) => m.month === month)) return null;
  if (doc.monthsRetryAt && Date.parse(doc.monthsRetryAt) > nowMs) return null;
  return month;
}

export interface MonthArticle {
  /** Its page's key (articlePageKey). */
  key: string;
  /** The day it went up (YYYY-MM-DD or a stamp). */
  publishedAt: string;
  /** The buying situation it was written for, when it says. */
  situationId: string | null;
}

export interface MonthInput {
  month: string;
  nowIso: string;
  approved: { at: string; focusSituationIds: readonly string[] };
  plan: { at: string } | null;
  /** The brand's decided buying situations, with their questions and how many a live article answers. */
  situations: ReadonlyArray<{ id: string; text: string; questions: number; answered: number }>;
  articles: readonly MonthArticle[];
  outcomes: {
    coverage: readonly KindCoverage[];
    byPage: Readonly<Record<string, Partial<Record<MeaningKey, number>>>>;
    site: Partial<Record<MeaningKey, number>>;
    more: readonly OutcomeKind[];
    /** The days each measured kind's numbers cover. */
    periods?: Partial<Record<OutcomeKind, { from: string; to: string }>>;
  };
  /** Their articles (watched competitors, read), or null when the brand doesn't read them. */
  theirs: ReadonlyArray<{ publishedAt: string | null; situationIds: readonly string[] }> | null;
  roadmap: { due: number; done: number } | null;
  /**
   * The approved plan's entries to write due by the end of the month that no live article answers
   * now, earliest first (STRATEGY_SUGGEST_ENABLED: for the month's suggestion; absent while it is off).
   */
  behind?: ReadonlyArray<{ slotId: string; title: string }> | null;
  decisions: readonly StrategyDecision[];
  /** The content plan's decisions, or null without a plan. */
  planDecisions: readonly PlanDecision[] | null;
}

const inMonth = (at: string, b: { startIso: string; endIso: string }) => at >= b.startIso && at < b.endIso;
const dayOf = (at: string) => at.slice(0, 10);

/** What people did in the month, from the logs (each keeps its newest 200). */
function didIn(input: MonthInput, b: ReturnType<typeof monthBounds>): StrategyMonth["did"] {
  const mine = input.decisions.filter((d) => inMonth(d.at, b) && d.by !== VIZZY);
  const count = (kind: StrategyDecision["kind"]) => mine.filter((d) => d.kind === kind).length;
  const plan = (input.planDecisions ?? []).filter((d) => inMonth(d.at, b));
  // A full log whose oldest entry is in the month may have dropped some of it.
  const full = (list: ReadonlyArray<{ at: string }>) => list.length >= 200 && list.at(-1)!.at >= b.startIso;
  return {
    starsKept: count("star_kept"),
    starsRemoved: count("star_removed"),
    claimsEdited: count("claim_edited"),
    picksSkipped: plan.filter((d) => d.kind === "pick_skipped").length,
    checksActed: count("check_acted"),
    checksDismissed: count("check_dismissed"),
    capped: full(input.decisions) || full(input.planDecisions ?? []),
  };
}

/** The numbers a row keeps, by meaning: only the kinds measured by page. */
function numbersOf(keys: readonly string[], input: MonthInput): MonthNumbers {
  const out: Record<string, number> = {};
  for (const c of input.outcomes.coverage) {
    if (c.state !== "measured" || c.siteOnly) continue;
    const source = OUTCOMES[c.kind].sources.find((s) => s.measures[0] === c.measure);
    for (const k of source?.measures ?? []) out[k] = keys.reduce((t, key) => t + (input.outcomes.byPage[key]?.[k] ?? 0), 0);
  }
  return out as MonthNumbers;
}

/** The month added up. Pure. */
export function monthLook(input: MonthInput): StrategyMonth {
  const b = monthBounds(input.month);
  const focusIds = input.approved.focusSituationIds.filter((id) => input.situations.some((s) => s.id === id));
  const focus = new Set(focusIds);
  const rest = input.situations.filter((s) => !focus.has(s.id));
  const restIds = new Set(rest.map((s) => s.id));
  // Live at the end of the month, each on its focus situation or else the rest.
  const live = input.articles.filter((a) => dayOf(a.publishedAt) <= b.to);
  const rowOf = (a: MonthArticle) => (a.situationId && focus.has(a.situationId) ? a.situationId : MONTH_REST_ID);
  const theirsOn = (ids: (id: string) => boolean) =>
    input.theirs ? input.theirs.filter((t) => t.publishedAt && dayOf(t.publishedAt) >= b.from && dayOf(t.publishedAt) <= b.to && t.situationIds.some(ids)).length : null;
  const row = (id: string, questions: number, answered: number, onIt: (id: string) => boolean): MonthRow => {
    const mine = live.filter((a) => rowOf(a) === id);
    return {
      id,
      questions,
      answered,
      live: mine.length,
      newLive: mine.filter((a) => dayOf(a.publishedAt) >= b.from).length,
      theirs: theirsOn(onIt),
      m: numbersOf(mine.map((a) => a.key), input),
    };
  };
  const rows = [
    ...focusIds.map((id) => {
      const s = input.situations.find((x) => x.id === id)!;
      return row(id, s.questions, s.answered, (x) => x === id);
    }),
    row(
      MONTH_REST_ID,
      rest.reduce((t, s) => t + s.questions, 0),
      rest.reduce((t, s) => t + s.answered, 0),
      (x) => restIds.has(x),
    ),
  ];
  const sources: Partial<Record<OutcomeKind, MonthSource>> = {};
  const site: StrategyMonth["site"] = {};
  for (const c of input.outcomes.coverage) {
    if (c.state !== "measured") continue;
    sources[c.kind] = { connectionId: c.connectionId, connector: c.connector.slice(0, 80), measure: c.measure, siteOnly: c.siteOnly };
    if (c.siteOnly && c.measure === "cfVisits" && typeof input.outcomes.site.cfVisits === "number") site.cfVisits = input.outcomes.site.cfVisits;
  }
  return StrategyMonthSchema.parse({
    month: input.month,
    at: input.nowIso,
    strategyAt: input.approved.at,
    partway: input.approved.at > b.startIso,
    planAt: input.plan?.at ?? null,
    rows,
    site,
    roadmap: input.roadmap,
    did: didIn(input, b),
    sources,
    missing: input.outcomes.coverage.flatMap((c) => (c.state === "measured" ? [] : [{ kind: c.kind, why: c.state }])),
    more: input.outcomes.more.filter((k) => sources[k] !== undefined),
    resultsFor: resultsFor(input.outcomes.periods ?? {}, sources),
  });
}

/** The days the measured kinds cover together: the earliest first day and the latest last. */
function resultsFor(periods: Partial<Record<OutcomeKind, { from: string; to: string }>>, sources: Partial<Record<OutcomeKind, MonthSource>>): { from: string; to: string } | null {
  const days = (Object.keys(sources) as OutcomeKind[]).flatMap((k) => (periods[k] ? [periods[k]!] : [])).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to));
  if (!days.length) return null;
  return { from: days.map((p) => p.from).sort()[0]!, to: days.map((p) => p.to).sort().at(-1)! };
}

const sizeOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Where a zero is a number in its own right, not a default: a result, a site total, the roadmap, their articles (null when unread). */
const ZEROS_KEPT = new Set(["m", "site", "roadmap"]);

/** Leave out what the schema's defaults give back: a zero count, false, null, an empty list or object. Pure. */
function compact(value: unknown, keepZeros = false): unknown {
  if (Array.isArray(value)) return value.map((v) => compact(v));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === false || (v === 0 && !keepZeros && k !== "theirs")) continue;
    const c = compact(v, ZEROS_KEPT.has(k));
    if (Array.isArray(c) ? !c.length : c && typeof c === "object" && !Object.keys(c).length && k !== "roadmap") continue;
    out[k] = c;
  }
  return out;
}

/** A month as it is stored: read back with StrategyMonthSchema, it is the same month. Pure. */
export function storedMonth(m: StrategyMonth): Record<string, unknown> {
  return compact(m) as Record<string, unknown>;
}

/**
 * The months with this one in its place, newest first, as they are stored: 12 at most, fewer when a
 * brand's months would pass 12 KB (five focus situations and every kind of result measured). Pure.
 */
export function withMonth(months: readonly StrategyMonth[], month: StrategyMonth): Array<Record<string, unknown>> {
  const out = [month, ...months.filter((m) => m.month !== month.month)].sort((a, b) => b.month.localeCompare(a.month)).slice(0, M.months).map(storedMonth);
  while (out.length > 1 && sizeOf(out) > M.bytes) out.pop();
  return out;
}

export type Arrow = "up" | "down" | "same";

/** Results days further apart than this aren't compared: a look retried later reads other days. */
const DRIFT_DAYS = 3;

/** The two months had the same focus situations, so every row, the rest of the map too, is about the same thing. */
const sameFocus = (a: StrategyMonth, b: StrategyMonth) => {
  const ids = (m: StrategyMonth) => m.rows.filter((r) => r.id !== MONTH_REST_ID).map((r) => r.id).sort().join(",");
  return ids(a) === ids(b);
};

/** Both months say which days their results cover, and those days end no more than 3 days apart (by calendar month). */
function sameWindow(a: StrategyMonth, b: StrategyMonth): boolean {
  if (!a.resultsFor || !b.resultsFor) return false;
  const shift = (day: string, months: number) => {
    const d = new Date(`${day}T00:00:00.000Z`);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
  };
  // The later month's window should end a month after the earlier one's.
  return Math.abs(Date.parse(`${a.resultsFor.to}T00:00:00.000Z`) - shift(b.resultsFor.to, 1)) <= DRIFT_DAYS * DAY_MS;
}

/**
 * How a row's number for one kind moved against the month before, or null when it can't be said:
 * only when both months had the same focus situations, the same source for that kind (the same
 * connection and number) and results for matching days (ending within 3 days of a month apart), so
 * connecting a tool, changing the focus or a retried look never reads as a jump. Pure.
 */
export function arrowFor(month: StrategyMonth, before: StrategyMonth | null | undefined, rowId: string, kind: OutcomeKind): Arrow | null {
  const now = month.sources[kind];
  const then = before?.sources[kind];
  if (!now || !then || now.siteOnly || now.connectionId !== then.connectionId || now.measure !== then.measure) return null;
  if (!sameFocus(month, before!) || !sameWindow(month, before!)) return null;
  const key = now.measure as keyof MonthNumbers;
  const a = month.rows.find((r) => r.id === rowId)?.m[key];
  const b = before!.rows.find((r) => r.id === rowId)?.m[key];
  if (typeof a !== "number" || typeof b !== "number") return null;
  return a > b ? "up" : a < b ? "down" : "same";
}

/** The arrow and by how much, for a row and kind, or null as arrowFor says. Pure. */
export function moveFor(month: StrategyMonth, before: StrategyMonth | null | undefined, rowId: string, kind: OutcomeKind): { arrow: Arrow; by: number } | null {
  const arrow = arrowFor(month, before, rowId, kind);
  if (!arrow) return null;
  const key = month.sources[kind]!.measure as keyof MonthNumbers;
  const a = month.rows.find((r) => r.id === rowId)!.m[key]!;
  const b = before!.rows.find((r) => r.id === rowId)!.m[key]!;
  return { arrow, by: Math.abs(a - b) };
}

/** The calendar month before this one, if it was kept: a gap means no comparison. */
export function monthBefore(months: readonly StrategyMonth[], month: string): StrategyMonth | null {
  const before = previousMonth(Date.parse(monthBounds(month).startIso));
  return months.find((m) => m.month === before) ?? null;
}

/**
 * "Too early to tell": no month is kept yet and the first month's look day hasn't come. Once a month
 * is kept it is never too early. Pure.
 */
export function tooEarly(doc: Pick<MonthRecord, "approved" | "history" | "months">, nowMs: number): boolean {
  if (doc.months.length) return false;
  const first = firstApprovedAt(doc);
  if (!first) return true;
  return new Date(nowMs).toISOString().slice(0, 10) < lookDayOf(firstMonth(first));
}

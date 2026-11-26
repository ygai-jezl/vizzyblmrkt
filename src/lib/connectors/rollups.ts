import { isBrandMapEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { parseQuestion } from "@/lib/brandMap/records";
import { readBrandMap } from "@/lib/brandMap/store";
import type { TenantContext } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { MetricSnapshot, RolledSpan, SnapshotBasis, SnapshotBy, SnapshotNote, SnapshotRow } from "@/lib/types/metricSnapshot";
import { ROLLED_SPANS } from "@/lib/types/metricSnapshot";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { planningId, rolledId, topicKey } from "./keys";
import { addDays, laterDay } from "./period";
import { compareRows, cutRows, putSnapshot, readDayDocs, ttlFor, type SnapshotOwner, type StoreDeps } from "./snapshots";

/**
 * Rolled numbers (Connectors 2, ADR-0012): once a day, after a day lands, the lane rewrites each
 * grouping's 28 and 90 days to the last collected day from the kept day docs, so Vizzy, Next up and
 * the context pack read one small doc instead of adding up 90 of them on a busy server. Search
 * Console also gets a planning doc: a ready line for each brand map question whose words people
 * searched (`question_r28`); the subject lines (`subject_r28`) come with signals, which map searches
 * to subjects by meaning.
 *
 * How numbers add up across days:
 * - counts add up (clicks, impressions, sessions, views, key events, requests, page views, visits);
 * - click rate is worked out again from clicks and impressions;
 * - position is weighted by impressions;
 * - counts of people (active users, unique visitors) can't be added across days, so they stay empty
 *   in rolled totals and in rows that add days (a day's own row on a by-day doc keeps them), and
 *   neither can a number that isn't a count (a share, a rank or a score: notAdded);
 * - a window's total needs every day's: one day without it leaves that total empty;
 * - range totals come only from the day docs' totals (Search Console adds days by property and
 *   pages by page, so page rows never add up to the total);
 * - a row missing from a day whose rows were cut may have been there below the floor: `cutDays`
 *   counts those days, so a rule can treat each as "at most the floor", and a reader says "at least";
 * - `merged` (Search Console addresses of one page added together) keeps the most any day merged;
 * - Google Analytics sessions add up here, though Google Analytics estimates them and counts a
 *   session past midnight on both days: readers say its own range can be slightly lower (ADR-0012).
 */

/** Counts of people: never added across days. */
export const PEOPLE_KEYS: ReadonlySet<string> = new Set(["ga4ActiveUsers", "cfUniqueVisitors"]);
/** Worked out again, never added. */
const RATE_KEYS: ReadonlySet<string> = new Set(["searchCtr", "searchPosition", "merged"]);
/**
 * A number its meaning says isn't a count (a share, a rank, a score, such as AI share of voice or
 * sentiment, ADR-0019) never adds up across days: a period's figure is the provider's own, so it
 * stays empty in rolled totals and rows that add days, and each day keeps its own.
 */
export const notAdded = (k: string): boolean => !RATE_KEYS.has(k) && Object.prototype.hasOwnProperty.call(MEANINGS, k) && MEANINGS[k as MeaningKey].unit !== "count";

/** Every number in a day's totals, added across days as each one allows. */
export function rollTotals(days: ReadonlyArray<Record<string, number | null> | null>): Record<string, number | null> {
  const keys = new Set(days.flatMap((d) => Object.keys(d ?? {})));
  const out: Record<string, number | null> = {};
  for (const k of keys) {
    if (PEOPLE_KEYS.has(k) || RATE_KEYS.has(k) || notAdded(k)) continue;
    const values = days.map((d) => d?.[k]);
    out[k] = values.every((v) => typeof v === "number") ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  }
  if (keys.has("searchCtr")) out.searchCtr = out.searchImpressions ? (out.searchClicks ?? 0) / out.searchImpressions : null;
  if (keys.has("searchPosition")) {
    let weighted = 0;
    let shown = 0;
    for (const d of days) {
      const p = d?.searchPosition;
      const i = d?.searchImpressions;
      if (typeof p === "number" && typeof i === "number" && i > 0) {
        weighted += p * i;
        shown += i;
      }
    }
    out.searchPosition = shown ? weighted / shown : null;
  }
  for (const k of PEOPLE_KEYS) if (keys.has(k)) out[k] = null;
  for (const k of keys) if (notAdded(k)) out[k] = null;
  return out;
}

/** A row's numbers, added across the days it was kept, as rollTotals adds totals. */
interface RowAcc {
  key: string;
  host?: string;
  sums: Record<string, number>;
  weighted: number;
  shown: number;
  seenOn: Set<string>;
  /** The most addresses any one day merged into this row (Search Console pages). */
  merged: number;
}

/** Adds one grouping's day docs into rows, one doc at a time. */
export class RowRoller {
  private rows = new Map<string, RowAcc>();
  private cutDays: string[] = [];
  private days = 0;
  private finalDays = 0;
  more = false;
  notes = new Set<SnapshotNote>();
  bases = new Set<SnapshotBasis>();
  totals: Array<Record<string, number | null> | null> = [];
  dayRows: SnapshotRow[] = [];

  include(doc: MetricSnapshot): void {
    this.days += 1;
    if (doc.final) this.finalDays += 1;
    if (doc.more) this.more = true;
    for (const n of doc.notes ?? []) this.notes.add(n);
    if (doc.basis) this.bases.add(doc.basis);
    this.totals.push(doc.totals);
    if (doc.by === "day" && doc.totals && doc.day) {
      const m: Record<string, number> = {};
      for (const [k, v] of Object.entries(doc.totals)) if (typeof v === "number") m[k] = v;
      this.dayRows.push({ key: doc.day, m });
    }
    if (doc.rowsDropped > 0 || doc.more) this.cutDays.push(doc.day ?? "");
    for (const r of doc.rows) {
      const id = `${r.host ?? ""}\u0000${r.key}`;
      const acc = this.rows.get(id) ?? { key: r.key, ...(r.host ? { host: r.host } : {}), sums: {}, weighted: 0, shown: 0, seenOn: new Set<string>(), merged: 0 };
      acc.seenOn.add(doc.day ?? "");
      if (typeof r.m.merged === "number" && r.m.merged > acc.merged) acc.merged = r.m.merged;
      for (const [k, v] of Object.entries(r.m)) {
        if (PEOPLE_KEYS.has(k) || RATE_KEYS.has(k) || notAdded(k)) continue;
        acc.sums[k] = (acc.sums[k] ?? 0) + v;
      }
      if (typeof r.m.searchPosition === "number" && typeof r.m.searchImpressions === "number" && r.m.searchImpressions > 0) {
        acc.weighted += r.m.searchPosition * r.m.searchImpressions;
        acc.shown += r.m.searchImpressions;
      }
      this.rows.set(id, acc);
    }
  }

  /** How many days were added, and whether every one was final. */
  get count(): number {
    return this.days;
  }
  get allFinal(): boolean {
    return this.days > 0 && this.finalDays === this.days;
  }

  /** The kept rows, at most `keep`, each with the cut days it was missing from. */
  result(keep: number): { rows: SnapshotRow[]; rowsSeen: number; rowsDropped: number; floor: Record<string, number> | null } {
    const rows: SnapshotRow[] = [...this.rows.values()].map((a) => {
      const m: Record<string, number> = { ...a.sums };
      if (typeof m.searchImpressions === "number" && "searchClicks" in m) m.searchCtr = m.searchImpressions ? m.searchClicks! / m.searchImpressions : 0;
      if (a.shown > 0) m.searchPosition = a.weighted / a.shown;
      if (a.merged > 0) m.merged = a.merged;
      const cut = this.cutDays.filter((d) => !a.seenOn.has(d)).length;
      return { key: a.key, ...(a.host ? { host: a.host } : {}), m, ...(cut ? { cutDays: cut } : {}) };
    });
    return cutRows(rows, keep);
  }

  basis(): SnapshotBasis | null {
    if (!this.bases.size) return null;
    return this.bases.size === 1 ? [...this.bases][0]! : "mixed";
  }
}

export interface RollInput {
  owner: SnapshotOwner;
  stream: string;
  by: readonly SnapshotBy[];
  keepDays: number;
  lastDay: string;
  /** The oldest day kept, so the windows never reach before it. */
  backfilledTo: string;
  timeZone: string | null;
}

/** The days a rolled span covers: its length to lastDay, never before the oldest day kept. */
export function windowOf(span: RolledSpan, lastDay: string, backfilledTo: string): { from: string; to: string } {
  return { from: laterDay(addDays(lastDay, -(ROLLED_SPANS[span] - 1)), backfilledTo), to: lastDay };
}

/**
 * Rewrite every grouping's 28 and 90 day docs from the day docs, reading each day once (both
 * windows add it). Search Console's topic grouping also writes the questions' planning doc.
 * Returns how many docs were written.
 */
export async function rollConnection(ctx: TenantContext, input: RollInput, deps: StoreDeps = {}): Promise<number> {
  const at = (deps.now ?? new Date()).toISOString();
  const ttlAt = ttlFor(input.lastDay, input.keepDays);
  let written = 0;
  for (const by of input.by) {
    const w28 = windowOf("r28", input.lastDay, input.backfilledTo);
    const w90 = windowOf("r90", input.lastDay, input.backfilledTo);
    const rollers: Record<RolledSpan, RowRoller> = { r28: new RowRoller(), r90: new RowRoller() };
    await readDayDocs(ctx, input.owner, input.stream, by, w90.from, w90.to, {
      ...deps,
      each: (doc) => {
        rollers.r90.include(doc);
        if (doc.day && doc.day >= w28.from) rollers.r28.include(doc);
      },
    });
    for (const span of ["r28", "r90"] as const) {
      const roller = rollers[span];
      const window = span === "r28" ? w28 : w90;
      const kept = by === "day" ? { rows: [...roller.dayRows].sort((a, b) => a.key.localeCompare(b.key)), rowsSeen: roller.dayRows.length, rowsDropped: 0, floor: null } : roller.result(500);
      await putSnapshot(
        ctx,
        rolledId(input.owner.id, input.owner.gen, input.stream, by, span),
        {
          connectionId: input.owner.id,
          gen: input.owner.gen,
          account: input.owner.account,
          connectorId: input.owner.connectorId,
          stream: input.stream,
          by,
          day: null,
          window,
          days: roller.count,
          timeZone: input.timeZone,
          final: roller.allFinal,
          totals: by === "day" ? rollTotals(roller.totals) : null,
          rows: kept.rows,
          rowsSeen: kept.rowsSeen,
          rowsDropped: kept.rowsDropped,
          more: roller.more,
          floor: kept.floor,
          basis: roller.basis(),
          notes: [...roller.notes],
          collectedAt: at,
          ttlAt,
        },
        deps,
      );
      written += 1;
      if (span === "r28" && by === "topic") written += await writeQuestionLines(ctx, input, window, roller.count, kept.rows, deps);
    }
  }
  return written;
}

/** A decided brand map question, for matching its words with a search's. */
interface MapQuestion {
  id: string;
  subjectId: string;
  key: string;
}

/** The brand's decided questions whose words are one of these keys: the large map by an equality lookup, the small one in memory. */
async function questionsByKey(ctx: TenantContext, keys: string[], deps: StoreDeps): Promise<MapQuestion[]> {
  if (!keys.length || !isBrandMapEnabled()) return [];
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return [];
  if (isBrandMapScaleEnabled() && read.map.moved) {
    const found = await brandMapRecords(ctx, deps.db).findIn("q", "textKey", keys);
    return found.flatMap((r) => parseQuestion(r) ?? []).filter((q) => q.status === "decided").map((q) => ({ id: q.id, subjectId: q.subjectId, key: q.textKey || topicKey(q.text) }));
  }
  const wanted = new Set(keys);
  return read.map.subjects.flatMap((s) => s.questions.map((q) => ({ id: q.id, subjectId: s.id, key: topicKey(q.text) }))).filter((q) => wanted.has(q.key));
}

/**
 * The questions' planning doc: for each decided question whose words people searched (the same
 * words as the brand map keys them), the search's own words and its 28 day clicks, impressions,
 * click rate and position, with the days it fell under a cut (`cutDays`), when its numbers are only
 * a lower bound. Written even when nothing matches, so a reader knows it was looked at.
 */
async function writeQuestionLines(ctx: TenantContext, input: RollInput, window: { from: string; to: string }, days: number, searches: SnapshotRow[], deps: StoreDeps): Promise<number> {
  const byKey = new Map<string, SnapshotRow>();
  for (const s of [...searches].sort(compareRows)) {
    const k = topicKey(s.key);
    if (k && !byKey.has(k)) byKey.set(k, s);
  }
  const questions = await questionsByKey(ctx, [...byKey.keys()], deps);
  const rows: SnapshotRow[] = questions
    .map((q) => {
      const s = byKey.get(q.key)!;
      const m: Record<string, number> = {};
      for (const k of ["searchClicks", "searchImpressions", "searchCtr", "searchPosition"]) if (typeof s.m[k] === "number") m[k] = s.m[k]!;
      // Days the search fell under a cut day's top 500: its numbers are then at least these.
      return { key: q.id, label: s.key, subjectId: q.subjectId, m, ...(s.cutDays ? { cutDays: s.cutDays } : {}) };
    })
    .sort(compareRows);
  await putSnapshot(
    ctx,
    planningId(input.owner.id, input.owner.gen, input.stream, "question"),
    {
      connectionId: input.owner.id,
      gen: input.owner.gen,
      account: input.owner.account,
      connectorId: input.owner.connectorId,
      stream: input.stream,
      by: "question",
      day: null,
      window,
      days,
      timeZone: input.timeZone,
      final: true,
      totals: null,
      rows,
      rowsSeen: rows.length,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: (deps.now ?? new Date()).toISOString(),
      ttlAt: ttlFor(input.lastDay, input.keepDays),
    },
    deps,
  );
  return 1;
}

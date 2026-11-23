import { z } from "zod";
import { changeDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import { MEANINGS, meaningsOf, numberKeys, type MeaningKey } from "@/lib/metrics/meanings";
import { DATA_CONNECTION_ID_RE, type CollectState, type DataConnection, type ReadActivityDetail } from "@/lib/types/dataConnection";
import { SNAPSHOT_BY, type MetricSnapshot, type RolledSpan, type SnapshotBasis, type SnapshotBy, type SnapshotNote, type SnapshotRow } from "@/lib/types/metricSnapshot";
import type { AgentApiResult } from "./agentGate";
import { NO_AGENT_GRANT, NO_MEMBER_READ } from "./agentApi";
import { can, type ConnectorActor } from "./grants";
import { olderDaysNote } from "./handlers/cloudflare";
import { APP_SCREENS_NOTE, OTHER_NOTE, SAMPLED_NOTE, THRESHOLD_NOTE } from "./handlers/googleAnalytics";
import { rolledId, snapshotId } from "./keys";
import { PagePathSchema, READ_COUNTS } from "./live";
import { LIVE_LIMITS, streamOf, type ConnectorManifest, type ProducedStream, type StreamCollect } from "./manifest";
import { CONNECTOR_ERRORS, connectorMessage } from "./messages";
import { cleanPagePath } from "./paths";
import { addDays, daysIn, daysWords, dayWords, isDay, laterDay, LIVE_PERIODS, periodAnswer, PERIOD_DAYS, todayIn, type LivePeriod, type PeriodAnswer } from "./period";
import { getConnector } from "./registry";
import { PEOPLE_KEYS, RowRoller, rollTotals } from "./rollups";
import type { ServiceDeps } from "./service";
import { KEEP_ROWS, readDayDocs, readSnapshot } from "./snapshots";

/**
 * Vizzy's collected numbers (Connectors 2, ADR-0012): get_connected_numbers, through
 * POST /api/agent/connectors/numbers. Reads only the brand's metric snapshots, by id, and never
 * calls the provider, so it spends none of its quota. Live reads explore; collected numbers back a
 * decision, because their days no longer change.
 *
 * - The brand is the canvas token's (connectorsAgentGate with NUMBERS_GATE); nothing in a request
 *   names one. A disconnected connection is refused (its leftovers wait for erase), then the
 *   grants table decides, as for a live read: Vizzy reads only with the grant {to: "agent:vizzy"},
 *   and for a member only when members may read it too.
 * - Vizzy asks for a named period and the server works out the days: every period ends on the last
 *   collected day, in the provider's own zone. Yesterday and the last 7 days add up the day docs;
 *   the last 28 and 90 days read the rolled docs the lane writes once a day. Explicit days are for
 *   days the person named: capped at the last collected day, at most 14 days by page, search or
 *   landing page (a longer span uses a period) and the days kept by day.
 * - Totals come only from the day grouping's totals: counts add up, click rate is worked out again,
 *   position is weighted by impressions, and counts of people (active users, unique visitors) are
 *   left empty over more than one day, in totals and in rows, with a note to read them live.
 * - Every number in an answer has its meaning, worked out from the answer itself
 *   (meaningsOf(numberKeys(body))), so a number can never reach Vizzy without one.
 * - Each read is logged on the connection's activity as "read" by agent:vizzy with code
 *   "collected" and what was asked, never a number or a page, off the record's recent list.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Explicit days by page, search or landing page reach at most this far; longer spans use a period. */
export const GROUPED_DAYS_MAX = 14;
/** Rows an answer gives when none are asked for. */
export const DEFAULT_ROWS = 50;
/** Which named periods read the rolled docs. */
const ROLLED: Partial<Record<LivePeriod, RolledSpan>> = { last_28_days: "r28", last_90_days: "r90" };

export const AgentNumbersSchema = z
  .object({
    connectionId: z.string().regex(DATA_CONNECTION_ID_RE),
    stream: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    period: z.enum(LIVE_PERIODS).optional(),
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    by: z.enum(SNAPSHOT_BY).default("day"),
    limit: z.number().int().min(1).max(LIVE_LIMITS.maxRows).default(DEFAULT_ROWS),
    page: PagePathSchema.optional(),
  })
  .strict()
  .refine((b) => (b.period ? b.from === undefined && b.to === undefined : b.from !== undefined && b.to !== undefined), "a period, or both from and to");
export type AgentNumbersRequest = z.infer<typeof AgentNumbersSchema>;

// --- Words (house style: no dashes) ------------------------------------------------------------

export const NOT_COLLECTED_YET =
  "Nothing has been collected for this connection yet. Collecting starts within a day of connecting and fills 90 days over the next few hours, so read it live meanwhile.";
export const NOT_ROLLED_YET = "The 28 and 90 day numbers are added up once a day after collecting, and aren't ready for this connection yet. Ask for the last 7 days, or read it live.";
export const STREAM_NOT_COLLECTED = "That stream isn't collected, so it can only be read live.";
export const PAGE_NEEDS_GROUPING = "Collected numbers for one page come by page or landing page. Ask by page with the page, or read it live for its days.";
export const MIXED_BASIS_NOTE =
  "Cloudflare keeps end user numbers only for recent days, so for the older days here requests and page views count all traffic, bots included, and visits are empty.";
export const CUT_ROWS_NOTE = "Each day keeps its top 500 rows, so a row that fell below them on some days counts only the days it was kept, and may be a little low.";

/** Explicit days that reach too far for the grouping. */
export function rangeTooLong(by: SnapshotBy, max: number): string {
  return by === "day"
    ? `Collected numbers keep ${max} days, so explicit days can span at most ${max}. Ask for a shorter span, or read it live.`
    : `Explicit days by ${GROUPING_WORDS[by]} can span at most ${max} days. For longer, ask for the last 28 or 90 days.`;
}

const GROUPING_WORDS: Readonly<Record<SnapshotBy, string>> = { day: "day", page: "page", topic: "search", landing: "landing page" };
const ROW_NOUNS: Readonly<Record<SnapshotBy, string>> = { day: "days", page: "pages", topic: "searches", landing: "landing pages" };

const NOTE_WORDS: Readonly<Record<SnapshotNote, string>> = { other_row: OTHER_NOTE, sampled: SAMPLED_NOTE, thresholded: THRESHOLD_NOTE, app_screens: APP_SCREENS_NOTE };

/** "Analytics active users" or "Analytics active users and Cloudflare unique visitors". */
const peopleNames = (keys: readonly string[]) => keys.map((k) => MEANINGS[k as MeaningKey]?.name ?? k).join(" and ");

/** Counts of people over more than one day: empty, and why. */
export function peopleNote(keys: readonly string[], byDay: boolean): string {
  const they = keys.length === 1 ? "it" : "them";
  return byDay
    ? `${peopleNames(keys)} can't be added across days, so the totals leave ${they} out and each day's row has its own. Read live for the whole period's figure.`
    : `${peopleNames(keys)} can't be added across days, so ${keys.length === 1 ? "it is" : "they are"} empty here. Read live for the whole period's figure.`;
}

/** Days after the period that are over but not collected yet: "21 and 22 Nov aren't in these numbers yet." */
export function notInYetNote(from: string, to: string): string {
  return `${daysWords(from, to)} ${from === to ? "isn't" : "aren't"} in these numbers yet.`;
}

/** Days that may still change (Google Analytics, read again a week later). */
export function notFinalNote(from: string, to: string): string {
  return `Numbers for ${daysWords(from, to)} may still change a little, until they are read again a week after each day.`;
}

/** A connection that stopped collecting: where its numbers end, and why. */
export function stoppedNote(lastDay: string, why: string): string {
  return `Collecting has stopped, so these numbers end on ${dayWords(lastDay)}. ${why}`;
}

/** Explicit days capped at the last collected day. */
export function cappedCollectedNote(name: string, lastDay: string): string {
  return `${name} numbers are collected to ${dayWords(lastDay)}, so this read ends there.`;
}

/** Explicit days that are all after the last collected day. */
export function nothingCollectedNote(from: string, to: string, lastDay: string): string {
  return `Nothing is collected for ${daysWords(from, to)} yet. The last collected day is ${dayWords(lastDay)}.`;
}

/** Explicit days before the oldest one kept. */
export function startsNote(oldest: string): string {
  return `Collected numbers start on ${dayWords(oldest)}, so this starts there. Read live for earlier days.`;
}

/** A named period that reaches before the oldest day kept, while a new connection fills. */
export function fillingNote(oldest: string, days: number, wanted: number): string {
  return `Collected numbers start on ${dayWords(oldest)}, so this period covers ${days} of its ${wanted} days.`;
}

/** Days in the window with no collected doc. */
export function missingNote(days: readonly string[]): string {
  return days.length === 1 ? `${dayWords(days[0]!)} has no collected numbers, so it isn't counted.` : `${days.length} of these days have no collected numbers, so they aren't counted.`;
}

/** One page asked for that the kept rows don't hold. */
export function pageNotKeptNote(page: string, by: SnapshotBy): string {
  return `${page} isn't among the ${ROW_NOUNS[by]} kept for these days. Each day keeps its top 500, so read it live for its numbers.`;
}

// --- Reading -----------------------------------------------------------------------------------

/** What the docs gave for a window, before the answer is shaped. */
interface Read {
  from: string;
  to: string;
  timeZone: string | null;
  /** Days with numbers. */
  days: number;
  /** Every day final. */
  final: boolean;
  totals: Record<string, number | null> | null;
  /** Ranked (by day: oldest first), before the page filter and the limit. */
  rows: SnapshotRow[];
  /** Rows the kept docs left out. */
  dropped: number;
  notes: Set<SnapshotNote>;
  basis: SnapshotBasis | null;
  /** Days read from day docs: the ones not final, those counting all traffic, those with no doc. */
  notFinal: string[];
  allTraffic: string[];
  missing: string[];
}

/** The row key a grouping's rows carry, as a live read names it: Search Console's searches are `query`. */
export function rowKeyOf(stream: Pick<ProducedStream, "joins">, by: SnapshotBy): string {
  if (by !== "topic") return by;
  return Object.keys(stream.joins).find((k) => stream.joins[k] === "topic") ?? "topic";
}

/** The days from `from` to `to`, oldest first. */
const daysFrom = (from: string, to: string) => (from > to ? [] : Array.from({ length: daysIn(from, to) }, (_, i) => addDays(from, i)));

/** A day doc's totals as a by-day row. */
function dayRow(doc: MetricSnapshot): SnapshotRow {
  const m: Record<string, number> = {};
  for (const [k, v] of Object.entries(doc.totals ?? {})) if (typeof v === "number") m[k] = v;
  return { key: doc.day ?? "", m };
}

/** The rolled docs of a span: the day grouping's for the totals, and the grouping's own for rows. */
async function readRolled(ctx: TenantContext, conn: DataConnection, gen: number, stream: string, by: SnapshotBy, span: RolledSpan, deps: Pick<ServiceDeps, "db">): Promise<Read | null> {
  const day = await readSnapshot(ctx, rolledId(conn.id, gen, stream, "day", span), deps);
  if (!day?.window) return null;
  const own = by === "day" ? day : await readSnapshot(ctx, rolledId(conn.id, gen, stream, by, span), deps);
  // Both from the same day's roll, or a roll that stopped half way is read as not ready.
  if (!own || own.window?.from !== day.window.from || own.window?.to !== day.window.to) return null;
  const notes = new Set<SnapshotNote>([...(day.notes ?? []), ...(own.notes ?? [])]);
  return {
    from: day.window.from,
    to: day.window.to,
    timeZone: day.timeZone,
    days: day.days ?? 0,
    final: day.final,
    totals: day.totals,
    rows: by === "day" ? [...own.rows].sort((a, b) => a.key.localeCompare(b.key)) : own.rows,
    dropped: own.rowsDropped,
    notes,
    basis: day.basis,
    notFinal: [],
    allTraffic: [],
    missing: [],
  };
}

/** The day docs of a window, added up the way the rolled docs are. */
async function readDays(ctx: TenantContext, conn: DataConnection, gen: number, stream: string, by: SnapshotBy, from: string, to: string, timeZone: string | null, deps: Pick<ServiceDeps, "db">): Promise<Read> {
  const owner = { id: conn.id, gen };
  const dayDocs = await readDayDocs(ctx, owner, stream, "day", from, to, deps);
  const ordered = daysFrom(from, to).flatMap((d) => (dayDocs.has(d) ? [dayDocs.get(d)!] : []));
  const notes = new Set<SnapshotNote>();
  const bases = new Set<SnapshotBasis>();
  for (const d of ordered) {
    for (const n of d.notes ?? []) notes.add(n);
    if (d.basis) bases.add(d.basis);
  }
  const single = ordered.length === 1;
  let rows: SnapshotRow[];
  let dropped = 0;
  if (by === "day") rows = ordered.map(dayRow);
  else if (from === to) {
    const doc = await readSnapshot(ctx, snapshotId(conn.id, gen, stream, by, from), deps);
    rows = doc?.rows ?? [];
    dropped = doc?.rowsDropped ?? 0;
    for (const n of doc?.notes ?? []) notes.add(n);
  } else {
    const roller = new RowRoller();
    await readDayDocs(ctx, owner, stream, by, from, to, { ...deps, each: (doc) => roller.include(doc) });
    const kept = roller.result(KEEP_ROWS);
    rows = kept.rows;
    dropped = kept.rowsDropped;
    for (const n of roller.notes) notes.add(n);
  }
  return {
    from,
    to,
    timeZone: ordered[0]?.timeZone ?? timeZone,
    days: ordered.length,
    final: ordered.every((d) => d.final),
    totals: ordered.length === 0 ? null : single ? { ...ordered[0]!.totals } : rollTotals(ordered.map((d) => d.totals)),
    rows,
    dropped,
    notes,
    basis: bases.size === 0 ? null : bases.size === 1 ? [...bases][0]! : "mixed",
    notFinal: ordered.filter((d) => !d.final).map((d) => d.day!),
    allTraffic: ordered.filter((d) => d.basis === "all_traffic").map((d) => d.day!),
    missing: daysFrom(from, to).filter((d) => !dayDocs.has(d)),
  };
}

// --- The answer --------------------------------------------------------------------------------

type Row = Record<string, string | number | null>;

/** A kept row as Vizzy reads it: its key under the stream's own name, the host, then its numbers. */
function shapeRow(r: SnapshotRow, keyName: string, measures: readonly string[], peopleEmpty: boolean): Row {
  const out: Row = { [keyName]: r.key };
  if (r.host) out.host = r.host;
  for (const k of measures) {
    if (peopleEmpty && PEOPLE_KEYS.has(k)) out[k] = null;
    else if (typeof r.m[k] === "number") out[k] = r.m[k]!;
  }
  for (const k of READ_COUNTS) if (typeof r.m[k] === "number") out[k] = r.m[k]!;
  return out;
}

/** The period's totals, the stream's measures only, people empty over more than one day. */
function shapeTotals(totals: Record<string, number | null> | null, measures: readonly string[], peopleEmpty: boolean): Record<string, number | null> | null {
  if (!totals) return null;
  const out: Record<string, number | null> = {};
  for (const k of measures) {
    if (!(k in totals)) continue;
    out[k] = peopleEmpty && PEOPLE_KEYS.has(k) ? null : (totals[k] ?? null);
  }
  return out;
}

/** The first and last of some days, oldest first. */
const spanOf = (days: readonly string[]): [string, string] | null => {
  if (!days.length) return null;
  const sorted = [...days].sort();
  return [sorted[0]!, sorted.at(-1)!];
};

const refuse = (status: number, error: string, message?: string): AgentApiResult => ({ status, body: { error, ...(message ? { message } : {}) } });

/** Why collecting stopped, in words, or null while it goes on. */
function stoppedWhy(conn: DataConnection, name: string): string | null {
  if (conn.pausedAt) return CONNECTOR_ERRORS.paused;
  if (conn.health.state === "broken") return connectorMessage(conn.health.lastErrorCode, { name, chat: true, since: conn.health.since ?? null });
  return null;
}

/**
 * get_connected_numbers: a connection's collected numbers for a period, by day, page, search or
 * landing page, every number with its meaning. The answer names the connector for the source line
 * (connection.connectorId), the days read as period {from, to, timeZone, finalThrough, words}, the
 * stream's lag in words and lagDays, totals for the period, the rows asked for, how many rows it
 * left out (rowsDropped) and each note once.
 */
export async function agentCollectedNumbers(ctx: TenantContext, actor: ConnectorActor, body: unknown, deps: Pick<ServiceDeps, "db" | "now"> = {}): Promise<AgentApiResult> {
  const parsed = AgentNumbersSchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const q = parsed.data;
  const now = deps.now ?? new Date();

  // Who may read it: the brand's own connection, still connected, then the grants.
  const conn = await forTenant(ctx, deps.db).dataConnections.getById(q.connectionId);
  if (!conn) return refuse(404, "not_found");
  if (conn.status !== "connected") return refuse(409, "disconnected", connectorMessage("disconnected"));
  if (!can(actor, "see", conn.grants)) return refuse(403, "no_agent_grant", NO_AGENT_GRANT);
  if (!can(actor, "read_live", conn.grants)) return refuse(403, "no_read_grant", NO_MEMBER_READ);
  const manifest = getConnector(conn.connectorId);
  if (!manifest) return refuse(404, "connector_off");

  // What may be asked of this stream.
  const produced = streamOf(manifest, q.stream);
  if (!produced) return refuse(400, "unknown_stream");
  if (!produced.collect) return refuse(400, "stream_not_collected", STREAM_NOT_COLLECTED);
  const stream = produced as ProducedStream & { collect: StreamCollect };
  if (!stream.collect.by.includes(q.by)) return refuse(400, "by_not_allowed");
  if (q.page !== undefined) {
    if (!(stream.liveFilters ?? []).includes("page")) return refuse(400, "page_not_allowed");
    if (q.by !== "page" && q.by !== "landing") return refuse(400, "page_needs_grouping", PAGE_NEEDS_GROUPING);
  }

  // What is kept: the cursor, in the provider's zone.
  const c: CollectState | undefined = conn.collect;
  if (!c?.lastDay || !c.backfilledTo) return refuse(409, "not_collected_yet", NOT_COLLECTED_YET);
  const keep = stream.collect.keepDays;
  const zone = stream.timeZone ?? c.timeZone ?? null;
  const today = todayIn(now, zone ?? "UTC");
  const lastDay = c.lastDay;
  // Days older than the keep window leave by their time to live, counted from the day itself.
  const oldest = laterDay(laterDay(c.backfilledTo, addDays(lastDay, -(keep - 1))), addDays(todayIn(now, "UTC"), -(keep - 1)));
  if (oldest > lastDay) return refuse(409, "not_collected_yet", NOT_COLLECTED_YET);

  const notes: string[] = [];
  let read: Read | null;
  let reachesEnd = true;
  if (q.period) {
    const span = ROLLED[q.period];
    if (span) {
      read = await readRolled(ctx, conn, c.gen, stream.stream, q.by, span, deps);
      if (!read) return refuse(409, "not_ready", NOT_ROLLED_YET);
    } else {
      const from = laterDay(addDays(lastDay, -(PERIOD_DAYS[q.period] - 1)), oldest);
      read = await readDays(ctx, conn, c.gen, stream.stream, q.by, from, lastDay, zone, deps);
    }
    const wanted = PERIOD_DAYS[q.period];
    if (read.from > addDays(read.to, -(wanted - 1))) notes.push(fillingNote(read.from, daysIn(read.from, read.to), wanted));
  } else {
    const from = q.from!;
    const to = q.to!;
    if (!isDay(from) || !isDay(to) || from > to || to > today) return refuse(400, "bad_dates");
    const max = q.by === "day" ? keep : GROUPED_DAYS_MAX;
    if (daysIn(from, to) > max) return refuse(400, "range_too_long", rangeTooLong(q.by, max));
    const empty = (note: string) => answer(conn, manifest, stream, q, { from, to, timeZone: zone, finalThrough: c.finalThrough }, null, [], 0, [note]);
    if (from > lastDay) return logged(ctx, conn, q, from, to, zone, now, deps, empty(nothingCollectedNote(from, to, lastDay)));
    if (to < oldest) return logged(ctx, conn, q, from, to, zone, now, deps, empty(startsNote(oldest)));
    const start = laterDay(from, oldest);
    const end = to > lastDay ? lastDay : to;
    if (to > lastDay) notes.push(cappedCollectedNote(manifest.name, lastDay));
    if (to < lastDay) reachesEnd = false;
    if (start > from) notes.push(startsNote(start));
    read = await readDays(ctx, conn, c.gen, stream.stream, q.by, start, end, zone, deps);
  }

  // How far the numbers reach: why they stop, and the days that are over but not in yet.
  if (reachesEnd) {
    const why = stoppedWhy(conn, manifest.name);
    const yesterday = addDays(today, -1);
    if (why) notes.push(stoppedNote(read.to, why));
    else if (read.to < yesterday) notes.push(notInYetNote(addDays(read.to, 1), yesterday));
  }
  if (read.missing.length) notes.push(missingNote(read.missing));
  if (read.days > 0 && !read.final) {
    const span = spanOf(read.notFinal) ?? [laterDay(c.finalThrough ? addDays(c.finalThrough, 1) : read.from, read.from), read.to];
    if (span[0] <= span[1]) notes.push(notFinalNote(span[0], span[1]));
  }
  const multi = read.from !== read.to;
  const people = stream.measures.filter((k) => PEOPLE_KEYS.has(k));
  if (multi && people.length) notes.push(peopleNote(people, q.by === "day"));
  for (const n of read.notes) notes.push(NOTE_WORDS[n]);
  // Day docs name the days that counted all traffic; a rolled doc knows only that some did.
  const allTraffic = spanOf(read.allTraffic);
  if (allTraffic) notes.push(olderDaysNote(allTraffic[0], allTraffic[1]));
  else if (read.basis === "all_traffic") notes.push(olderDaysNote(read.from, read.to));
  else if (read.basis === "mixed") notes.push(MIXED_BASIS_NOTE);

  // The rows asked for: one page's, then the latest days or the top rows, at most the limit.
  const page = q.page !== undefined ? cleanPagePath(q.page) : undefined;
  const matching = page !== undefined ? read.rows.filter((r) => r.key === page) : read.rows;
  if (page !== undefined && !matching.length) notes.push(pageNotKeptNote(page, q.by));
  const shown = q.by === "day" ? matching.slice(-q.limit) : matching.slice(0, q.limit);
  if (shown.some((r) => (r.cutDays ?? 0) > 0)) notes.push(CUT_ROWS_NOTE);
  const keyName = rowKeyOf(stream, q.by);
  const peopleEmpty = multi && q.by !== "day";
  const rows = shown.map((r) => shapeRow(r, keyName, stream.measures, peopleEmpty));
  const dropped = (page !== undefined ? 0 : read.dropped) + (matching.length - shown.length);
  // One page's numbers have no site totals beside them: the site's are for every page.
  const totals = page !== undefined ? null : shapeTotals(read.totals, stream.measures, multi);
  const result = answer(conn, manifest, stream, q, { from: read.from, to: read.to, timeZone: read.timeZone ?? zone, finalThrough: c.finalThrough }, totals, rows, dropped, notes);
  return logged(ctx, conn, q, read.from, read.to, read.timeZone ?? zone, now, deps, result);
}

/** The answer's body, its meanings worked out from its own numbers. */
function answer(
  conn: DataConnection,
  manifest: ConnectorManifest,
  stream: ProducedStream & { collect: StreamCollect },
  q: AgentNumbersRequest,
  period: { from: string; to: string; timeZone: string | null; finalThrough: string | null },
  totals: Record<string, number | null> | null,
  rows: Row[],
  rowsDropped: number,
  notes: string[],
): AgentApiResult {
  const p: PeriodAnswer = periodAnswer(period);
  const body: Record<string, unknown> = {
    connection: { id: conn.id, connectorId: manifest.id, connector: manifest.name, label: conn.label },
    stream: stream.stream,
    by: q.by,
    period: p,
    lag: stream.collect.lag,
    lagDays: stream.lagDays,
    totals,
    rows,
    rowsDropped,
    notes: [...new Set(notes)],
  };
  body.meanings = meaningsOf(numberKeys(body));
  return { status: 200, body };
}

/**
 * Log the read on the connection's activity, off its recent list: what was asked and the days
 * read, never a number or a page. Its health and updatedAt stay as they were: nothing was called.
 */
async function logged(
  ctx: TenantContext,
  conn: DataConnection,
  q: AgentNumbersRequest,
  from: string,
  to: string,
  timeZone: string | null,
  now: Date,
  deps: Pick<ServiceDeps, "db">,
  result: AgentApiResult,
): Promise<AgentApiResult> {
  const read: ReadActivityDetail = { stream: q.stream, by: q.by, from, to, timeZone, limit: q.limit, period: q.period ?? null, pageFilter: q.page !== undefined };
  await changeDataConnection(
    ctx,
    conn.id,
    (cur) => ({ patch: { updatedAt: cur.updatedAt }, activity: [{ kind: "read", by: "agent:vizzy", code: "collected", at: now.toISOString(), recent: false, read }] }),
    deps.db,
  );
  return result;
}

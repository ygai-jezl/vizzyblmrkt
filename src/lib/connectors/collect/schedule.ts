import { createHash } from "node:crypto";
import { addDays, daysIn, earlierDay, laterDay, todayIn } from "../period";

/**
 * When each day is collected, and how a connection's cursor moves (Connectors 2, ADR-0012). Pure:
 * no clock, no network, so the providers' timing is tested on its own.
 *
 * - A provider's day stays its own: Search Console's is a Pacific day, Google Analytics' the
 *   property's, Cloudflare's a UTC day.
 * - Days are planned newest first while a connection fills its 90 days, and oldest first after a
 *   gap, so the cursor only ever moves over days that landed: `lastDay` forward, `backfilledTo`
 *   back. A connection out longer than its keep starts again from the newest day.
 * - `finalThrough` moves only over days that are all final with no gap, and days read before they
 *   were final are read again ahead of new days, so a connection back from a pause or a break
 *   finishes its second passes before newer days can move the line past them.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Where a connection is: the newest and oldest days collected, how far they are final, and its zone. */
export interface CollectCursor {
  /** The newest day collected, in the provider's zone. */
  lastDay: string | null;
  /** The newest day collected whose numbers the provider no longer changes. */
  finalThrough: string | null;
  /** The oldest day collected so far: the backfill moves it back. */
  backfilledTo: string | null;
  /** True once its keep window is full, or reaches as far back as the provider allows. */
  filled: boolean;
  /** The provider's zone, when it names one (a Google Analytics property's). */
  timeZone: string | null;
}

export const EMPTY_CURSOR: CollectCursor = { lastDay: null, finalThrough: null, backfilledTo: null, filled: false, timeZone: null };

/** One day to collect, and why: a new one, a second read to make it final, or a backfill. */
export interface PlannedDay {
  day: string;
  kind: "forward" | "reread" | "backfill";
}

/**
 * The days to collect this run, at most `maxDays`:
 * - starting (nothing collected, or out longer than the keep): the newest days, newest first;
 * - else days collected before they were final, up to `rereadThrough`, oldest first; then the new
 *   days after lastDay, oldest first; then, while it isn't filled, the backfill below backfilledTo,
 *   newest first.
 * `reachFrom` is the oldest day the provider can give (a Cloudflare plan's limit).
 */
export function planDays(
  cursor: CollectCursor,
  newest: string,
  opts: { keepDays: number; maxDays: number; rereadThrough?: string | null; reachFrom?: string | null },
): PlannedDay[] {
  const oldest = laterDay(addDays(newest, -(opts.keepDays - 1)), opts.reachFrom ?? "0000-01-01");
  if (oldest > newest) return [];
  const out: PlannedDay[] = [];
  const room = () => out.length < opts.maxDays;
  if (restarts(cursor, newest, opts.keepDays)) {
    for (let d = newest; d >= oldest && room(); d = addDays(d, -1)) out.push({ day: d, kind: "backfill" });
    return out;
  }
  if (opts.rereadThrough) {
    const from = laterDay(cursor.finalThrough ? addDays(cursor.finalThrough, 1) : (cursor.backfilledTo ?? cursor.lastDay!), cursor.backfilledTo ?? cursor.lastDay!);
    const to = earlierDay(opts.rereadThrough, cursor.lastDay!);
    for (let d = from; d <= to && room(); d = addDays(d, 1)) out.push({ day: d, kind: "reread" });
  }
  for (let d = addDays(cursor.lastDay!, 1); d <= newest && room(); d = addDays(d, 1)) out.push({ day: d, kind: "forward" });
  if (!cursor.filled) {
    for (let d = addDays(cursor.backfilledTo ?? cursor.lastDay!, -1); d >= oldest && room(); d = addDays(d, -1)) out.push({ day: d, kind: "backfill" });
  }
  return out;
}

/** True when the cursor has nothing, or its newest day fell out of the keep window: start again. */
export function restarts(cursor: Pick<CollectCursor, "lastDay">, newest: string, keepDays: number): boolean {
  return !cursor.lastDay || cursor.lastDay < addDays(newest, -keepDays) || cursor.lastDay > newest;
}

/**
 * The cursor after a run's days landed. lastDay moves forward and backfilledTo back only over
 * days that landed with no gap. finalThrough moves only over days that are all final: from the day
 * after it (or the oldest day kept, when nothing is final yet), up while each next day landed final
 * this run, so a final day past days still waiting for their second read never moves it over them.
 * `reachFrom` and `keepDays` say when it is filled.
 */
export function advance(
  cursor: CollectCursor,
  landed: ReadonlyArray<{ day: string; final: boolean }>,
  opts: { newest: string | null; keepDays: number; reachFrom?: string | null; timeZone?: string | null },
): CollectCursor {
  const days = new Map(landed.map((l) => [l.day, l.final]));
  const timeZone = opts.timeZone ?? cursor.timeZone;
  if (!days.size) return { ...cursor, timeZone };
  const restart = !cursor.lastDay || (opts.newest !== null && restarts(cursor, opts.newest, opts.keepDays));
  let lastDay: string;
  let backfilledTo: string;
  let finalThrough = restart ? null : cursor.finalThrough;
  if (restart) {
    lastDay = [...days.keys()].sort().at(-1)!;
    backfilledTo = lastDay;
  } else {
    lastDay = cursor.lastDay!;
    backfilledTo = cursor.backfilledTo ?? cursor.lastDay!;
    while (days.has(addDays(lastDay, 1))) lastDay = addDays(lastDay, 1);
  }
  while (days.has(addDays(backfilledTo, -1))) backfilledTo = addDays(backfilledTo, -1);
  const oldest = laterDay(addDays(lastDay, -(opts.keepDays - 1)), opts.reachFrom ?? "0000-01-01");
  // Days older than the keep window have left, so the oldest kept day moves up with lastDay.
  backfilledTo = laterDay(backfilledTo, addDays(lastDay, -(opts.keepDays - 1)));
  // Every day from backfilledTo to finalThrough is final: walk up from there over final days only.
  let next = finalThrough && finalThrough >= backfilledTo ? addDays(finalThrough, 1) : backfilledTo;
  while (next <= lastDay && days.get(next) === true) next = addDays(next, 1);
  finalThrough = next > backfilledTo ? addDays(next, -1) : null;
  return { lastDay, finalThrough, backfilledTo, filled: backfilledTo <= oldest, timeZone };
}

/** How many days are kept now, from backfilledTo to lastDay, at most keepDays. */
export function keptDays(cursor: Pick<CollectCursor, "lastDay" | "backfilledTo">, keepDays: number): number {
  if (!cursor.lastDay || !cursor.backfilledTo) return 0;
  return Math.min(keepDays, daysIn(cursor.backfilledTo, cursor.lastDay));
}

/** The newest day due at `now`: a day D is collected `lagDays` days later, from `hour`:00 in its zone. */
export function newestDue(now: Date, timeZone: string, lagDays: number, hour: number): string {
  return addDays(todayIn(new Date(now.getTime() - hour * HOUR_MS), timeZone), -lagDays);
}

/** The zone's offset from UTC at a moment, in milliseconds (positive east of Greenwich). */
function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

/** The instant a day's `hour`:00 falls in a zone, as epoch milliseconds. */
export function zonedTime(day: string, hour: number, timeZone: string): number {
  const naive = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const first = naive - offsetMs(naive, timeZone);
  return naive - offsetMs(first, timeZone);
}

/** 0 to 59 minutes, from a hash of the connection's id: spreads brands over the hour. */
export function spreadMs(connectionId: string): number {
  return (createHash("sha256").update(connectionId).digest().readUInt32BE(0) % 60) * MINUTE_MS;
}

/** The next `hour`:00 in the zone after now (tomorrow's when today's has passed), plus the spread. */
export function nextAt(now: Date, timeZone: string, hour: number, spread: number): Date {
  const today = todayIn(now, timeZone);
  for (let i = 0; i < 3; i++) {
    const at = zonedTime(addDays(today, i), hour, timeZone) + spread;
    if (at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + 24 * HOUR_MS);
}

/** The next midnight in a zone: when a daily quota or a day's tries start again. */
export function nextMidnight(now: Date, timeZone: string): Date {
  return new Date(zonedTime(addDays(todayIn(now, timeZone), 1), 0, timeZone));
}

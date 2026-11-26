import { addDaysToKey, localDateKey, resolveTimezone, wallTimeToUtc } from "@/lib/lifecycle/sendWindow";
import { SET_BY_MEASURE, type Measure, type MeasureWhich, type ThenMeasure, type WorkCheck, type WorkRead } from "./types";

/**
 * When Work's checks fall due (ADR-0020). Pure: no clock (`now` is passed in) and no network, so
 * the rules are tested across time zones.
 *
 * - Every check a day sets is at 08:00 in the brand's time zone ("tomorrow morning, after tonight's
 *   runs"), or at the time a person picks. An unset or unknown time zone means UTC.
 * - Done, on a measure that looks after N days, sets a measure's check at closedAt's day plus N,
 *   08:00 brand time, asking "did it work?". It replaces any open check. A measure that looks after
 *   N outputs sets none until the loops count outputs; Done is the win never sets one.
 * - Better, Same or Worse on the first measure's check sets the then's check at closedAt's day plus
 *   the then's days (now, when that has passed). On the then's check, or with no then, a read ends
 *   the check.
 * - Too soon to tell sets no then's check: the same measure's check moves 7 days on (or to the day
 *   the person picks), so the read stays possible.
 */

export const CHECK_HOUR = 8;
export const TOO_SOON_DAYS = 7;

/** The zone a brand's checks use: its own, or UTC when unset or unknown. */
export function zoneOf(timeZone: string | null | undefined): string {
  return resolveTimezone(timeZone);
}

/** YYYY-MM-DD of an instant in the zone. */
export function dayIn(at: Date | string, timeZone: string): string {
  return localDateKey(typeof at === "string" ? Date.parse(at) : at.getTime(), timeZone);
}

/** The instant a day's time ("08:00" unless given) falls at in the zone, as toISOString. */
export function morningOf(day: string, timeZone: string, time?: string): string {
  const [h, m] = (time ?? `${String(CHECK_HOUR).padStart(2, "0")}:00`).split(":").map(Number);
  return new Date(wallTimeToUtc(day, h ?? CHECK_HOUR, m ?? 0, timeZone)).toISOString();
}

/** Tomorrow at 08:00 in the zone. */
export function tomorrowMorning(now: Date, timeZone: string): string {
  return morningOf(addDaysToKey(dayIn(now, timeZone), 1), timeZone);
}

/** A measure's check asking about the first measure or its then, at `at`. */
function measureCheck(which: MeasureWhich, at: string, now: Date): WorkCheck {
  return { kind: "date", at, taskId: null, note: "", setBy: SET_BY_MEASURE, setAt: now.toISOString(), which, counted: null };
}

/** The part of a measure a check asks about: the first, or its then; null when there is none to ask about. */
export function partOf(measure: Measure | null, which: MeasureWhich | null): Exclude<Measure, { kind: "done" }> | ThenMeasure | null {
  if (!measure || measure.kind === "done" || which === null) return null;
  if (which === "first") return measure;
  return measure.then ?? null;
}

/**
 * The measure's check Done sets: at closedAt's day plus the first measure's days, 08:00 brand time.
 * Null for no measure, Done is the win, or a look by outputs.
 */
export function checkOnDone(measure: Measure | null, closedAt: string, timeZone: string, now: Date): WorkCheck | null {
  if (!measure || measure.kind === "done" || !("days" in measure.look)) return null;
  return measureCheck("first", morningOf(addDaysToKey(dayIn(closedAt, timeZone), measure.look.days), timeZone), now);
}

/**
 * The measure's check one part sets on a task that is Done already (its measure set or changed
 * after Done): closedAt's day plus the part's days, 08:00 brand time, or now when that has passed.
 * Null for no part, or a part that looks by outputs.
 */
export function checkForDonePart(which: MeasureWhich, part: Exclude<Measure, { kind: "done" }> | ThenMeasure | null, closedAt: string, timeZone: string, now: Date): WorkCheck | null {
  if (!part || !("days" in part.look)) return null;
  const at = morningOf(addDaysToKey(dayIn(closedAt, timeZone), part.look.days), timeZone);
  return measureCheck(which, Date.parse(at) > now.getTime() ? at : now.toISOString(), now);
}

/**
 * The check after a read on a measure's check:
 * - Too soon to tell: the same measure's check 7 days on at 08:00 (or the person's day and time), not
 *   counted yet, so it counts again when it is due;
 * - Better, Same or Worse on the first: the then's check, at closedAt's day plus the then's days
 *   (now when that has passed), or none with no then or a then that looks by outputs;
 * - Better, Same or Worse on the then: none.
 */
export function checkAfterRead(
  check: WorkCheck,
  read: WorkRead,
  ctx: { measure: Measure | null; closedAt: string | null; timeZone: string; now: Date; day?: string; time?: string },
): WorkCheck | null {
  const which = check.which ?? "first";
  if (read === "too_soon") {
    const at = ctx.day ? morningOf(ctx.day, ctx.timeZone, ctx.time) : morningOf(addDaysToKey(dayIn(ctx.now, ctx.timeZone), TOO_SOON_DAYS), ctx.timeZone);
    return measureCheck(which, at, ctx.now);
  }
  if (which === "then") return null;
  const then = ctx.measure && ctx.measure.kind !== "done" ? ctx.measure.then : null;
  if (!then || !("days" in then.look)) return null;
  const from = ctx.closedAt ?? ctx.now.toISOString();
  const at = morningOf(addDaysToKey(dayIn(from, ctx.timeZone), then.look.days), ctx.timeZone);
  return measureCheck("then", Date.parse(at) > ctx.now.getTime() ? at : ctx.now.toISOString(), ctx.now);
}

/**
 * Look again (or Review's Tomorrow): the check moves to the person's day and time, or tomorrow at
 * 08:00. A measure's check keeps asking about its measure; a check waiting for a task becomes a
 * date check, since that task is done.
 */
export function lookAgain(check: WorkCheck, ctx: { by: string; timeZone: string; now: Date; day?: string; time?: string }): WorkCheck {
  const at = ctx.day ? morningOf(ctx.day, ctx.timeZone, ctx.time) : tomorrowMorning(ctx.now, ctx.timeZone);
  if (check.setBy === SET_BY_MEASURE) return { ...check, at, setAt: ctx.now.toISOString(), counted: null };
  return { kind: "date", at, taskId: null, note: check.note, setBy: ctx.by, setAt: ctx.now.toISOString(), which: null, counted: null };
}

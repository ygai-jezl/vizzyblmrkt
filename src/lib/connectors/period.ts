/**
 * The days a live read covers, worked out the way each provider's own report does (Connectors 1
 * follow-ups). Vizzy and people ask for a named period; the connector's hook turns it into days in
 * the provider's time zone, ending on the provider's last complete day, and every answer says
 * which days it read in plain words. Pure: no clock, no network.
 *
 * - A day is YYYY-MM-DD in the stream's time zone (Search Console: Pacific time; Cloudflare: UTC;
 *   Google Analytics: the property's own zone, which Google names in each answer).
 * - "today" in a zone comes from Intl.DateTimeFormat, never from the server's own zone.
 * - Words are built without dashes (house style): "24 Oct to 20 Nov 2026, Pacific time".
 */

export const LIVE_PERIODS = ["yesterday", "last_7_days", "last_28_days", "last_90_days"] as const;
export type LivePeriod = (typeof LIVE_PERIODS)[number];

/** How many days each named period covers. */
export const PERIOD_DAYS: Readonly<Record<LivePeriod, number>> = { yesterday: 1, last_7_days: 7, last_28_days: 28, last_90_days: 90 };

/** What a read asks for: a named period, or explicit inclusive days. */
export interface ReadAsk {
  period?: LivePeriod;
  from?: string;
  to?: string;
}

/** The days a read covered, as a hook reports them. */
export interface ReadPeriod {
  from: string;
  to: string;
  /** An IANA time zone ("America/Los_Angeles", "UTC"), or null when the provider didn't name one. */
  timeZone: string | null;
  /** The last day whose numbers are final, by the provider's usual delay; null when unknown. */
  finalThrough: string | null;
}

/** ReadPeriod with the days in words, as answers carry it. */
export interface PeriodAnswer extends ReadPeriod {
  words: string;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** True for a real calendar day written YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The day n days after (or before, for negative n) a day. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** How many days from `from` to `to`, both included. */
export function daysIn(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** "2026-W47": the ISO week a day falls in (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeekOf(day: string): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The later of two days. */
export const laterDay = (a: string, b: string) => (a > b ? a : b);
/** The earlier of two days. */
export const earlierDay = (a: string, b: string) => (a < b ? a : b);

/** True when Intl knows the zone. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The day it is now in a time zone, YYYY-MM-DD. */
export function todayIn(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const UTC_ZONES: ReadonlySet<string> = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/UCT", "UCT", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu"]);

/** A time zone as people say it: "Pacific time", "UTC", "Central European time". */
export function zoneWords(timeZone: string | null): string {
  if (!timeZone || !isTimeZone(timeZone)) return "the property's time zone";
  if (UTC_ZONES.has(timeZone)) return "UTC";
  if (timeZone === "America/Los_Angeles") return "Pacific time";
  const name =
    new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(Date.UTC(2026, 0, 15)))
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  if (!name || /^GMT/.test(name)) return `${timeZone.replace(/_/g, " ")} time`;
  return name.replace(/ Standard Time$/, " time").replace(/ Time$/, " time");
}

/** "20 Nov", or "20 Nov 2026" with the year. */
export function dayWords(day: string, withYear = false): string {
  const [y, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${withYear ? ` ${y}` : ""}`;
}

/** "24 Oct to 20 Nov 2026", "20 Nov 2026", or "28 Dec 2025 to 3 Jan 2026". */
export function rangeWords(from: string, to: string): string {
  if (from === to) return dayWords(to, true);
  return from.slice(0, 4) === to.slice(0, 4) ? `${dayWords(from)} to ${dayWords(to, true)}` : `${dayWords(from, true)} to ${dayWords(to, true)}`;
}

/** Days for a note, without the year: "21 Nov", "20 and 21 Nov", "18 to 21 Nov", "30 Nov and 1 Dec". */
export function daysWords(from: string, to: string): string {
  if (from >= to) return dayWords(to);
  const joiner = daysIn(from, to) === 2 ? "and" : "to";
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth ? `${Number(from.slice(8))} ${joiner} ${dayWords(to)}` : `${dayWords(from)} ${joiner} ${dayWords(to)}`;
}

/** The days a read covered, in words: "24 Oct to 20 Nov 2026, Pacific time". */
export function periodWords(p: Pick<ReadPeriod, "from" | "to" | "timeZone">): string {
  return `${rangeWords(p.from, p.to)}, ${zoneWords(p.timeZone)}`;
}

/** A read's period with its words. */
export function periodAnswer(p: ReadPeriod): PeriodAnswer {
  return { ...p, words: periodWords(p) };
}

/**
 * The days a hook reads, given the provider's last complete day:
 * - a named period: that many days, ending on the last complete day, as the provider's own report;
 * - explicit days: as asked, with `to` capped at the last complete day (capped), or nothing to
 *   read when every day asked is after it (empty).
 */
export function resolveWindow(ask: ReadAsk, lastComplete: string): { from: string; to: string; capped: boolean; empty: boolean } {
  if (ask.period) {
    const to = lastComplete;
    return { from: addDays(to, -(PERIOD_DAYS[ask.period] - 1)), to, capped: false, empty: false };
  }
  const from = ask.from ?? lastComplete;
  const asked = ask.to ?? lastComplete;
  if (asked <= lastComplete) return { from, to: asked, capped: false, empty: false };
  if (from > lastComplete) return { from, to: asked, capped: true, empty: true };
  return { from, to: lastComplete, capped: true, empty: false };
}

/** Days still being collected, as a dated note: "Cloudflare hasn't finished 23 Nov yet, so there is nothing to read for it." */
export function nothingYetNote(provider: string, from: string, to: string, lastComplete: string): string {
  return `${provider} hasn't finished ${daysWords(from, to)} yet, so there is nothing to read for ${from === to ? "it" : "those days"}. Its last complete day is ${dayWords(lastComplete)}.`;
}

/** A capped read, as a dated note: "The last complete day in Cloudflare is 22 Nov, so this read ends there." */
export function cappedNote(provider: string, lastComplete: string): string {
  return `The last complete day in ${provider} is ${dayWords(lastComplete)}, so this read ends there.`;
}

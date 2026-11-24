import { localDateKey, offsetMs } from "@/lib/lifecycle/sendWindow";
import type { BlogArticleDates } from "@/lib/types/contentPlan";

/**
 * A blog article's true dates (BLOG_DATES_ENABLED), as Google's byline guidance asks: Published is
 * when the page went up, Updated moves only for a real change, the visible and structured dates
 * match, the markup carries a time and the zone's offset, and nothing is dated in the future.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A stored date that is a day, not an instant. */
export const isDayOnly = (at: string): boolean => DAY.test(at);

/**
 * A date as stored: a day stays a day, anything else becomes an ISO instant. Null when it can't be
 * read, or is in the future (a day's grace, for zones ahead of UTC).
 */
export function normaliseDate(raw: string | null | undefined, now: Date): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const ms = DAY.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  if (Number.isNaN(ms) || ms > now.getTime() + DAY_MS) return null;
  return DAY.test(v) ? v : new Date(ms).toISOString();
}

/** The day of a stored date in the zone, "2026-04-28". */
export function zonedDay(at: string, tz: string): string {
  return isDayOnly(at) ? at : localDateKey(Date.parse(at), tz);
}

/** A stored date for markup: a day stays a day; an instant gets its time and the zone's offset. */
export function zonedIso(at: string, tz: string): string {
  if (isDayOnly(at)) return at;
  const ms = Math.floor(Date.parse(at) / 1000) * 1000;
  const off = offsetMs(tz, ms);
  const local = new Date(ms + off).toISOString().slice(0, 19);
  const mins = Math.round(off / 60_000);
  const abs = Math.abs(mins);
  return `${local}${mins < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "28 Apr 2026", for a date line. */
export function readableDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The UTC day a stored date falls on, for comparing two dates. */
const utcDay = (at: string): string => (isDayOnly(at) ? at : new Date(Date.parse(at)).toISOString().slice(0, 10));

export interface DateInputs {
  /** The dates the live page carries, as read (unnormalised), when it was read. */
  page?: { published: string | null; modified: string | null } | null;
  /** When Found live (or the check) first saw the article at its address. */
  liveAt?: string | null;
  /** The day a person says it went up ("It's live"). */
  personDay?: string | null;
  now: Date;
}

/**
 * The article's dates after a live check, Found live or a person's word. Published: the page's own
 * date when it has one (what readers see), else a person's word, else what was stored, else when
 * it was first seen live. Updated: the page's own dateModified, kept only when it is a later day
 * than Published.
 */
export function nextDates(stored: BlogArticleDates | undefined, input: DateInputs): BlogArticleDates {
  const { now } = input;
  const pagePublished = normaliseDate(input.page?.published, now);
  const pageModified = normaliseDate(input.page?.modified, now);
  const person = input.personDay && DAY.test(input.personDay) ? normaliseDate(input.personDay, now) : null;
  const found = normaliseDate(input.liveAt, now);

  const published: BlogArticleDates["published"] = pagePublished
    ? { at: pagePublished, source: "page" }
    : person
      ? { at: person, source: "person" }
      : (stored?.published ?? (found ? { at: found, source: "found" } : undefined));
  let updated: BlogArticleDates["updated"] = pageModified ? { at: pageModified, source: "page" } : stored?.updated;
  if (updated && (!published || utcDay(updated.at) <= utcDay(published.at))) updated = undefined;

  const page = input.page ? { published: input.page.published?.slice(0, 40) ?? null, modified: input.page.modified?.slice(0, 40) ?? null, readAt: now.toISOString() } : stored?.page;
  return { ...(published ? { published } : {}), ...(updated ? { updated } : {}), ...(page ? { page } : {}) };
}

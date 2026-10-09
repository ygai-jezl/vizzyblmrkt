/**
 * Dates as the person view shows them. Client-side only: they read the viewer's
 * own clock and time zone (or the person's, where it says "their time").
 */

const DAY_MS = 86_400_000;

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function format(d: Date, opts: Intl.DateTimeFormatOptions, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    // A time zone the browser doesn't know: the viewer's own.
    return new Intl.DateTimeFormat("en-GB", opts).format(d);
  }
}

/** "Mon 12 Oct", with the year when it isn't this one. */
export function day(iso: string | null | undefined, timeZone?: string | null): string {
  const d = valid(iso);
  if (!d) return "—";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return format(d, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }, timeZone).replace(",", "");
}

/** "09:40" */
export function time(iso: string | null | undefined, timeZone?: string | null): string {
  const d = valid(iso);
  return d ? format(d, { hour: "2-digit", minute: "2-digit", hour12: false }, timeZone) : "—";
}

/** "Mon 12 Oct, 09:40" */
export function dayTime(iso: string | null | undefined, timeZone?: string | null): string {
  return valid(iso) ? `${day(iso, timeZone)}, ${time(iso, timeZone)}` : "—";
}

/** "today", "yesterday", "3 days ago", "in 2 days" — whole days, by the viewer's calendar. */
export function ago(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = valid(iso);
  if (!d) return "—";
  const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(nowMs) - midnight(d.getTime())) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  return days > 0 ? `${days} days ago` : `in ${-days} days`;
}

/** The clock on the person's wall right now: "09:12", or null when we don't know their time zone. */
export function wallClock(timeZone: string | null | undefined, nowMs = Date.now()): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(nowMs);
  } catch {
    return null;
  }
}

/** A link as a row can show it: "app.example.com/reports", without the scheme or the tracking tail. */
export function shortUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

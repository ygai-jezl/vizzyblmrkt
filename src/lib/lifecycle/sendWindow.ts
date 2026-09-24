import { fnv1a } from "@/lib/journey/allocation";
import type { SendPolicy, WaitConfig } from "@/lib/types/lifecycle";

/**
 * Send-window maths for lifecycle emails — PURE and DST-safe (Intl only).
 *
 * Each recipient gets a stable personal send minute inside the policy's window
 * (e.g. 09:00–10:30 local on weekdays): start + fnv1a(seed) % windowMinutes. An
 * email is sendable from that minute for WINDOW_GRACE_MS (one runner tick of
 * slack plus margin). Nothing is ever sent late: a missed window (an outage, a
 * paused journey) rolls to the recipient's next window.
 *
 * An `anytime` policy (waitlist journeys, like the original engine) has no
 * window: every moment is sendable.
 */

export const WINDOW_GRACE_MS = 30 * 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The first valid IANA zone among the candidates, else UTC. */
export function resolveTimezone(...candidates: Array<string | null | undefined>): string {
  return candidates.find(isValidTimezone) ?? "UTC";
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(utcMs: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Local wall clock minus UTC, in ms, at the given instant. */
function offsetMs(tz: string, utcMs: number): number {
  const p = localParts(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** YYYY-MM-DD of the instant in the zone. */
export function localDateKey(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function keyParts(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = keyParts(key);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a local date key. */
export function weekdayOfKey(key: string): number {
  const [y, m, d] = keyParts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The UTC instant of local wall time `hour:minute` on `dateKey` in `tz`. Minutes
 * may exceed 59 (they carry into the hour). Two-pass so it lands correctly on
 * DST-change days; a wall time inside a spring-forward gap resolves to the
 * shifted instant, which is harmless for a morning window.
 */
export function wallTimeToUtc(dateKey: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = keyParts(dateKey);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, first);
}

/** The recipient's stable minute offset inside the window. */
export function personalOffsetMinutes(seed: string, policy: SendPolicy): number {
  return fnv1a(seed) % policy.windowMinutes;
}

function slotOn(key: string, tz: string, policy: SendPolicy, offsetMin: number): number {
  return wallTimeToUtc(key, policy.startHour, policy.startMinute + offsetMin, tz);
}

/** Whether `nowMs` is inside the recipient's send slot today. */
export function isInSendWindow(nowMs: number, tz: string, policy: SendPolicy, offsetMin: number): boolean {
  if (policy.anytime) return true;
  const key = localDateKey(nowMs, tz);
  if (!policy.days.includes(weekdayOfKey(key))) return false;
  const slot = slotOn(key, tz, policy, offsetMin);
  return nowMs >= slot && nowMs < slot + WINDOW_GRACE_MS;
}

/**
 * The recipient's next send slot at or after `fromMs`. With `afterLocalDateOfMs`,
 * the slot must also fall on a LATER local date than that instant (so the next
 * email lands on a new local day).
 */
export function nextWindowAt(
  fromMs: number,
  tz: string,
  policy: SendPolicy,
  offsetMin: number,
  opts: { afterLocalDateOfMs?: number } = {},
): number {
  const startKey = localDateKey(fromMs, tz);
  const blocked = opts.afterLocalDateOfMs != null ? localDateKey(opts.afterLocalDateOfMs, tz) : null;
  if (policy.anytime) {
    // No window: now, or local midnight starting the first day after the blocked one.
    if (!blocked || startKey > blocked) return fromMs;
    return Math.max(fromMs, wallTimeToUtc(addDaysToKey(blocked, 1), 0, 0, tz));
  }
  for (let i = 0; i <= 15; i += 1) {
    const key = addDaysToKey(startKey, i);
    if (blocked && key <= blocked) continue;
    if (!policy.days.includes(weekdayOfKey(key))) continue;
    const slot = slotOn(key, tz, policy, offsetMin);
    if (slot >= fromMs) return slot;
  }
  return fromMs + DAY_MS; // unreachable while at least one weekday is allowed
}

/**
 * When the step after a wait node may run. The earliest moment is the latest of:
 * the previous email + minHours (or, with `after: "previous_step"`, reaching the
 * wait + minHours), enrolment + sinceEnrolHours, and now. Within the wait's
 * windowExemptHours of enrolment it runs at that moment (the welcome); otherwise
 * at the recipient's next send slot (on a later local day, if asked).
 */
export function scheduleAfterWait(a: {
  wait: WaitConfig;
  anchorMs: number;
  lastSentMs: number | null;
  nowMs: number;
  tz: string;
  policy: SendPolicy;
  offsetMin: number;
}): { runAtMs: number; windowExemptUntilMs: number | null } {
  const base = a.wait.after === "previous_step" ? a.nowMs : (a.lastSentMs ?? a.anchorMs);
  const notBefore = Math.max(
    base + a.wait.minHours * HOUR_MS,
    a.anchorMs + (a.wait.sinceEnrolHours ?? 0) * HOUR_MS,
    a.nowMs,
  );
  if (a.wait.windowExemptHours != null) {
    const exemptUntil = a.anchorMs + a.wait.windowExemptHours * HOUR_MS;
    if (notBefore <= exemptUntil) return { runAtMs: notBefore, windowExemptUntilMs: exemptUntil };
  }
  const runAtMs = nextWindowAt(
    notBefore,
    a.tz,
    a.policy,
    a.offsetMin,
    a.wait.differentLocalDay ? { afterLocalDateOfMs: base } : {},
  );
  return { runAtMs, windowExemptUntilMs: null };
}

import { addDaysToKey } from "@/lib/lifecycle/sendWindow";
import type { StageRole } from "./presets";

/**
 * YouGrow's follow-up rule for the investor and funding board (RULE_DECISIONS.investor_quiet in
 * src/lib/loops/registry.ts): who on the board is due a follow-up today. Pure.
 *
 * - Quiet: in a stage in play, with a Last touch 14 or more days ago. No Last touch is not quiet:
 *   the board can't tell a quiet spell from a date nobody filled in.
 * - Next step past: not yet in Money in, Funds in or Passed, with a Next step date before today.
 *
 * `today` is the brand's own calendar day (localDateKey in its time zone, zoneOf), the same days
 * views count "over N days ago" in. Dates are calendar days (YYYY-MM-DD) with no time.
 */

/** The days without a touch before a follow-up: YouGrow's rule, the same for every brand for now. */
export const QUIET_AFTER_DAYS = 14;

export type DueReason = "quiet" | "next_step";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v);

/** Whole days from one calendar day to another: 1 from today to tomorrow. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/** Days since the Last touch, or null with none. */
export function quietDays(lastTouch: unknown, today: string): number | null {
  return isDay(lastTouch) ? Math.max(0, daysBetween(lastTouch, today)) : null;
}

/** Quiet for 14 days: in play, with a Last touch on or before 14 days ago. */
export function isQuiet(role: StageRole, lastTouch: unknown, today: string): boolean {
  return role === "active" && isDay(lastTouch) && lastTouch <= addDaysToKey(today, -QUIET_AFTER_DAYS);
}

/** Past the next step: not started or in play, with a Next step date before today. */
export function isNextStepPast(role: StageRole, nextStepDate: unknown, today: string): boolean {
  return (role === "open" || role === "active") && isDay(nextStepDate) && nextStepDate < today;
}

/** Why someone is due a follow-up today, quiet first. */
export function dueReasons(card: { lastTouch: unknown; nextStepDate: unknown }, role: StageRole, today: string): DueReason[] {
  const out: DueReason[] = [];
  if (isQuiet(role, card.lastTouch, today)) out.push("quiet");
  if (isNextStepPast(role, card.nextStepDate, today)) out.push("next_step");
  return out;
}

/** The board's header counts: quiet, past their next step, and overdue counting each person once. */
export function dueTallies(cards: Iterable<{ due: readonly DueReason[] }>): { quiet: number; nextStepPast: number; overdue: number } {
  const out = { quiet: 0, nextStepPast: 0, overdue: 0 };
  for (const c of cards) {
    if (c.due.includes("quiet")) out.quiet += 1;
    if (c.due.includes("next_step")) out.nextStepPast += 1;
    if (c.due.length) out.overdue += 1;
  }
  return out;
}

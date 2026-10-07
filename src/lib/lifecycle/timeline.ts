import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { ContentPool, LifecycleGraph, LifecycleSettings } from "@/lib/types/lifecycle";
import { planTimeline, type PlannedStep } from "./planner";
import { addDaysToKey, localDateKey, resolveTimezone, wallTimeToUtc } from "./sendWindow";

/**
 * A journey's TIMELINE in a few numbers: how many emails one person gets, on
 * which days, and how long it runs — what the new-journey form, the editor and
 * Vizzy read before building a journey that continues from it.
 *
 * It's the runner's own walk (planTimeline), run for someone who starts at
 * 10:00 on each day of a week, once never finishing onboarding and once with it
 * already done. Days are calendar days in the person's timezone, day 1 being
 * the day they start — so a "7-day" sequence that only sends on weekdays reads
 * as the 7–10 days it really takes.
 */

const DAY_MS = 86_400_000;
/** A Monday. Any week does: only the weekday someone starts on changes the answer. */
const REFERENCE_MONDAY = "2026-01-05";
const START_HOUR = 10;

export interface JourneyTimeline {
  /** The most emails one person gets. */
  emails: number;
  /** Days from the start to the last email: a typical start, and the range over the weekdays someone could start on. */
  days: { typical: number; min: number; max: number };
  /** A typical person's emails (starting on a Monday, onboarding not finished): the day each goes out. */
  steps: Array<{ day: number; label: string }>;
  /** Local weekdays emails go out (0 = Sunday), and when the window opens; null = any time. */
  sendDays: number[] | null;
  sendTime: string | null;
}

type Design = { graph: LifecycleGraph; pools: ContentPool[]; settings: Pick<LifecycleSettings, "sendPolicy"> };

/** The calendar day of `atMs` counted from the day of `anchorMs` (day 1), in `tz`. */
export function dayNumber(anchorMs: number, atMs: number, tz: string): number {
  const from = Date.parse(`${localDateKey(anchorMs, tz)}T00:00:00Z`);
  const to = Date.parse(`${localDateKey(atMs, tz)}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS) + 1;
}

/** When a planned walk reaches the end of the journey; null when it stops early (it wouldn't hand anyone on). */
export function completionMs(steps: PlannedStep[]): number | null {
  const last = steps.at(-1);
  return last?.kind === "complete" ? last.atMs : null;
}

export function journeyTimeline(design: Design, catalog: ConnectionCatalog, opts: { timezone?: string | null } = {}): JourneyTimeline {
  const policy = design.settings.sendPolicy;
  const tz = resolveTimezone(opts.timezone, policy.fallbackTimezone);
  const allDone = (anchorMs: number) => Object.fromEntries(catalog.onboardingSteps.map((s) => [s.id, anchorMs]));
  const run = (weekday: number, done: boolean) => {
    const anchorMs = wallTimeToUtc(addDaysToKey(REFERENCE_MONDAY, weekday), START_HOUR, 0, tz);
    const sends = planTimeline({ graph: design.graph, pools: design.pools, policy }, catalog, {
      anchorMs,
      tz,
      offsetMin: 0,
      ...(done ? { stepsDoneAt: allDone(anchorMs) } : {}),
    }).filter((s) => s.kind === "send");
    return sends.map((s) => ({ day: dayNumber(anchorMs, s.atMs, tz), label: s.label }));
  };
  const lastDay = (steps: Array<{ day: number }>) => steps.at(-1)?.day ?? 0;

  const notDone = Array.from({ length: 7 }, (_, weekday) => run(weekday, false));
  const done = catalog.onboardingSteps.length > 0 ? Array.from({ length: 7 }, (_, weekday) => run(weekday, true)) : [];
  const all = [...notDone, ...done];
  const spans = notDone.map(lastDay).sort((a, b) => a - b);
  return {
    emails: Math.max(0, ...all.map((r) => r.length)),
    days: {
      typical: spans[Math.floor((spans.length - 1) / 2)] ?? 0,
      min: Math.min(...all.map(lastDay)),
      max: Math.max(...all.map(lastDay)),
    },
    steps: notDone[0]!,
    sendDays: policy.anytime ? null : [...policy.days].sort(),
    sendTime: policy.anytime ? null : `${String(policy.startHour).padStart(2, "0")}:${String(policy.startMinute).padStart(2, "0")}`,
  };
}

/** "5 emails over about 8 days (7–10, depending on the day they start)". */
export function timelineText(t: JourneyTimeline): string {
  if (t.emails === 0) return "no emails yet";
  const emails = `${t.emails} email${t.emails === 1 ? "" : "s"}`;
  if (t.days.typical <= 1 && t.days.max <= 1) return `${emails}, on the day they start`;
  const range = t.days.min === t.days.max ? "" : ` (${t.days.min}–${t.days.max}, depending on the day they start)`;
  return `${emails} over about ${t.days.typical} days${range}`;
}

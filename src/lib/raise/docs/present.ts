import { clock } from "./text";
import { PRESENT_WORDS } from "./words";

/**
 * Present: moving through the slides, the keys and the rehearsal timer. Each slide's target is how
 * long its speaker notes take to say at about 150 words a minute (our estimate), with a short floor
 * so a slide without notes still gets a moment. Pure and client safe.
 */

export type PresentAction = "next" | "back" | "notes" | "timer" | "leave" | "first" | "last";

/** Right arrow, Space or Page Down next; left arrow or Page Up back; N notes; T restart the timer; Escape leaves. */
export function presentAction(key: string): PresentAction | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "Spacebar":
    case "PageDown":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return "back";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "n":
    case "N":
      return "notes";
    case "t":
    case "T":
      return "timer";
    case "Escape":
      return "leave";
    default:
      return null;
  }
}

/** The slide after a move, kept inside the deck. */
export function stepTo(index: number, total: number, action: "next" | "back" | "first" | "last"): number {
  if (total <= 0) return 0;
  if (action === "first") return 0;
  if (action === "last") return total - 1;
  const next = index + (action === "next" ? 1 : -1);
  return Math.max(0, Math.min(total - 1, next));
}

/** A slide gets at least this long, in seconds, even without notes. */
export const MIN_SLIDE_SECONDS = 15;

/** Each slide's target, in seconds, from how long its notes take to say. */
export function slideTargets(perSlide: readonly number[]): number[] {
  return perSlide.map((s) => Math.max(MIN_SLIDE_SECONDS, Math.round(s)));
}

/** The whole deck's target: every slide's added up. */
export const deckTarget = (targets: readonly number[]) => targets.reduce((n, s) => n + s, 0);

/** Over the slide's target: the timer turns amber. */
export const isOver = (elapsed: number, target: number) => target > 0 && elapsed > target;

/** "This slide 0:42 of about 0:30" and "Total 3:10 of about 4:00". */
export function timerLines(t: { slideElapsed: number; slideTarget: number; totalElapsed: number; totalTarget: number }): { slide: string; total: string; over: boolean } {
  return {
    slide: PRESENT_WORDS.slideTime(clock(t.slideElapsed), clock(t.slideTarget)),
    total: PRESENT_WORDS.totalTime(clock(t.totalElapsed), clock(t.totalTarget)),
    over: isOver(t.slideElapsed, t.slideTarget),
  };
}

/** How long the key hint shows when Present opens, in milliseconds. */
export const HINT_MS = 3000;

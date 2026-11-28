import { MEANINGS } from "@/lib/metrics/meanings";
import type { LookRead } from "@/lib/types/loopDay";
import { BY_LEARNER } from "./registry";
import { compare, LOOK_SIZES, nextLook, type Tally, type Verdict } from "./verdict";

/**
 * A look's check in words (learning loops step 4, 3.8 of the plan for steps 4 and 5): what the
 * What it learned card, its History, the Go back card and Vizzy say about a learned image look,
 * from a read the verdict run kept (LookRead). Pure and client safe; the help page's examples are
 * made from verdict() in verdictWords.test.ts, and checked against the writing rules there.
 *
 * - better: "Liked more often: 34 of 40 against 14 of 40 before."
 * - same: "About the same: liked 60 of 120 against 60 of 120 before."
 * - worse on the check, or on the guard (remakes), with the date the look began and, on the row,
 *   "Go back to the earlier look?"
 * - too few, at a look with a next one: what it would have taken, and when the next check is;
 *   at the last look this change can get; or where the windows stop;
 * - below the first look: "Too few to check yet: 4 of the 10 votes it needs.";
 * - can't be checked, when fewer than a first look's votes came before the change: on a style's
 *   first look this line sits in History and in Vizzy's answer, not on the row (departure 8).
 *
 * History says, for each replaced version, the read that let it change.
 */

/** Votes a side at the first look. */
const FIRST_LOOK = LOOK_SIZES[0]!;
/** The last look any change gets. */
const LAST_LOOK = LOOK_SIZES[LOOK_SIZES.length - 1]!;

/** The question a worse read asks on the row and the card. */
export const GO_BACK_ASK = "Go back to the earlier look?";
/** Said once, in the card's footer, whenever a check line shows. */
export const NOT_ADJUSTED_FOR_SEASON = "Not adjusted for season.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "9 Mar", in UTC, or null for a time that can't be read. */
export function shortDay(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const votes = (n: number) => `${n} ${n === 1 ? "vote" : "votes"}`;
const of = (t: Tally) => `${t.hits} of ${t.n}`;

/**
 * The likes since the change, at this look, that would have read better against this before
 * window; null when none could. compare() is the verdict's own test, so the words never promise
 * what the check would not say.
 */
export function likesNeeded(before: Tally, band: number = BY_LEARNER.votes.band): number | null {
  for (let hits = 0; hits <= before.n; hits++) {
    if (compare(before, { hits, n: before.n }, MEANINGS.likedShare.better!, band).call === "better") return hits;
  }
  return null;
}

/**
 * A verdict as the verdict run keeps it: its call and counts, the check's votes before and since
 * that count, its next look, and for a too few look the likes it would have taken.
 */
export function lookReadOf(v: Verdict, extra: { usableBefore: number; after: number; at: string }): LookRead {
  const look = v.check.look;
  const next = look === null ? (extra.usableBefore >= FIRST_LOOK ? FIRST_LOOK : null) : nextLook(look);
  const reachable = next !== null && extra.usableBefore >= next ? next : null;
  const counts = v.check.counts;
  return {
    call: v.call,
    decidedBy: v.decidedBy,
    look: v.look,
    check: counts ? { before: { ...counts.before }, after: { ...counts.after } } : null,
    guard: v.guard.counts ? { before: { ...v.guard.counts.before }, after: { ...v.guard.counts.after } } : null,
    usableBefore: extra.usableBefore,
    after: extra.after,
    next: reachable,
    need: v.call === "too_few" && counts ? likesNeeded(counts.before, v.band) : null,
    at: extra.at,
  };
}

/** Whether the read can never be checked: fewer than a first look's votes came before the change. */
export const cantCheck = (r: LookRead): boolean => r.call === "too_few" && r.usableBefore < FIRST_LOOK;

export interface VerdictWordsOptions {
  /** Where the words go: the row (and the card), or a replaced version's line in History. */
  form?: "row" | "history";
  /** When the look began, for "since 9 Mar". */
  since?: string | null;
  /** A style's first look: its can't check line says so. */
  first?: boolean;
  /** Ask "Go back to the earlier look?" after a worse read (the row and the card). */
  ask?: boolean;
}

/** One read in words. */
export function verdictWords(r: LookRead, opts: VerdictWordsOptions = {}): string {
  const form = opts.form ?? "row";
  const day = shortDay(opts.since);
  const since = day ? ` since ${day}` : "";
  const ask = opts.ask ? ` ${GO_BACK_ASK}` : "";

  if (r.call === "worse" && r.decidedBy === "guard" && r.guard) {
    return `Your images were remade more${since}: ${of(r.guard.after)} against ${of(r.guard.before)} before.${ask}`;
  }
  if (r.call === "worse" && r.check) return `Liked less often${since}: ${of(r.check.after)} against ${of(r.check.before)} before.${ask}`;
  if (r.call === "better" && r.check) return `Liked more often: ${of(r.check.after)} against ${of(r.check.before)} before.`;
  if (r.call === "same" && r.check) return `About the same: liked ${of(r.check.after)} against ${of(r.check.before)} before.`;

  // Too few to tell.
  if (cantCheck(r)) {
    const came = r.usableBefore === 0 ? "nothing came before it" : `only ${votes(r.usableBefore)} came before it`;
    if (form === "history") return `Can't be checked: ${came}.`;
    return `${opts.first ? "This first look" : "This look"} can't be checked: ${came}.`;
  }
  if (!r.check || r.look === null) {
    if (form === "history") return `Too few to tell: only ${votes(r.after)} of its own counted.`;
    return `Too few to check yet: ${r.after} of the ${votes(FIRST_LOOK)} it needs.`;
  }
  const { before, after } = r.check;
  if (form === "history") return `Too few to tell at ${votes(r.look)}: liked ${of(after)} against ${of(before)} before.`;
  if (r.next !== null) {
    const showing =
      r.need !== null ? `it would take about ${r.need} of ${before.n} to show` : `no change could show at ${votes(r.look)}`;
    return `Too few to tell yet. With ${of(before)} liked before, ${showing}. Next check at ${votes(r.next)}.`;
  }
  if (r.look >= LAST_LOOK) return `Too few to tell at ${votes(r.look)}, the last check any look gets.`;
  return `Too few to tell, and this is the last check this look can get: only ${votes(r.usableBefore)} came before it.`;
}

/** The newest read kept for a version: the one at its largest look. */
export function newestRead(looks: Record<string, LookRead> | undefined): LookRead | null {
  let best: { look: number; read: LookRead } | null = null;
  for (const [key, read] of Object.entries(looks ?? {})) {
    const look = Number(key);
    if (Number.isFinite(look) && (!best || look > best.look || (look === best.look && read.at > best.read.at))) best = { look, read };
  }
  return best?.read ?? null;
}

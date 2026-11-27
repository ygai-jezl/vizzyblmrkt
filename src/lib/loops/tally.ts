import { isImageKind } from "./imageKinds";

/**
 * A brand's counts read back by kind (learning loops step 5, 4.4 of the plan for steps 4 and 5):
 * what was made, what people did with it, the saves with no stamp, how much of it is stamped
 * (coverage) and how much went unused. Read from the counter trees count.ts writes (a week's
 * shards added up, a folded `lt:` week, or a version's `lv:` totals), never from records, so the
 * lane and the Loops section add no reads. Counts only: no words and no people. Pure.
 */

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** What a person did that answers a made thing: they kept it, edited it or declined it. */
export const ANSWERS = ["kept", "edited", "declined"] as const;
export type Answer = (typeof ANSWERS)[number];

/** One kind's counts. */
export interface KindTally {
  made: number;
  kept: number;
  edited: number;
  declined: number;
  /** Saves with no stamp, by any reason but a lost stamp. */
  unstamped: number;
  /** Records lost after their output was used (`stamp_lost`). */
  lost: number;
}

const empty = (): KindTally => ({ made: 0, kept: 0, edited: 0, declined: 0, unstamped: 0, lost: 0 });

/** Add a signal's leaves into a kind's tally: `<arm>.<signal>` maps, one per version. */
function addArms(into: KindTally, byV: unknown): void {
  if (!isObj(byV)) return;
  for (const byArm of Object.values(byV)) {
    if (!isObj(byArm)) continue;
    for (const signals of Object.values(byArm)) {
      if (!isObj(signals)) continue;
      into.made += num(signals.made);
      for (const a of ANSWERS) into[a] += num(signals[a]);
    }
  }
}

/**
 * A counter tree's counts by kind: `c.<scope>.<kind>.v<v>.<arm>.<signal>` summed over scopes,
 * versions and arms, and `u.<kind>.<reason>` split into unstamped and lost.
 */
export function tallyByKind(d: unknown): Map<string, KindTally> {
  const out = new Map<string, KindTally>();
  const of = (kind: string) => out.get(kind) ?? out.set(kind, empty()).get(kind)!;
  const tree = isObj(d) ? d : {};
  if (isObj(tree.c)) {
    for (const byKind of Object.values(tree.c)) {
      if (!isObj(byKind)) continue;
      for (const [kind, byV] of Object.entries(byKind)) addArms(of(kind), byV);
    }
  }
  if (isObj(tree.u)) {
    for (const [kind, reasons] of Object.entries(tree.u)) {
      if (!isObj(reasons)) continue;
      const t = of(kind);
      for (const [reason, n] of Object.entries(reasons)) {
        if (reason === "stamp_lost") t.lost += num(n);
        else t.unstamped += num(n);
      }
    }
  }
  return out;
}

/** How much of what a kind saved carries a stamp. */
export interface Coverage {
  stamped: number;
  unstamped: number;
  lost: number;
  /** Stamped over stamped, unstamped and lost; null when nothing was saved. */
  share: number | null;
}

/** Coverage per kind (4.4): stamped saves, divided by stamped plus unstamped plus lost. */
export function coverageByKind(d: unknown): Map<string, Coverage> {
  const out = new Map<string, Coverage>();
  for (const [kind, t] of tallyByKind(d)) {
    const all = t.made + t.unstamped + t.lost;
    out.set(kind, { stamped: t.made, unstamped: t.unstamped, lost: t.lost, share: all > 0 ? t.made / all : null });
  }
  return out;
}

/** How many weeks after the week a thing was made its answers still count: made in W, answered through W+2. */
export const ANSWER_WEEKS = 2;

/**
 * Things of each kind made in one week that nobody kept, edited or declined (4.4), for every kind
 * but the image kinds and their learner (whose versions say it, unusedOfVersion): made in week W, less the answers
 * counted in W and the ANSWER_WEEKS weeks after it, never below 0. `weeks` is W first, then the
 * weeks after it in order; answers past W+2 are left out, so pass them only once W+2 has closed for
 * the number to be final. An answer in a later week may be for a thing made later, so it can read
 * a little low, never high.
 */
export function unusedForWeek(weeks: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!weeks.length) return out;
  const made = tallyByKind(weeks[0]);
  const answered = new Map<string, number>();
  for (const w of weeks.slice(0, ANSWER_WEEKS + 1)) {
    for (const [kind, t] of tallyByKind(w)) answered.set(kind, (answered.get(kind) ?? 0) + t.kept + t.edited + t.declined);
  }
  for (const [kind, t] of made) {
    if (isImageKind(kind) || kind === "loop_learn" || t.made <= 0) continue;
    out.set(kind, Math.max(0, t.made - (answered.get(kind) ?? 0)));
  }
  return out;
}

/**
 * A learned version's unused things by kind and arm, from its `lv:` totals
 * (`c.<kind>.<arm>.<signal>`): made, less kept, edited and declined, never below 0. A version's
 * totals cover every week it was in use, so its answers are its own.
 */
export function unusedOfVersion(c: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!isObj(c)) return out;
  for (const [kind, byArm] of Object.entries(c)) {
    if (!isObj(byArm)) continue;
    for (const [arm, signals] of Object.entries(byArm)) {
      if (!isObj(signals)) continue;
      const made = num(signals.made);
      if (made <= 0) continue;
      const answered = ANSWERS.reduce((sum, a) => sum + num(signals[a]), 0);
      (out[kind] ??= {})[arm] = Math.max(0, made - answered);
    }
  }
  return out;
}

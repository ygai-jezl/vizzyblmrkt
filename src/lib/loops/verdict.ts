import { MEANINGS, type Meaning, type MeaningKey } from "@/lib/metrics/meanings";
import { LOOP_RULES, type Loop } from "./registry";

/**
 * The verdict (ADR-0027, learning loops step 3): the one check every loop will run on a change it
 * made. It compares the outputs just after a change with the outputs just before it and answers
 * better, same, worse or too few to tell, with the smallest change it could have seen.
 *
 * - Units are outputs (a post, email, image or draft), never views: 3 posts seen 10,000 times are 3.
 * - Every level is blended toward a prior with the weight of LOOP_RULES.blendM outputs.
 * - It reads only at the looks (10, 20 and 40 outputs a side, then every 40 up to 120), never daily.
 * - The range for the change is Newcombe's hybrid score interval (built from Wilson's), read
 *   against the loop's band with three zones, and LOOP_RULES.verdictZ is set by simulation so a
 *   change that did nothing reads better or worse at most LOOP_RULES.falseAlarm of the time,
 *   when each output's outcome stands on its own (see Outputs).
 * - It never undoes anything and is not adjusted for season.
 *
 * Nothing calls it yet: the check exists before anything learns. Every number comes from
 * LOOP_RULES or the loop line. Pure and client safe: the meanings and the registry import types only.
 */

/** A count of outputs and how many of them count toward a meaning, such as 3 of 12 drafts edited. */
export interface Tally {
  hits: number;
  n: number;
}

/** What a verdict says about a change. */
export type Call = "better" | "same" | "worse" | "too_few";

/** Which way a meaning is better. */
export type Better = NonNullable<Meaning["better"]>;

/**
 * One number's outputs either side of a change, oldest first: true when that output counts toward
 * the meaning (a draft a person edited, for edit share). One entry is one output, never one view.
 *
 * Each entry must be an output whose outcome does not depend on another entry's: the falseAlarm
 * limits assume it. Outputs made together that tend to share an outcome, such as a set remade at
 * once, can break both limits, so the caller stamps such a set as one entry (step 5 decides how).
 *
 * Each list holds only the outputs whose outcome is known, and outcomes become known in the order
 * the outputs were made, as with unused share's fixed 14 days. So once one output after the change
 * is known, every output before it is known too and the before list is complete; until then,
 * outputs from just before the change can still join it.
 */
export interface Outputs {
  /** The outputs made before the change, oldest first. */
  before: readonly boolean[];
  /** The outputs made since the change, oldest first. */
  after: readonly boolean[];
}

export interface VerdictInput {
  /** The loop line's check, guard and band. */
  line: Pick<Loop, "check" | "guard" | "band">;
  /** The check's outputs, each entry one output whose outcome stands on its own (see Outputs). */
  check: Outputs;
  /**
   * The guard's own outputs, which can be fewer or more than the check's: unused share is known
   * only 14 days after each draft, and remade share counts every image while liked share counts
   * only the images someone voted on. Each entry stands on its own, as for the check (see
   * Outputs). Outcomes become known in the order the outputs were made, so while none since the
   * change is known, drafts from the 14 days before it can still join the before list, and the
   * reason line says only that better waits.
   */
  guard: Outputs;
  /** The levels both windows blend toward: the shipped default until a fleet cell publishes. */
  prior: { check: number; guard: number };
  /**
   * How many entries each before list would hold before its first one, counted in that list's own
   * outputs: one number for both lists, or one for each, since liked share holds only the voted
   * images while remade share holds every image. Left out, it is 0: each list starts at its first
   * entry. The warm up drops each list's own first LOOP_RULES.warmUp entries, which for a list of
   * every output is the scope's first 10 and for liked share its first 10 voted images: stricter
   * than the design's scope's first 10 outputs, a departure ADR-0027 records (item 6).
   */
  startsAt?: number | { check: number; guard: number };
}

/**
 * One number read at a look. Levels, change and range are blended and on the meaning's own scale:
 * after minus before, so for a meaning that is better lower, such as edit share, a negative change
 * is better. They are estimates that lean toward the prior while outputs are few, so counts keeps
 * the real ones.
 */
export interface Read {
  meaning: MeaningKey;
  /** Outputs a side this number was read at, or null when it has too few for the first look. */
  look: number | null;
  call: Call;
  /** The real counts the look read, such as 5 of 10 drafts edited before and 2 of 10 since. */
  counts: { before: Tally; after: Tally } | null;
  /**
   * True when the raw range sits wholly on the worse side of no change. On a guard that is too few
   * to read against the band this holds back a better check; a guard that reads same does not.
   * Every reason line the guard does not decide names such a guard, with its counts.
   */
  movedWrongWay: boolean;
  /** The blended level before the change, from 0 to 1. */
  before: number | null;
  /** The blended level since the change. */
  after: number | null;
  /** After minus before, blended: the gap between the two levels a person sees. */
  change: number | null;
  /** Where the blended change could be, low and high: better and worse read this against the band. */
  range: readonly [number, number] | null;
  /** The same range before blending shrinks it: same reads this, so blending never makes same easier. */
  rawRange: readonly [number, number] | null;
}

export interface Verdict {
  call: Call;
  /** Guard when the guard reading worse gave the call, otherwise check. */
  decidedBy: "check" | "guard";
  /**
   * The look the call was read at, in outputs a side: the guard's on a guard worse, otherwise the
   * check's. Null below the check's first look, unless the guard reads worse.
   */
  look: number | null;
  band: number;
  check: Read;
  guard: Read;
  /**
   * The smallest change in the better direction that the check alone could read as better at its
   * look, before the guard has its say, in points between the blended levels (0.36 is 36 estimated
   * points, not raw ones). Null below the first look, or when no change could read better at this
   * look. The reason line says when the guard stands in the way.
   */
  smallestVisible: number | null;
  /** Windows sit either side of the change and are counted in outputs; nothing adjusts them for the time of year. */
  notAdjustedForSeason: true;
  /** One line a person can read. */
  reason: string;
}

/** One number's change at a look: the call, and the change and ranges behind it. */
export interface Comparison {
  call: Call;
  /** After minus before, blended. With equal sides this is exactly the gap between the blended levels. */
  change: number;
  range: readonly [number, number];
  rawRange: readonly [number, number];
  /** The raw range sits wholly on the worse side of no change. */
  movedWrongWay: boolean;
}

/**
 * What a holdback is planned around. The holdback is read only across the fleet, never for one
 * brand: the design has no per brand tests.
 */
export interface HoldbackPlan {
  /**
   * Outputs a month in this scope, pooled across every brand in the copy that has not opted out:
   * every brand feeds the fleet's counts from day one, counts only, and a brand that opts out
   * leaves both arms. Two of the design's rules are not modelled: each organisation counts at most
   * 20 outputs per arm, so a few busy organisations make the answer too hopeful, and a fleet number
   * publishes only for LOOP_RULES.cellOrgs organisations or more, so below that nothing reads
   * whatever the months say. The holdback holds back decisions, and this counts outputs, which is
   * right only when each held back decision makes one output: a decision that makes several
   * outputs makes the answer too hopeful.
   */
  perMonth: number;
  rate: number;
  band: number;
}

/** Outputs a side at which a verdict is read: LOOP_RULES.looks, then every lookEvery up to lastLook. */
export const LOOK_SIZES: readonly number[] = (() => {
  const out: number[] = [...LOOP_RULES.looks];
  for (let n = out[out.length - 1]! + LOOP_RULES.lookEvery; n <= LOOP_RULES.lastLook; n += LOOP_RULES.lookEvery) out.push(n);
  return out.filter((n) => n <= LOOP_RULES.lastLook);
})();

function fail(why: string): never {
  throw new Error(`verdict: ${why}`);
}

function checkTally(t: Tally, what: string): void {
  if (!Number.isInteger(t.n) || t.n < 0) fail(`${what} needs a whole number of outputs, not ${t.n}`);
  if (!Number.isInteger(t.hits) || t.hits < 0 || t.hits > t.n) fail(`${what} needs hits that are a whole number from 0 to ${t.n}, not ${t.hits}`);
}

function checkRate(x: number, what: string): void {
  if (!(x >= 0 && x <= 1)) fail(`${what} must be from 0 to 1, not ${x}`);
}

function checkBand(band: number): void {
  if (!(band > 0 && band < 1)) fail(`the band must be between 0 and 1, not ${band}`);
}

function checkBetter(better: string): void {
  if (better !== "higher" && better !== "lower") fail(`better must be higher or lower, not ${better}`);
}

/** A brand's own weight in a blended level: n / (n + 5), so 0.71 at 12 outputs and 0.89 at 40. */
export function ownWeight(n: number): number {
  if (!(n >= 0)) fail(`a weight needs 0 or more outputs, not ${n}`);
  return n / (n + LOOP_RULES.blendM);
}

/** A level blended toward the prior with the weight of 5 outputs: (hits + 5 x prior) / (n + 5). */
export function blend(t: Tally, prior: number): number {
  checkTally(t, "a blended level");
  checkRate(prior, "the prior");
  return (t.hits + LOOP_RULES.blendM * prior) / (t.n + LOOP_RULES.blendM);
}

/** Whether a verdict is read at this many outputs a side. */
export function isLook(n: number): boolean {
  return LOOK_SIZES.includes(n);
}

/** The largest look both sides have reached, or null when either side is below the first look. */
export function lookAt(before: number, after: number): number | null {
  let look: number | null = null;
  for (const n of LOOK_SIZES) if (n <= before && n <= after) look = n;
  return look;
}

/** The look after this one, or null at the last. */
export function nextLook(look: number): number | null {
  return LOOK_SIZES.find((n) => n > look) ?? null;
}

/**
 * The largest look a number can reach on the before outputs known today. Its usable outputs cap
 * every look, and the cap is final once one output since the change is known: outcomes are known
 * in the order outputs were made (see Outputs), so by then the before window is fixed.
 */
function lastLookFor(usableBefore: number): number | null {
  return lookAt(usableBefore, Infinity);
}

/**
 * Wilson's score interval for one rate (Wilson 1927). Unlike the plain normal interval it never
 * has zero width, even at 0 or all hits, and it stays honest below 30 outputs.
 */
export function wilson(t: Tally, z: number = LOOP_RULES.verdictZ): readonly [number, number] {
  checkTally(t, "an interval");
  if (t.n === 0) fail("an interval needs at least one output");
  const { n } = t;
  const p = t.hits / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // At no hits the low end is exactly 0, and at all hits the high end exactly 1; rounding can miss both.
  return [t.hits === 0 ? 0 : Math.max(0, centre - half), t.hits === n ? 1 : Math.min(1, centre + half)];
}

/**
 * Where after minus before could be, by Newcombe's hybrid score method (method 10 in Newcombe
 * 1998): each side's distance to its own Wilson limits, added in quadrature.
 */
export function differenceRange(before: Tally, after: Tally, z: number = LOOP_RULES.verdictZ): readonly [number, number] {
  const [lowA, highA] = wilson(before, z);
  const [lowB, highB] = wilson(after, z);
  const pA = before.hits / before.n;
  const pB = after.hits / after.n;
  const d = pB - pA;
  return [d - Math.hypot(pB - lowB, highA - pA), d + Math.hypot(highB - pB, pA - lowA)];
}

/**
 * One number's change at a look, both sides holding exactly that look's outputs, read against the
 * band in its better direction (Kruschke's three zones):
 * - better when the blended range is wholly past the band the better way;
 * - worse when it is wholly past the band the other way;
 * - same when the raw range sits wholly inside the band;
 * - otherwise too few to tell.
 * It also says whether the raw range sits wholly on the worse side of no change (movedWrongWay).
 * The prior never enters the range, so a prior of 0 or 1 cannot change a call. Throws unless both
 * sides hold the same look of outputs, so nothing can read the change between looks.
 */
export function compare(before: Tally, after: Tally, better: Better, band: number): Comparison {
  checkTally(before, "the before window");
  checkTally(after, "the after window");
  checkBand(band);
  checkBetter(better);
  if (before.n !== after.n) fail(`both windows need the same number of outputs, not ${before.n} and ${after.n}`);
  if (!isLook(before.n)) fail(`${before.n} outputs a side is not a look (${LOOK_SIZES.join(", ")})`);
  const w = ownWeight(before.n);
  const [low, high] = differenceRange(before, after);
  const d = after.hits / after.n - before.hits / before.n;
  // Turned so that positive is better, whichever way the meaning reads.
  const lo = better === "higher" ? low : -high;
  const hi = better === "higher" ? high : -low;
  let call: Call = "too_few";
  if (w * lo > band) call = "better";
  else if (w * hi < -band) call = "worse";
  else if (lo > -band && hi < band) call = "same";
  return { call, change: w * d, range: [w * low, w * high], rawRange: [low, high], movedWrongWay: hi < 0 };
}

/**
 * The smallest change in the better direction that would have read better, given this before
 * window of one look's outputs, in points between the blended levels. Null when even the best
 * possible after window would not read better (at 10 outputs a side that is most before windows),
 * and it throws when before is not a look, as compare does. A change only reads
 * better more easily the further the after count moves, which verdict.test.ts checks for every
 * look and before count, so the search halves the distance instead of stepping one output at a time.
 */
export function smallestVisibleChange(before: Tally, better: Better, band: number): number | null {
  checkTally(before, "the before window");
  checkBetter(better);
  checkBand(band);
  if (!isLook(before.n)) fail(`${before.n} outputs a side is not a look (${LOOK_SIZES.join(", ")})`);
  const step = better === "higher" ? 1 : -1;
  const reads = (k: number) => compare(before, { hits: before.hits + step * k, n: before.n }, better, band).call === "better";
  let high = better === "higher" ? before.n - before.hits : before.hits;
  if (high === 0 || !reads(high)) return null;
  let low = 0;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (reads(mid)) high = mid;
    else low = mid;
  }
  return ownWeight(before.n) * (high / before.n);
}

/** The most uncertain rate within one band of today's, so a rate at 0 or 1 never promises a read today. */
function widestVariance(rate: number, band: number): number {
  const low = Math.max(0, rate - band);
  const high = Math.min(1, rate + band);
  if (low <= 0.5 && high >= 0.5) return 0.25;
  const q = high < 0.5 ? high : low;
  return q * (1 - q);
}

/**
 * Months until the holdback (1 decision in LOOP_RULES.holdbackOneIn held back) holds enough
 * outputs for its smallest detectable change to fall below the band: the usual sample size sum for
 * two shares, with the verdict's own interval and LOOP_RULES.holdbackPowerZ for power. About 5,000
 * divided by the outputs a month at a rate of 0.5 and a band of 0.1. Null when nothing is made.
 * perMonth is this scope's outputs, pooled across every brand in the copy that has not opted out:
 * the holdback is never read for one brand. Counting outputs is right only when each held back
 * decision makes one output; a decision that makes several outputs makes the answer too hopeful.
 * Neither the cap of 20 outputs per organisation per arm nor the floor of LOOP_RULES.cellOrgs
 * organisations is modelled.
 */
export function monthsUntilHoldbackReads({ perMonth, rate, band }: HoldbackPlan): number | null {
  if (!(perMonth >= 0) || !Number.isFinite(perMonth)) fail(`outputs a month must be 0 or more, not ${perMonth}`);
  checkRate(rate, "the rate");
  checkBand(band);
  if (perMonth === 0) return null;
  const h = 1 / LOOP_RULES.holdbackOneIn;
  const z = LOOP_RULES.verdictZ + LOOP_RULES.holdbackPowerZ;
  return (z * z * widestVariance(rate, band) * (1 / h + 1 / (1 - h))) / (perMonth * band * band);
}

/** A meaning a verdict can read: a share of outputs with a direction and a family. */
function readable(key: MeaningKey, role: "check" | "guard"): Required<Pick<Meaning, "better" | "family">> & Meaning {
  const m: Meaning | undefined = Object.prototype.hasOwnProperty.call(MEANINGS, key) ? MEANINGS[key] : undefined;
  if (!m) fail(`the ${role} ${key} is not a key in src/lib/metrics/meanings.ts`);
  if (!m.better || !m.family) fail(`the ${role} ${key} needs better and family in src/lib/metrics/meanings.ts`);
  if (m.unit !== "ratio") fail(`the ${role} ${key} is a ${m.unit}, not a share of outputs`);
  return m as Required<Pick<Meaning, "better" | "family">> & Meaning;
}

/** A number's windows and its read, kept together for the reason line. */
interface Window {
  read: Read;
  before: Tally | null;
  usableBefore: number;
  after: number;
}

/** The outputs from one index up to another, counted. */
function countOf(xs: readonly boolean[], from: number, to: number): Tally {
  let hits = 0;
  for (let i = from; i < to; i++) if (xs[i]) hits++;
  return { hits, n: to - from };
}

/** Reads one number: leaves out the warm up, picks the look, counts the look's outputs either side of the change. */
function readWindow(meaning: MeaningKey, better: Better, outputs: Outputs, prior: number, band: number, startsAt: number): Window {
  const total = outputs.before.length;
  const usable = Math.max(0, total - Math.max(0, LOOP_RULES.warmUp - startsAt));
  const look = lookAt(usable, outputs.after.length);
  const empty = { meaning, look, call: "too_few" as const, counts: null, movedWrongWay: false, before: null, after: null, change: null, range: null, rawRange: null };
  if (look === null) return { read: empty, before: null, usableBefore: usable, after: outputs.after.length };
  const before = countOf(outputs.before, total - look, total);
  const after = countOf(outputs.after, 0, look);
  const c = compare(before, after, better, band);
  const read: Read = {
    meaning,
    look,
    call: c.call,
    counts: { before, after },
    movedWrongWay: c.movedWrongWay,
    before: blend(before, prior),
    after: blend(after, prior),
    change: c.change,
    range: c.range,
    rawRange: c.rawRange,
  };
  return { read, before, usableBefore: usable, after: outputs.after.length };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const points = (x: number) => `${Math.round(x * 100)}`;
const nameOf = (k: MeaningKey) => MEANINGS[k].name.toLowerCase();

/** "went from 5 of 10 to 2 of 10, an estimated 50% to 30%": the real counts first, then the blended levels. */
function went(r: Read): string {
  const { before, after } = r.counts!;
  return `went from ${before.hits} of ${before.n} to ${after.hits} of ${after.n}, an estimated ${pct(r.before!)} to ${pct(r.after!)}`;
}

/** "edit share went from 5 of 10 to 2 of 10, an estimated 50% to 30%" */
const moved = (r: Read) => `${nameOf(r.meaning)} ${went(r)}`;

/** The first look, the fewest outputs a side any number is read at. */
const FIRST_LOOK = LOOK_SIZES[0]!;

/** How much further a guard that has a look can be read. */
interface GuardReach {
  /** Next: it is read again at a larger look. Last: its before window reaches no further. Stop: the windows end here. */
  kind: "next" | "last" | "stop";
  /** The clause on its own, such as "the next look for unused share is at 80 outputs a side". */
  text: string;
}

/**
 * The guard's next look, the last look it can reach, or the end of the windows. Called only for a
 * guard with a look, so it has at least one output since the change and its before window is fixed.
 */
function guardReach(g: Window): GuardReach {
  const name = nameOf(g.read.meaning);
  const gl = g.read.look!;
  const gn = nextLook(gl);
  if (gn === null) return { kind: "stop", text: `the windows stop at ${gl} outputs a side, so this change cannot read better` };
  if (g.usableBefore >= gn) return { kind: "next", text: `the next look for ${name} is at ${gn} outputs a side` };
  return {
    kind: "last",
    text: `${gl} outputs a side is the last look ${name} can reach, since only ${g.usableBefore} of its outputs before the change count, so this change cannot read better`,
  };
}

function reasonFor(call: Call, c: Window, g: Window, band: number, smallest: number | null): string {
  const season = " Not adjusted for season.";
  // Every line that quotes estimated levels says how they are made.
  const estimates = ` Estimates lean toward the default while outputs are few.${season}`;
  const bandText = `the ${points(band)} point band`;
  const guardName = nameOf(g.read.meaning);
  // A guard too few to read whose raw range sits wholly on the worse side of no change: it holds better back.
  const harm = g.read.call === "too_few" && g.read.movedWrongWay;
  // Every line the guard does not decide names a guard that moved the wrong way, with its counts,
  // so the likely harm is never left to the counts alone.
  const guardNote =
    g.read.look !== null && g.read.movedWrongWay
      ? ` ${MEANINGS[g.read.meaning].name} got worse, ${g.read.call === "same" ? "but stayed within the band" : `though not clearly by more than ${bandText}`}: it ${went(g.read)}.`
      : "";
  if (call === "worse" && g.read.call === "worse") {
    const too = c.read.call === "worse" ? `, and so did ${nameOf(c.read.meaning)}: it ${went(c.read)}` : "";
    return `Worse at ${g.read.look} outputs a side: ${moved(g.read)}, past ${bandText} the wrong way${too}.${estimates}`;
  }
  if (call === "worse") return `Worse at ${c.read.look} outputs a side: ${moved(c.read)}, past ${bandText} the wrong way.${guardNote}${estimates}`;
  if (call === "better") {
    const head = `Better at ${c.read.look} outputs a side: ${moved(c.read)}, past ${bandText}`;
    if (g.read.call === "better") return `${head}, and ${guardName} did not get worse.${estimates}`;
    // Same bounds the guard's change inside the band, so it may still have got up to one band worse: quote it.
    if (g.read.call === "same") {
      const stayed = g.read.movedWrongWay ? "got worse, but stayed within the band" : "stayed within the band";
      return `${head}, and ${guardName} ${stayed}: it ${went(g.read)}.${estimates}`;
    }
    return `${head}. ${MEANINGS[g.read.meaning].name} was not shown to get worse, but there are too few outputs to tell: it ${went(g.read)}.${estimates}`;
  }
  if (call === "same") return `Same at ${c.read.look} outputs a side: ${moved(c.read)}, and the whole range the change could be in sits inside ${bandText}.${guardNote}${estimates}`;
  const look = c.read.look;
  if (look === null) {
    // Once one output since the change is known the before list is complete (see Outputs), so too few before it is final.
    const never =
      c.after > 0 && c.usableBefore < FIRST_LOOK ? `; with fewer than ${FIRST_LOOK} before the change it never will, so this change can never read better or same` : "";
    return `Too few to tell: a look needs ${FIRST_LOOK} outputs on each side, and ${nameOf(c.read.meaning)} has ${c.usableBefore} before the change (its first ${LOOP_RULES.warmUp} never count) and ${c.after} since${never}.${guardNote}${guardNote ? estimates : season}`;
  }
  // The guard's usable outputs before the change cap its looks. The cap is final once one of its
  // outputs since the change is known (see Outputs); until then more before it can still join.
  const guardLast = lastLookFor(g.usableBefore);
  const guardFinal = g.after > 0;
  // Better waits until the guard reaches the check's look, or the last look the guard can reach.
  const wait = guardLast === null ? null : Math.min(look, guardLast);
  const guardBehind = wait !== null && (g.read.look === null || g.read.look < wait);
  if (c.read.call === "better") {
    const head = `Too few to tell at ${look} outputs a side: ${moved(c.read)}, past ${bandText}`;
    if (guardLast === null) {
      const rest = guardFinal
        ? `; with fewer than ${FIRST_LOOK} before the change it never will, so this change cannot read better`
        : `, so better waits until it has a look, which needs at least ${FIRST_LOOK} known outputs on each side of the change`;
      return `${head}, but ${guardName} has too few outputs for a look, ${g.usableBefore} before the change and ${g.after} since${rest}.${estimates}`;
    }
    if (g.read.look === null) return `${head}, but ${guardName} has too few outputs for a look, ${g.usableBefore} before the change and ${g.after} since, so better waits until it has at least ${wait} since.${estimates}`;
    if (guardBehind) return `${head}, but ${guardName} has only ${g.after} outputs since the change, so better waits until it has at least ${wait}.${guardNote}${estimates}`;
    // Reached only when the guard has caught up, is too few to read and its raw range sits wholly on the worse side of no change.
    return `${head}, but ${moved(g.read)}, so it got worse, though not clearly by more than the band; ${guardReach(g).text}.${estimates}`;
  }
  // The check has a look, so it has outputs since the change and its before window is fixed: a
  // look larger than its usable outputs never comes.
  const next = nextLook(look);
  const reach = next === null ? "stop" : c.usableBefore >= next ? "next" : "last";
  const atLook =
    reach === "stop"
      ? `; the windows stop at ${look} outputs a side`
      : reach === "next"
        ? `; the next look is at ${next} outputs a side`
        : `, the last look this change can reach, since only ${c.usableBefore} outputs before it count`;
  // The same, standing on its own after a clause about the guard.
  const onItsOwn = reach === "last" ? `; this is the last look this change can reach, since only ${c.usableBefore} outputs before it count` : atLook;
  // A guard that holds better back and can be read no further rules better out for good, even
  // where the check has a next look, so the line says so after naming it.
  let guardEnd = "";
  if (harm && reach === "next") {
    const r = guardReach(g);
    if (r.kind === "last") guardEnd = `, but ${r.text}`;
    else if (r.kind === "stop") guardEnd = `, but ${g.read.look} outputs a side is the last look ${guardName} can reach, where the windows stop, so this change cannot read better`;
  }
  let shown: string;
  let then = atLook;
  let note = guardNote;
  if (guardLast === null) {
    shown = guardFinal
      ? `no change can show as better, since ${guardName} has only ${g.usableBefore} outputs before the change and a look needs ${FIRST_LOOK}`
      : `no change can show as better until ${guardName} has at least ${FIRST_LOOK} known outputs before the change`;
    then = onItsOwn;
  } else if (smallest === null) {
    shown = "no change could have shown as better at this look";
  } else if (harm) {
    shown = `no change could have shown as better at this look while ${guardName} got worse, though not clearly by more than ${bandText}: it ${went(g.read)}`;
    then = onItsOwn;
    note = "";
  } else if (guardBehind) {
    shown = `only an estimated change of ${points(smallest)} points or more could show as better at this look, once ${guardName} has at least ${wait} outputs since the change`;
    then = onItsOwn;
  } else {
    shown = `only an estimated change of ${points(smallest)} points or more could have shown as better at this look`;
  }
  // A check that moved the wrong way says so first, so the likely harm is never left to the counts alone.
  const wrong = c.read.movedWrongWay ? `. It got worse, though not clearly by more than ${bandText}, and` : ", and";
  return `Too few to tell at ${look} outputs a side: ${moved(c.read)}${wrong} ${shown}${then}${guardEnd}.${note}${estimates}`;
}

/**
 * The verdict on a change, for a loop line. Each number reads the largest look both its sides have
 * reached: the look's outputs just before the change against the same number just after it, so
 * between looks it reads the same windows and gives the same answer. In order:
 * - the guard worse (against the band) gives worse;
 * - the check better gives better, once the guard has reached the check's look (or the last look
 *   the guard can reach) and is not a guard too few to read whose raw range sits wholly on the
 *   worse side of no change; until then it is too few to tell. A guard that lags the check, as
 *   unused share does, is read on fewer outputs, so its range is wider and often cannot show harm
 *   that is there. Blending
 *   shrinks the guard's range toward no change, which makes a guard worse harder to read, so the
 *   test on the raw range keeps a guard that probably got worse from letting better through. A
 *   guard that reads same is within the band, so it is not worse and lets better through;
 * - the check worse gives worse, and the check same gives same;
 * - anything else is too few to tell, with the smallest change it could have seen.
 * It never undoes a change. Throws on a band outside 0 to 1, a prior outside 0 to 1, a negative or
 * fractional startsAt, a check or guard that is not a share with better and family, or a guard in
 * the check's family: those are mistakes in the caller, not too few outputs.
 */
export function verdict(input: VerdictInput): Verdict {
  const { line, prior } = input;
  checkBand(line.band);
  const given = input.startsAt ?? 0;
  const startsAt = typeof given === "number" ? { check: given, guard: given } : given;
  for (const role of ["check", "guard"] as const) {
    const at = startsAt[role];
    if (!Number.isInteger(at) || at < 0) fail(`startsAt for the ${role} must be a whole number of outputs, not ${at}`);
  }
  const check = readable(line.check, "check");
  const guard = readable(line.guard, "guard");
  if (check.family === guard.family) fail(`the guard ${line.guard} shares the family ${check.family} with the check ${line.check}`);
  checkRate(prior.check, "the check's prior");
  checkRate(prior.guard, "the guard's prior");

  const c = readWindow(line.check, check.better, input.check, prior.check, line.band, startsAt.check);
  const g = readWindow(line.guard, guard.better, input.guard, prior.guard, line.band, startsAt.guard);
  const byGuard = g.read.call === "worse";
  let call: Call;
  if (byGuard) call = "worse";
  else if (c.read.call === "better") {
    // The guard has caught up once it reaches the check's look, or the last look it can reach.
    const guardLast = lastLookFor(g.usableBefore);
    const caughtUp = g.read.look !== null && guardLast !== null && g.read.look >= Math.min(c.read.look!, guardLast);
    call = !caughtUp || (g.read.movedWrongWay && g.read.call === "too_few") ? "too_few" : "better";
  } else call = c.read.call;
  const smallest = c.before ? smallestVisibleChange(c.before, check.better, line.band) : null;
  return {
    call,
    decidedBy: byGuard ? "guard" : "check",
    look: byGuard ? g.read.look : c.read.look,
    band: line.band,
    check: c.read,
    guard: g.read,
    smallestVisible: smallest,
    notAdjustedForSeason: true,
    reason: reasonFor(call, c, g, line.band, smallest),
  };
}
